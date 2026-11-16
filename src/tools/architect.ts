// The Architect tool group (spec §16.1). Registered only when the Architect flag is on, and
// always through upstream's registrar, so the tool-surface policy and compact `call_tool`
// cover it like any other tool (spec §14.3).
//
// `architect_inspect` (environment, capabilities) and `architect_plan` (prepare, propose,
// get, validate, select, export) read and plan; `architect_run` (architect-run.ts) renders a
// selected candidate under the user's approval, after downloading the pinned model files
// the user approved with it (TODO 4.5). None installs nodes or touches the canvas.
// Descriptions are prompt text for models: English, exact, and not translated (STYLE, MCP
// tools).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ARCHITECT_SCHEMA_VERSION } from "../fork-identity.js";
import { ModelAcquirer, defaultAcquisitionIo } from "../services/architect/acquisition.js";
import { formatBytes } from "../services/architect/acquisition-policy.js";
import { requireFeasible, requireInputsUnchanged } from "../services/architect/admission.js";
import { ARCHITECT_RESIDENCY_ENV, architectEnabled } from "../services/architect/config.js";
import { RunController } from "../services/architect/controller.js";
import { ArchitectExecution } from "../services/architect/execution.js";
import { FamilyObserver, loadFamilyRules } from "../services/architect/families.js";
import { ensureBuiltInSources } from "../services/architect/sources.js";
import { ResourceCoordinator } from "../services/architect/resources.js";
import { registerArchitectRunTool, type RunToolContext } from "./architect-run.js";
import { ArchitectPlanning, PlanningError, SHIPPED_SOURCE } from "../services/architect/planning.js";
import { TaskSpecInput, type ResultEnvelope } from "../services/architect/schemas.js";
import { ArchitectService, defaultDeps } from "../services/architect/service.js";
import { ArchitectStore, architectDataDir } from "../services/architect/store.js";
import { createUpstreamFacade, type UpstreamFacade } from "../services/architect/upstream.js";

/** The category the compact surface lists Architect tools under. */
export const ARCHITECT_CATEGORY = "architect";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function reply(envelope: ResultEnvelope): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
    ...(envelope.status === "error" ? { isError: true } : {}),
  };
}

function okEnvelope(summary: string, data: Record<string, unknown>, warnings: string[] = [], artifacts: string[] = []): ResultEnvelope {
  return { schemaVersion: ARCHITECT_SCHEMA_VERSION, operationId: `op-${randomUUID()}`, status: warnings.length > 0 ? "partial" : "ok", summary, data, warnings, artifacts };
}

function errorEnvelope(err: unknown): ResultEnvelope {
  const known = err instanceof PlanningError;
  return {
    schemaVersion: ARCHITECT_SCHEMA_VERSION,
    operationId: `op-${randomUUID()}`,
    status: "error",
    summary: err instanceof Error ? err.message : String(err),
    data: {},
    warnings: [],
    artifacts: [],
    error: known
      ? { code: err.code, retryable: err.retryable, nextStep: err.nextStep }
      : // Not OUTCOME_UNKNOWN: spec §15.4 keeps that for a submission whose result was lost,
        // which a reconcile loop acts on. Planning submits nothing.
        { code: "INTERNAL_ERROR", retryable: false, nextStep: "Report this error; the request may or may not have been recorded." },
  };
}

/** Builds the planning service on first use, so registering the tools never opens architect.db. */
export type PlanningFactory = () => ArchitectPlanning;

