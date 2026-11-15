// The Architect tool group (spec §16.1). Registered only when the Architect flag is on, and
// always through upstream's registrar, so the tool-surface policy and compact `call_tool`
// cover it like any other tool (spec §14.3).
//
// Milestone 2: `architect_inspect` (environment, capabilities) and `architect_plan`
// (prepare, propose, get, validate, select, export). Neither downloads, installs, renders
// or touches the canvas. Descriptions are prompt text for models: English, exact, and not
// translated (STYLE, MCP tools).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ARCHITECT_SCHEMA_VERSION } from "../fork-identity.js";
import { architectEnabled } from "../services/architect/config.js";
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
      : { code: "OUTCOME_UNKNOWN", retryable: false, nextStep: "Report this error; the request may or may not have been recorded." },
  };
}

/** Builds the planning service on first use, so registering the tools never opens architect.db. */
export type PlanningFactory = () => ArchitectPlanning;

function defaultPlanningFactory(service: ArchitectService, upstream: UpstreamFacade): PlanningFactory {
  let planning: ArchitectPlanning | undefined;
  return () => {
    planning ??= new ArchitectPlanning({
      store: ArchitectStore.open(),
      service,
      upstream,
      dataDir: architectDataDir(),
      sources: [SHIPPED_SOURCE],
      now: () => new Date(),
      newId: () => randomUUID(),
      isPaidNode: (def) => upstream.isPaidNode(def),
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

export function registerArchitectTools(
  server: McpServer,
  service: ArchitectService = new ArchitectService(defaultDeps(createUpstreamFacade())),
  planningFactory?: PlanningFactory,
): void {
  const planning = planningFactory ?? defaultPlanningFactory(service, createUpstreamFacade());

  server.tool(
    "architect_inspect",
    "ComfyUI Architect: read-only inspection of the connected ComfyUI target. " +
      'action:"environment" returns a snapshot: ComfyUI and Python versions, OS, RAM, ' +
      "compute devices with their memory, the loaded node classes (count and digest) and the " +
      "installed model files by folder. A probe that fails is listed in `probeErrors` and its " +
      "fields are absent; an unanswered folder is listed in `unanswered`: treat both as " +
      'unknown, never as empty. action:"capabilities" lists the recipe catalog: each recipe\'s ' +
      "operations, evidence tier and model slots, and how many of those slots the target's " +
      "installed files could fill. No downloads, installs or executions.",
    {
      action: z
        .enum(["environment", "capabilities"])
        .describe('"environment": the target\'s versions, hardware, node classes and model files. "capabilities": the recipe catalog and its fit.'),
    },
    async ({ action }) => {
      if (action === "environment") return reply(await service.inspectEnvironmentEnvelope());
      try {
        const caps = await planning().capabilities();
        const warnings = [
          ...caps.catalog.errors.map((e) => `recipe file ${e.file}: ${e.message}`),
          ...caps.catalog.missingSources.map((s) => `recipe source ${s} not found: its recipes are unknown`),
        ];
        return reply(okEnvelope(`${caps.recipes.length} recipe(s) in the catalog; environment ${caps.environmentId}.`, caps, warnings));
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
      'candidate and authorizes nothing; action:"export" with `planId` writes the selected ' +
      "candidate's graph, task, plan, validation and dependency lock to files. Every check is " +
      "pass, fail, unknown or not_applicable: unknown is not pass. Don't invent node names, " +
      "model files, URLs or measurements; report blockers instead.",
    {
      action: z.enum(["prepare", "propose", "get", "validate", "select", "export"]).describe("The planning step; see the tool description for each one's fields."),
      task: TaskSpecInput.optional().describe("prepare: the task. `media` holds the kind-specific part: kind, operation and output shape."),
      taskId: z.string().optional().describe("prepare: an existing task to revise."),
      planId: z.string().optional().describe("propose, get, validate, select, export: the plan."),
      candidateId: z.string().optional().describe("validate, select: a candidate of the plan."),
      proposals: z.array(Proposal).max(24).optional().describe("propose: bindings you choose for recipes' slots."),
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
            ];
            return reply(okEnvelope(`Task ${r.task.id} r${r.task.revision}, plan ${r.plan.id} (${r.plan.state}); ${r.recipes.length} fitting recipe(s).`, r, warnings));
          }
          case "propose": {
            const r = await p.propose({ planId: need(args.planId, "planId", "propose"), ...(args.proposals ? { proposals: args.proposals } : {}) });
            const feasible = r.candidates.filter((c) => c.status === "feasible").length;
            const warnings = [
              ...r.readiness.reasons.map((x) => `environment: ${x}`),
              ...(r.truncated ? [`enumeration stopped at ${r.expanded} candidates`] : []),
            ];
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
            const r = p.export({ planId: need(args.planId, "planId", "export") });
            return reply(okEnvelope(`Exported ${r.files.length} files to ${r.dir}.`, r, [], r.files));
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
      description: "Plan a ComfyUI workflow for a task from installed models and curated recipes, without downloads or renders.",
      argsSchema: { task: z.string().describe("What to make, in the user's words.") },
    },
    ({ task }) => ({
      messages: [
        { role: "user" as const, content: { type: "text" as const, text: `${command.replace("$ARGUMENTS", task)}\n\n---\n\n${skill}` } },
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