function defaultPlanningFactory(service: ArchitectService, upstream: UpstreamFacade): PlanningFactory {
  let planning: ArchitectPlanning | undefined;
  return () => {
    if (planning) return planning;
    const store = ArchitectStore.open();
    const now = () => new Date();
    // The built-in sources are written when the store opens (GAPS Q32); a failure is
    // reported by capabilities, which writes them again.
    ensureBuiltInSources(store, upstream.comfyuiBaseUrl());
    const loaded = loadFamilyRules();
    planning = new ArchitectPlanning({
      store,
      service,
      upstream,
      dataDir: architectDataDir(),
      sources: [SHIPPED_SOURCE],
      now,
      newId: () => randomUUID(),
      isPaidNode: (def) => upstream.isPaidNode(def),
      families: new FamilyObserver({
        store,
        locate: (folder, file) => upstream.locateModelFile(folder, file),
        rootsKey: () => upstream.modelRootsKey(),
        rules: loaded.rules,
        now,
      }),
      // Input sizes for recipes whose output follows an input image (ARCH 2026-11-16, output size).
      inputFiles: upstream,
      familyRuleErrors: [
        ...loaded.errors.map((e) => `family rule file ${e.file}: ${e.message}`),
        ...(loaded.dirFound ? [] : ["the family rules folder architect/families/ wasn't found: model families stay unverified"]),
      ],
    });
    return planning;
  };
}

const Proposal = z
  .object({
    recipeId: z.string().describe("A recipe ID from prepare's `recipes`."),
    bindings: z
      .record(z.string(), z.union([z.string(), z.number()]))
      .describe("Slot ID to value. Model files must be ones architect_inspect listed for the slot's folder."),
  })
  .strict();

function need<T>(value: T | undefined, name: string, action: string): T {
  if (value === undefined) throw new PlanningError("MISSING_INPUT", `action "${action}" needs \`${name}\``, `Call architect_plan again with ${name}.`);
  return value;
}

/**
 * The execution side over the same planning instance and store (TODO 3.9). Built at the
 * first `architect_run` call; it then reconciles runs left unfinished by an earlier process
 * and polls active runs, so a run's progress doesn't depend on the agent asking (spec §11.3:
 * the controller needs no LLM to follow a render).
 */
// One per process: the direct registration and upstream's compact catalog each register the
// tools, and two controllers would poll the same runs.
let processRunContext: RunToolContext | undefined;

function defaultRunContext(planning: PlanningFactory, upstream: UpstreamFacade): () => RunToolContext {
  return () => {
    if (processRunContext) return processRunContext;
    let ctx: RunToolContext;
    const p = planning();
    const store = p.store;
    const now = () => new Date();
    const newId = () => randomUUID();
    const resources = new ResourceCoordinator({
      store,
      upstream,
      ownerId: `server-${process.pid}-${randomUUID()}`,
      now,
      manageResidency: process.env[ARCHITECT_RESIDENCY_ENV] === "1",
    });
    const acquisitionIo = defaultAcquisitionIo(upstream);
    const acquirer = new ModelAcquirer({ store, io: acquisitionIo, now, newId });
    const controller = new RunController({
      store,
      upstream,
      resources,
      now,
      newUuid: () => randomUUID(),
      graphFor: async (run) => {
        const task = store.getTask(run.taskId, run.taskRevision);
        if (!task) throw new PlanningError("GRAPH_CONFLICT", `task ${run.taskId} r${run.taskRevision} is not stored`, "Prepare a new run.");
        return p.graphOfCandidate(run.candidateId, task).graph;
      },
      taskFor: (run) => {
        const task = store.getTask(run.taskId, run.taskRevision);
        if (!task) throw new PlanningError("GRAPH_CONFLICT", `task ${run.taskId} r${run.taskRevision} is not stored`, "Prepare a new run.");
        return task;
      },
      // A run that waited for its resources, or acquired model files, is validated again
      // against a fresh snapshot before it's submitted, and its input files are read again:
      // one changed since start invalidates the approval (GAPS Q33).
      revalidate: async (run) => {
        // The inputs first: the validation's size check decodes the bytes just compared.
        const bytes = await requireInputsUnchanged({ store, readInputFile: (name) => upstream.readInputFile(name) }, run);
        await requireFeasible(p, run.planId, run.candidateId, bytes);
      },
      acquirer,
    });
    const execution = new ArchitectExecution({
      store,
      planning: p,
      baseUrl: () => upstream.comfyuiBaseUrl(),
      now,
      newId,
      driver: controller,
      dataDir: architectDataDir(),
      dependencyLock: (candidateId, task) => p.dependencyLock(candidateId, task),
      // What a render would unload, read at prepare so the approval names it (GAPS Q23).
      releasable: (baseUrl) => resources.releasable(baseUrl),
      acquisitionIo,
      acquirer,
      // The task's input images, read from the target's input folder and hashed into the plan (GAPS Q33).
      readInputFile: (name) => upstream.readInputFile(name),
    });
    ctx = { execution, store, now, newId };
    processRunContext = ctx;
    void controller.resumeAll().catch(() => undefined);
    controller.startPolling();
    return ctx;
  };
}

export function registerArchitectTools(
  server: McpServer,
  service: ArchitectService = new ArchitectService(defaultDeps(createUpstreamFacade())),
  planningFactory?: PlanningFactory,
  runContext?: () => RunToolContext,
): void {
  const upstream = createUpstreamFacade();
  const planning = planningFactory ?? defaultPlanningFactory(service, upstream);
  const context = runContext ?? defaultRunContext(planning, upstream);
  registerArchitectRunTool(server, context);
  if (!runContext) {
    // Build the run context at start rather than at the first architect_run call, so runs
    // left unfinished by an earlier process are reconciled and their leases kept without
    // waiting for the agent (spec §15.3: the browser connection isn't the job's source of
    // truth). A failure here (an unusable data directory) is reported by the first call.
    setImmediate(() => {
      try {
        context();
      } catch {
        // The first architect_* call reports it with its own error envelope.
      }
    }).unref();
  }

  server.tool(
    "architect_inspect",
    "ComfyUI Architect: read-only inspection of the connected ComfyUI target. " +
      'action:"environment" returns a snapshot: ComfyUI and Python versions, OS, RAM, ' +
      "compute devices with their memory, the loaded node classes (count and digest) and the " +
      "installed model files by folder. A probe that fails is listed in `probeErrors` and its " +
      "fields are absent; an unanswered folder is listed in `unanswered`: treat both as " +
      'unknown, never as empty. action:"capabilities" lists the recipe catalog: each recipe\'s ' +
      "operations, evidence tier and model slots, and how many of those slots the target's " +
      "installed files could fill; and the source registry: each source's adapter, root, " +
      "allowed operations, trust and state (unavailable is not empty). No downloads, installs " +
      "or executions.",
    {
      action: z
        .enum(["environment", "capabilities"])
        .describe('"environment": the target\'s versions, hardware, node classes and model files. "capabilities": the recipe catalog and its fit, and the source registry.'),
    },
    async ({ action }) => {
      if (action === "environment") return reply(await service.inspectEnvironmentEnvelope());
      try {
        const caps = await planning().capabilities();
        const warnings = [
          ...caps.catalog.errors.map((e) => `recipe file ${e.file}: ${e.message}`),
          ...caps.catalog.missingSources.map((s) => `recipe source ${s} not found: its recipes are unknown`),
          ...caps.sourceErrors,
          ...caps.sources.filter((s) => s.state === "unavailable").map((s) => `source ${s.id} is unavailable: ${s.unavailableReason ?? "no reason recorded"}; its contents are unknown, not empty`),
        ];
        return reply(
          okEnvelope(`${caps.recipes.length} recipe(s) in the catalog, ${caps.sources.length} source(s); environment ${caps.environmentId}.`, caps, warnings),
        );
      } catch (err) {
        return reply(errorEnvelope(err));
      }
    },
  );

  server.tool(
    "architect_plan",
    "ComfyUI Architect: plan a workflow for a task from curated recipes and installed models, " +
      "with layered validation, and export the chosen graph. Persists planning records; never " +
      "downloads, installs, renders or changes the canvas. Call order: " +
      'action:"prepare" with `task` (and `taskId` to revise one) stores the task, takes a ' +
      "snapshot and returns the fitting recipes and any missing fields; " +
      'action:"propose" with `planId` builds, validates and ranks up to 3 candidates (optional ' +
      "`proposals` bind a recipe's slots yourself; model files must be ones the target lists); " +
      'action:"get" with `planId` (and `graphOf`: a candidate ID, for its API graph) reads a plan; ' +
      'action:"validate" with `planId` and `candidateId` re-checks against a fresh snapshot; ' +
      'action:"select" with `planId` and `candidateId` records the user\'s choice of a feasible ' +
      "or acquirable candidate and authorizes nothing (acquirable: only model files with a pinned " +
      "source are missing; architect_run downloads them once the user approves); " +
      'action:"export" with `planId` writes the selected ' +
      "candidate's API graph, task, plan, validation and dependency lock to files, and its UI " +
      "graph (workflow.ui.json) when that loads back to the same API graph. Every check is " +
      "pass, fail, unknown or not_applicable: unknown is not pass. Don't invent node names, " +
      "model files, URLs or measurements; report blockers instead.",
    {
      action: z.enum(["prepare", "propose", "get", "validate", "select", "export"]).describe("The planning step; see the tool description for each one's fields."),
      task: TaskSpecInput.optional().describe("prepare: the task. `media` holds the kind-specific part: kind, operation and output shape."),
      taskId: z.string().optional().describe("prepare: an existing task to revise."),
      planId: z.string().optional().describe("propose, get, validate, select, export: the plan."),
      candidateId: z.string().optional().describe("validate, select: a candidate of the plan."),
      proposals: z.array(Proposal).max(24).optional().describe("propose: bindings you choose for recipes' slots."),
      recipeIds: z
        .array(z.string())
        .max(8)
        .optional()
        .describe("propose: build candidates only from these recipes (IDs from prepare's `recipes`), e.g. when the user asks for one."),
      graphOf: z.string().optional().describe("get: a candidate ID whose compiled API graph to include."),
    },
    async (args) => {
      try {
        const p = planning();
        switch (args.action) {
          case "prepare": {
            const r = await p.prepare({ task: need(args.task, "task", "prepare"), ...(args.taskId ? { taskId: args.taskId } : {}) });
            const warnings = [
              ...r.missingFields.map((m) => `missing: ${m}`),
              ...r.environment.readiness.reasons.map((x) => `environment: ${x}`),
              ...(r.recipes.length === 0 ? [`no recipe in the catalog solves ${r.task.media.kind}/${r.task.media.operation}`] : []),
              ...p.catalogWarnings(),
            ];
            return reply(okEnvelope(`Task ${r.task.id} r${r.task.revision}, plan ${r.plan.id} (${r.plan.state}); ${r.recipes.length} fitting recipe(s).`, r, warnings));
          }
          case "propose": {
            const r = await p.propose({
              planId: need(args.planId, "planId", "propose"),
              ...(args.proposals ? { proposals: args.proposals } : {}),
              ...(args.recipeIds ? { recipeIds: args.recipeIds } : {}),
            });
            const feasible = r.candidates.filter((c) => c.status === "feasible").length;
            const acquirable = r.candidates.filter((c) => c.status === "acquirable");
            const warnings = [
              ...r.readiness.reasons.map((x) => `environment: ${x}`),
              ...(r.truncated ? [`enumeration stopped at ${r.expanded} candidates`] : []),
              ...(r.familiesUnobserved ?? []).map((u) => `model family of ${u.folder}/${u.file} not read: ${u.reason}`),
              ...p.catalogWarnings(),
            ];
            if (feasible === 0 && acquirable.length > 0) {
              // Not a dead end: the user can approve the downloads (TODO 4.5). Say what they are.
              const what = acquirable
                .map((c) => `${c.id} (${c.recipe}): ${(c.acquisition?.files ?? []).map((f) => `${f.folder}/${f.file} ${f.size}`).join(", ")}, ${formatBytes(c.acquisition?.totalBytes ?? 0)} in total`)
                .join("; ");
              return reply({
                ...okEnvelope(
                  `No feasible candidate for plan ${r.plan?.id}; ${acquirable.length} acquirable after downloading pinned model files: ${what}. ` +
                    "Show the user the files and sizes; if they choose one, select it and prepare a run, which asks them to approve the downloads.",
                  r,
                  warnings,
                ),
                status: "partial",
              });
            }
            if (r.candidates.length === 0 || feasible === 0) {
              return reply({
                ...okEnvelope(`No feasible candidate for plan ${r.plan?.id}; ${r.candidates.length} blocked or diagnostic. See blockers.`, r, warnings),
                status: r.candidates.length === 0 ? "error" : "partial",
                ...(r.candidates.length === 0
                  ? { error: { code: "NO_FEASIBLE_CANDIDATE" as const, retryable: false, nextStep: "Report the blockers to the user; never relax a requirement without their approval." } }
                  : {}),
              });
            }
            return reply(okEnvelope(`${r.candidates.length} candidate(s), ${feasible} feasible, from ${r.expanded} built.`, r, warnings));
          }
          case "get": {
            const r = p.get({ planId: need(args.planId, "planId", "get"), ...(args.graphOf ? { graphOf: args.graphOf } : {}) });
            return reply(okEnvelope(`Plan ${r.plan.id} (${r.plan.state}), ${r.candidates.length} candidate(s).`, r));
          }
          case "validate": {
            const r = await p.validate({ planId: need(args.planId, "planId", "validate"), candidateId: need(args.candidateId, "candidateId", "validate") });
            return reply(okEnvelope(`Candidate ${r.candidate.id} is ${r.candidate.status} (was ${r.previous}).`, r));
          }
          case "select": {
            const r = p.select({ planId: need(args.planId, "planId", "select"), candidateId: need(args.candidateId, "candidateId", "select") });
            return reply(okEnvelope(`Plan ${r.id}: candidate ${r.selectedCandidateId} selected. Nothing was run.`, { plan: r }));
          }
          case "export": {
            const r = await p.export({ planId: need(args.planId, "planId", "export") });
            const warnings = r.uiGraph.exported ? [] : [`workflow.ui.json not written: ${r.uiGraph.reason}`];
            return reply(okEnvelope(`Exported ${r.files.length} files to ${r.dir}.`, r, warnings, r.files));
          }
        }
      } catch (err) {
        return reply(errorEnvelope(err));
      }
    },
  );
}

/**
 * The seam in upstream's registration (src/tools/index.ts): registers the group when the
 * flag is on and does nothing otherwise, so Architect off leaves upstream's surface as it
 * is (spec AT-12).
 */
export function registerArchitectToolGroup(server: McpServer, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!architectEnabled(env)) return false;
  registerArchitectTools(server);
  return true;
}

/** The skill and command texts, shipped in `architect/` at the package root (TODO 2.7). */
const ARCHITECT_TEXT_DIR = fileURLToPath(new URL("../../architect/", import.meta.url));

/** A markdown file without its YAML front matter, or undefined when it can't be read. */
function readMarkdownBody(relPath: string): string | undefined {
  try {
    const text = readFileSync(join(ARCHITECT_TEXT_DIR, relPath), "utf-8");
    return text.replace(/^---\n[\s\S]*?\n---\n+/, "");
  } catch {
    return undefined;
  }
}

/**
 * MCP prompts for the skill and the `/architect` command (TODO 2.7), only while the flag is
 * on. Files in `plugin/` would be visible with the flag off and change upstream's README
 * counts (spec AT-12), so the texts reach clients this way until Architect is on by
 * default. Returns whether any prompt was registered: upstream's boot installs its empty
 * prompts/list handler only when none was, because the SDK allows one handler per method.
 */
export function registerArchitectPrompts(server: McpServer, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!architectEnabled(env)) return false;
  const skill = readMarkdownBody("skills/comfyui-architect/SKILL.md");
  const command = readMarkdownBody("commands/architect.md");
  if (skill === undefined || command === undefined) return false;
  server.registerPrompt(
    "architect",
    {
      title: "Plan a workflow with ComfyUI Architect",
      description:
        "Plan a ComfyUI workflow for a task from installed models and curated recipes, and render it once you approve; pinned model downloads only with your approval, no node installs.",
      argsSchema: { task: z.string().describe("What to make, in the user's words.") },
    },
    ({ task }) => ({
      messages: [
        { role: "user" as const, content: { type: "text" as const, text: `${command.replace("$ARGUMENTS", () => task)}\n\n---\n\n${skill}` } },
      ],
    }),
  );
  server.registerPrompt(
    "architect_skill",
    {
      title: "ComfyUI Architect: how to plan",
      description: "The planning guide for the architect_* tools: call order, what an agent may supply, how to read verdicts and blockers.",
    },
    () => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: skill } }] }),
  );
  return true;
}
