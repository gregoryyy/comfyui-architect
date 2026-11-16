// The planning workflow behind `architect_plan` (spec §16.1, §16.3; TODO 2.5, 2.6.3):
// prepare, propose, get, validate, select and export, over the store, the catalog, the
// environment snapshot and the planner.
//
// Effects are limited to Architect's own records and files: it writes `architect.db` and,
// on export, files under `ARCHITECT_DATA_DIR/artifacts/`. Nothing here downloads, installs,
// submits a prompt or touches the canvas (milestone 2's exit, spec §20).

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { ComfyUINodeDef, ObjectInfo } from "../../comfyui/types.js";
import { FORK_IDENTITY, UPSTREAM_BASELINE } from "../../fork-identity.js";
import { loadRecipeDir, retrieveRecipes, SHIPPED_RECIPES_DIR } from "./catalog.js";
import { compileRecipe } from "./compile.js";
import { planningReadiness } from "./environment.js";
import { canonicalJson, sha256Hex } from "./hash.js";
import { deriveAcquisition, formatBytes } from "./acquisition-policy.js";
import { MAX_PRESENTED_CANDIDATES, candidateStatus, missingTaskFields, planCandidates, type ProposedBinding } from "./planner.js";
import {
  type ApiGraph,
  type EnvironmentSnapshot,
  type Plan,
  type PlanCandidate,
  type Recipe,
  type TaskSpec,
  TaskSpecInput,
  type ValidationReport,
} from "./schemas.js";
import type { ArchitectService } from "./service.js";
import type { ArchitectStore } from "./store.js";
import type { UpstreamFacade } from "./upstream.js";
import { overallVerdict, validateGraph } from "./validate.js";

/** A recipe source the catalog loads: the shipped folder, and in tests a fixture folder. */
export interface RecipeSource {
  id: string;
  kind: "bundled" | "local" | "fixture";
  dir: string;
  trust: "maintainer" | "user" | "test";
}

export const SHIPPED_SOURCE: RecipeSource = { id: "source-shipped", kind: "bundled", dir: SHIPPED_RECIPES_DIR, trust: "maintainer" };

export interface PlanningDeps {
  store: ArchitectStore;
  service: ArchitectService;
  upstream: Pick<UpstreamFacade, "comfyuiBaseUrl" | "objectInfo">;
  dataDir: string;
  sources: readonly RecipeSource[];
  now: () => Date;
  newId: () => string;
  /** Upstream's paid-node rule when available; the validator's own otherwise. */
  isPaidNode?: (def: ComfyUINodeDef) => boolean;
}

/** A refusal with a stable code (spec §16.4), for the tool to put into the envelope. */
export class PlanningError extends Error {
  constructor(
    readonly code: "MISSING_INPUT" | "NO_FEASIBLE_CANDIDATE" | "UNVERIFIED_COMPATIBILITY" | "STALE_ENVIRONMENT" | "GRAPH_CONFLICT",
    message: string,
    readonly nextStep: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "PlanningError";
  }
}

export interface CatalogSyncResult {
  loaded: number;
  errors: { source: string; file: string; message: string }[];
  /** Sources whose folder didn't exist: their recipes are unknown, not none. */
  missingSources: string[];
}

function emptyBlockers(): Plan["blockers"] {
  return { missing_dependencies: [], unsupported_operation: [], insufficient_evidence: [], resource_limits: [], policy_conflicts: [] };
}

export class ArchitectPlanning {
  private synced: CatalogSyncResult | undefined;
  /**
   * The recipes the last sync loaded and stored, as they are in their files now. Planning
   * uses these, never the store's whole history: a recipe whose file was deleted, became
   * invalid or changed without a revision bump stays in architect.db for the plans that
   * name it, but isn't planned with again (TODO 2.4.1).
   */
  private current: Recipe[] = [];

  constructor(private readonly deps: PlanningDeps) {}

  /** The store planning writes to; execution shares it, so both see one database connection. */
  get store(): ArchitectStore {
    return this.deps.store;
  }

  /** Load every recipe source into the store. Runs once per instance unless forced. */
  syncCatalog(force = false): CatalogSyncResult {
    if (this.synced && !force) return this.synced;
    const { store, sources, now } = this.deps;
    const result: CatalogSyncResult = { loaded: 0, errors: [], missingSources: [] };
    const current: Recipe[] = [];
    for (const src of sources) {
      const loaded = loadRecipeDir(src.dir);
      if (!loaded.dirFound) {
        result.missingSources.push(src.id);
        continue;
      }
      store.upsertCatalogSource({ id: src.id, kind: src.kind, root: src.dir, trust: src.trust, lastRefreshAt: now().toISOString() });
      for (const e of loaded.errors) result.errors.push({ source: src.id, ...e });
      for (const r of loaded.recipes) {
        try {
          store.putRecipe(r.recipe, src.id, r.contentHash);
          current.push(r.recipe);
          result.loaded += 1;
        } catch (err) {
          result.errors.push({ source: src.id, file: r.file, message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    this.synced = result;
    this.current = current;
    return result;
  }

  private recipes(kind?: Recipe["kind"]): Recipe[] {
    this.syncCatalog();
    return this.current.filter((r) => kind === undefined || r.kind === kind);
  }

  /** What went wrong loading the catalog, as warnings each planning step carries (TODO 2.4.1). */
  catalogWarnings(): string[] {
    const sync = this.syncCatalog();
    return [
      ...sync.errors.map((e) => `recipe file ${e.file}: ${e.message}`),
      ...sync.missingSources.map((src) => `recipe source ${src} not found: its recipes are unknown`),
    ];
  }

  /** A snapshot fit for planning: the given one if still usable, else a new one, stored. */
  async environment(current?: EnvironmentSnapshot): Promise<{ snapshot: EnvironmentSnapshot; readiness: { usable: boolean; reasons: string[] } }> {
    const { store, service, upstream, now } = this.deps;
    const baseUrl = upstream.comfyuiBaseUrl();
    if (current) {
      const readiness = planningReadiness(current, now(), baseUrl);
      if (readiness.usable) return { snapshot: current, readiness };
    }
    const snapshot = store.putSnapshot(await service.inspectEnvironment());
    return { snapshot, readiness: planningReadiness(snapshot, now(), baseUrl) };
  }

  /** The catalog's recipes and whether the target could fill their model slots (`architect_inspect capabilities`). */
  async capabilities() {
    const sync = this.syncCatalog();
    const { snapshot } = await this.environment(this.deps.store.latestSnapshot(this.deps.upstream.comfyuiBaseUrl()));
    const recipes = this.recipes().map((r) => {
      const [fit] = retrieveRecipes([r], { media: { kind: "image", operation: r.operations[0] as TaskSpec["media"]["operation"], output: { width: 1, height: 1, count: 1, format: "png" } } }, snapshot, 1);
      return {
        id: r.id,
        revision: r.revision,
        title: r.title,
        kind: r.kind,
        operations: r.operations,
        certification: r.certification,
        modelSlots: r.slots.filter((s) => s.valueType === "model_file").map((s) => ({ slot: s.id, folder: s.modelFolder, family: s.modelFamily })),
        installedFit: fit ? { ...fit.installedOverlap, unknownFolders: fit.unknownFolders } : undefined,
      };
    });
    return { environmentId: snapshot.id, recipes, catalog: sync };
  }

  /** Store a task (a new one, or the next revision of `taskId`) and start a plan for it. */
  async prepare(request: { task: unknown; taskId?: string }) {
    const { store, now, newId } = this.deps;
    const parsed = TaskSpecInput.safeParse(request.task);
    if (!parsed.success) {
      throw new PlanningError(
        "MISSING_INPUT",
        `the task isn't a valid TaskSpec: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
        "Fix the named fields and call prepare again.",
      );
    }
    const stamp = now().toISOString();
    const previous = request.taskId ? store.getTask(request.taskId) : undefined;
    if (request.taskId && !previous) {
      throw new PlanningError("MISSING_INPUT", `no task ${request.taskId}`, "Omit taskId to start a new task.");
    }
    const task = store.putTaskRevision({
      ...parsed.data,
      schemaVersion: 1,
      id: previous?.id ?? `task-${newId()}`,
      revision: (previous?.revision ?? 0) + 1,
      createdAt: previous?.createdAt ?? stamp,
      updatedAt: stamp,
    });
    const { snapshot, readiness } = await this.environment();
    const missing = missingTaskFields(task);
    const recipes = retrieveRecipes(this.recipes(task.media.kind), task, snapshot);
    const plan = store.putPlan({
      schemaVersion: 1,
      id: `plan-${newId()}`,
      taskId: task.id,
      taskRevision: task.revision,
      environmentId: snapshot.id,
      state: missing.length > 0 ? "NEEDS_INPUT" : "DRAFT",
      candidateIds: [],
      blockers: emptyBlockers(),
      createdAt: stamp,
      updatedAt: stamp,
    });
    return {
      task,
      plan,
      environment: { id: snapshot.id, capturedAt: snapshot.capturedAt, readiness, probeErrors: snapshot.probeErrors },
      missingFields: missing,
      recipes: recipes.map((r) => ({
        id: r.recipe.id,
        revision: r.recipe.revision,
        title: r.recipe.title,
        certification: r.recipe.certification,
        installedFit: r.installedOverlap,
        unknownFolders: r.unknownFolders,
        slots: r.recipe.slots.map((s) => ({ id: s.id, valueType: s.valueType, required: s.required, ...(s.fromTask ? { fromTask: s.fromTask } : {}), ...(s.modelFolder ? { modelFolder: s.modelFolder } : {}) })),
      })),
    };
  }

  private requirePlan(planId: string): { plan: Plan; task: TaskSpec } {
    const plan = this.deps.store.getPlan(planId);
    if (!plan) throw new PlanningError("MISSING_INPUT", `no plan ${planId}`, "Call prepare to start a plan.");
    const task = this.deps.store.getTask(plan.taskId, plan.taskRevision);
    if (!task) throw new PlanningError("MISSING_INPUT", `plan ${planId} names task ${plan.taskId} r${plan.taskRevision}, which isn't stored`, "Call prepare again.");
    return { plan, task };
  }

  private async objectInfo(): Promise<ObjectInfo | undefined> {
    try {
      return await this.deps.upstream.objectInfo();
    } catch {
      // Unknown, not empty (#796): the validator turns every schema check into a hard unknown.
      return undefined;
    }
  }

  /** Build, validate and rank candidates for a prepared plan (spec §9.2). */
  async propose(request: { planId: string; proposals?: ProposedBinding[] }) {
    const { store, now, newId } = this.deps;
    const { plan, task } = this.requirePlan(request.planId);
    if (plan.state === "NEEDS_INPUT") {
      throw new PlanningError("MISSING_INPUT", `the task still lacks: ${missingTaskFields(task).join("; ")}`, "Call prepare with the missing fields as a new revision (taskId).");
    }
    if (plan.state === "SELECTED" || plan.state === "SUPERSEDED") {
      throw new PlanningError("GRAPH_CONFLICT", `plan ${plan.id} is ${plan.state}`, "Call prepare for a new plan.");
    }
    const { snapshot, readiness } = await this.environment(store.getSnapshot(plan.environmentId));
    const out = planCandidates({
      task,
      snapshot,
      objectInfo: await this.objectInfo(),
      recipes: this.recipes(task.media.kind),
      ...(request.proposals ? { proposals: request.proposals } : {}),
      planId: plan.id,
      now,
      newId,
      ...(this.deps.isPaidNode ? { isPaidNode: this.deps.isPaidNode } : {}),
    });
    store.transaction(() => {
      for (const c of out.presented) store.putCandidate(c);
      // The plan keeps the environment it was prepared in; each candidate records the
      // snapshot it was validated against (`PlanCandidate.environmentId`).
      store.putPlan({
        ...plan,
        state: out.presented.some((c) => c.status !== "blocked") ? "PROPOSED" : "BLOCKED",
        candidateIds: out.presented.map((c) => c.id),
        blockers: out.blockers,
        updatedAt: now().toISOString(),
      });
    });
    return {
      plan: store.getPlan(plan.id),
      candidates: out.presented.map(candidateSummary),
      expanded: out.expanded,
      truncated: out.truncated,
      readiness,
      limit: MAX_PRESENTED_CANDIDATES,
    };
  }

  /**
   * A stored status is data, and a schema-valid edit could change it: select, export and
   * execution recompute the verdict from the candidate's checks before they act on it. For
   * an acquirable candidate that means deriving the acquisition again from the checks, the
   * recipe and the snapshot it was checked on, and requiring the stored one to match.
   */
  private requireSelectable(candidate: PlanCandidate, task: TaskSpec, options: { allowAcquirable: boolean }): void {
    const overall = overallVerdict(candidate.validation.checks);
    if (candidate.status === "feasible" && overall !== "pass") {
      throw new PlanningError(
        "GRAPH_CONFLICT",
        `candidate ${candidate.id} is recorded as feasible, but its checks come to ${overall}`,
        "Call validate for this candidate, then select again.",
      );
    }
    if (candidate.status === "feasible") return;
    if (candidate.status === "acquirable" && options.allowAcquirable) {
      const recipe = this.deps.store.getRecipe(candidate.recipeId, candidate.recipeRevision);
      const derived = recipe
        ? deriveAcquisition({ recipe, task, candidate, snapshot: this.deps.store.getSnapshot(candidate.environmentId) })
        : undefined;
      if (!derived?.acquirable || canonicalJson(derived.acquisition) !== canonicalJson(candidate.acquisition)) {
        throw new PlanningError(
          "GRAPH_CONFLICT",
          `candidate ${candidate.id} is recorded as acquirable, but its checks, recipe and snapshot don't give that acquisition` +
            (derived && !derived.acquirable && derived.refusals.length > 0 ? `: ${derived.refusals.map((r) => r.message).join("; ")}` : ""),
          "Call validate for this candidate, then select again.",
        );
      }
      return;
    }
    throw new PlanningError(
      candidate.status === "diagnostic" ? "UNVERIFIED_COMPATIBILITY" : "NO_FEASIBLE_CANDIDATE",
      `candidate ${candidate.id} is ${candidate.status}: ${blockingChecks(candidate.validation).join("; ") || "see its validation report"}`,
      candidate.status === "acquirable"
        ? "This step needs a feasible candidate; the acquirable one needs its files first."
        : "Resolve the blocking checks and call validate, or choose a feasible candidate.",
    );
  }

  /** A candidate's graph, compiled again and checked against its stored fingerprint. */
  private compiledGraph(candidate: PlanCandidate, task: TaskSpec) {
    const recipe = this.deps.store.getRecipe(candidate.recipeId, candidate.recipeRevision);
    if (!recipe) {
      throw new PlanningError("GRAPH_CONFLICT", `recipe ${candidate.recipeId} r${candidate.recipeRevision} is no longer in the catalog`, "Propose again.");
    }
    const compiled = compileRecipe(recipe, task, candidate.bindings);
    if (candidate.graphFingerprint === undefined) {
      throw new PlanningError("GRAPH_CONFLICT", `candidate ${candidate.id} never compiled: ${blockingChecks(candidate.validation).join("; ") || "see its validation report"}`, "Choose another candidate or propose again.");
    }
    if (!compiled.graph || compiled.fingerprint !== candidate.graphFingerprint) {
      throw new PlanningError("GRAPH_CONFLICT", `candidate ${candidate.id} no longer compiles to the graph it was validated as`, "Propose again.");
    }
    return { recipe, graph: compiled.graph, fingerprint: compiled.fingerprint };
  }

  private requireCandidate(plan: Plan, candidateId: string): PlanCandidate {
    const c = plan.candidateIds.includes(candidateId) ? this.deps.store.getCandidate(candidateId) : undefined;
    if (!c) throw new PlanningError("MISSING_INPUT", `plan ${plan.id} has no candidate ${candidateId}`, "Use a candidate ID from propose or get.");
    return c;
  }

  /** A plan and its candidates; the compiled graph of one candidate on request (spec §16.2: on demand). */
  get(request: { planId: string; graphOf?: string }) {
    const { plan, task } = this.requirePlan(request.planId);
    const candidates = plan.candidateIds.map((id) => this.deps.store.getCandidate(id)).filter((c): c is PlanCandidate => c !== undefined);
    const graph = request.graphOf ? this.compiledGraph(this.requireCandidate(plan, request.graphOf), task).graph : undefined;
    return { plan, task, candidates: candidates.map(candidateSummary), ...(graph ? { graph } : {}) };
  }

  /** Validate one candidate again against a fresh snapshot and the live node schemas. */
  async validate(request: { planId: string; candidateId: string }) {
    const { store, now } = this.deps;
    const { plan, task } = this.requirePlan(request.planId);
    const candidate = this.requireCandidate(plan, request.candidateId);
    const { recipe, graph } = this.compiledGraph(candidate, task);
    const { snapshot } = await this.environment();
    const outcome = validateGraph({
      graph,
      recipe,
      task,
      bindings: candidate.bindings,
      objectInfo: await this.objectInfo(),
      snapshot,
      ...(this.deps.isPaidNode ? { isPaidNode: this.deps.isPaidNode } : {}),
    });
    const verdict = candidateStatus({ recipe, task, report: outcome.report, bindings: candidate.bindings, snapshot });
    const status = verdict.status;
    // The acquisition is recomputed with the status, never carried over from the last check.
    const { acquisition: _previousAcquisition, ...rest } = candidate;
    const updated = store.putCandidate({
      ...rest,
      environmentId: snapshot.id,
      validation: outcome.report,
      dependencyDelta: outcome.dependencyDelta,
      status,
      ...(verdict.acquisition ? { acquisition: verdict.acquisition } : {}),
    });
    // A selection holds only while its candidate is feasible or acquirable: when a recheck
    // finds it neither, the selection is withdrawn, so export can't write a graph that fails.
    const deselect = plan.state === "SELECTED" && plan.selectedCandidateId === candidate.id && !SELECTABLE.includes(status);
    const statuses = plan.candidateIds.map((id) => (id === candidate.id ? status : store.getCandidate(id)?.status));
    const { selectedCandidateId: _withdrawn, ...unselected } = plan;
    const next: Plan =
      plan.state === "SELECTED" && !deselect
        ? { ...plan, updatedAt: now().toISOString() }
        : { ...unselected, state: statuses.some((x) => x !== undefined && x !== "blocked") ? "PROPOSED" : "BLOCKED", updatedAt: now().toISOString() };
    const stored = store.putPlan(next);
    return {
      candidate: candidateSummary(updated),
      environmentId: snapshot.id,
      previous: candidate.validation.overall,
      planState: stored.state,
      ...(deselect ? { selectionWithdrawn: true } : {}),
    };
  }

  /** Record the user's choice. Selecting authorizes nothing (spec §16.1). */
  select(request: { planId: string; candidateId: string }) {
    const { store, now } = this.deps;
    const { plan, task } = this.requirePlan(request.planId);
    const candidate = this.requireCandidate(plan, request.candidateId);
    this.requireSelectable(candidate, task, { allowAcquirable: true });
    if (plan.state === "SUPERSEDED") throw new PlanningError("GRAPH_CONFLICT", `plan ${plan.id} is SUPERSEDED`, "Call prepare for a new plan.");
    return store.putPlan({ ...plan, state: "SELECTED", selectedCandidateId: candidate.id, updatedAt: now().toISOString() });
  }

  /**
   * The selected candidate of a plan and its graph, compiled again and checked against the
   * validated fingerprint, for execution (TODO 3.3). The same checks export makes, so a run
   * never starts from a candidate that export would refuse. Feasible only, unless the caller
   * sets `allowAcquirable`: the run that acquires the files first (TODO 4.5) does.
   */
  selectedForRun(planId: string, options: { allowAcquirable?: boolean } = {}) {
    const { plan, task } = this.requirePlan(planId);
    if (plan.state !== "SELECTED" || !plan.selectedCandidateId) {
      throw new PlanningError("MISSING_INPUT", `plan ${plan.id} has no selected candidate`, "Ask the user to choose a candidate, then call select.");
    }
    const candidate = this.requireCandidate(plan, plan.selectedCandidateId);
    this.requireSelectable(candidate, task, { allowAcquirable: options.allowAcquirable ?? false });
    const { recipe, graph, fingerprint } = this.compiledGraph(candidate, task);
    return { plan, task, candidate, recipe, graph, fingerprint };
  }

  /** A candidate's graph, compiled again; refuses one that no longer matches its fingerprint. */
  graphOfCandidate(candidateId: string, task: TaskSpec) {
    const candidate = this.deps.store.getCandidate(candidateId);
    if (!candidate) throw new PlanningError("GRAPH_CONFLICT", `candidate ${candidateId} is not stored`, "Prepare a new run.");
    return this.compiledGraph(candidate, task);
  }

  /**
   * The dependency lock of a candidate's compiled graph: recipe, model files, node classes,
   * environment and fork. Export writes it, and a run's record carries it (spec §15.1, FR-11).
   */
  dependencyLock(candidateId: string, task: TaskSpec) {
    const candidate = this.deps.store.getCandidate(candidateId);
    if (!candidate) throw new PlanningError("GRAPH_CONFLICT", `candidate ${candidateId} is not stored`, "Prepare a new run.");
    const { recipe, graph, fingerprint } = this.compiledGraph(candidate, task);
    return this.lockFor(candidate, recipe, graph, fingerprint);
  }

  private lockFor(candidate: PlanCandidate, recipe: Recipe, graph: ApiGraph, fingerprint: string) {
    const env = this.deps.store.getSnapshot(candidate.environmentId);
    return {
      // An acquirable candidate's files aren't on the target yet: the lock lists them with
      // the pinned source each would come from (ARCH 2026-11-16, sources).
      ...(candidate.acquisition
        ? {
            acquire: {
              files: candidate.acquisition.files.map((f) => ({ slot: f.slot, folder: f.folder, file: f.file, source: f.source })),
              totalBytes: candidate.acquisition.totalBytes,
            },
          }
        : {}),
      schemaVersion: 1,
      graphFingerprint: fingerprint,
      recipe: { id: recipe.id, revision: recipe.revision, certification: recipe.certification, contentHash: sha256Hex(canonicalJson(recipe)) },
      models: recipe.slots
        .filter((s) => s.valueType === "model_file" && candidate.bindings[s.id] !== undefined)
        .map((s) => ({ slot: s.id, folder: s.modelFolder, file: String(candidate.bindings[s.id]), family: s.modelFamily })),
      nodeClasses: [...new Set(Object.values(graph).map((n) => n.class_type))].sort(),
      environment: env
        ? { id: env.id, capturedAt: env.capturedAt, comfyuiVersion: env.comfyuiVersion, nodeSchemaDigest: env.nodeSchemaDigest }
        : { id: candidate.environmentId },
      fork: { product: FORK_IDENTITY.product, version: FORK_IDENTITY.version, upstream: UPSTREAM_BASELINE.commit },
    };
  }

  /** Write the selected candidate's files under `artifacts/<task-id>/<plan-id>/` (spec §15.1). */
  export(request: { planId: string }) {
    const { plan, task } = this.requirePlan(request.planId);
    if (plan.state !== "SELECTED" || !plan.selectedCandidateId) {
      throw new PlanningError("MISSING_INPUT", `plan ${plan.id} has no selected candidate`, "Call select first.");
    }
    const candidate = this.requireCandidate(plan, plan.selectedCandidateId);
    this.requireSelectable(candidate, task, { allowAcquirable: true });
    const { recipe, graph, fingerprint } = this.compiledGraph(candidate, task);
    const root = resolve(this.deps.dataDir, "artifacts");
    const dir = resolve(root, task.id, plan.id);
    // IDs are generated here, but a stored ID is still data: never write outside artifacts/.
    if (!dir.startsWith(root + sep)) throw new PlanningError("GRAPH_CONFLICT", `refusing to export outside ${root}`, "Report this plan ID.");
    mkdirSync(dir, { recursive: true });
    // A symlink anywhere under artifacts/ could point the write elsewhere (SEC T9).
    const real = realpathSync(dir);
    if (real !== resolve(realpathSync(this.deps.dataDir), "artifacts", task.id, plan.id)) {
      throw new PlanningError("GRAPH_CONFLICT", `refusing to export through a symbolic link under ${root}`, "Remove the link and export again.");
    }
    const lock = this.lockFor(candidate, recipe, graph, fingerprint);
    const files: Record<string, unknown> = {
      "task.json": task,
      "plan.json": { plan, candidate },
      "workflow.api.json": graph,
      "validation.json": candidate.validation,
      "dependencies.lock.json": lock,
    };
    const written: string[] = [];
    for (const [name, value] of Object.entries(files)) {
      const path = join(dir, name);
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
      written.push(path);
    }
    return { dir, files: written, graphFingerprint: fingerprint, uiGraph: "not exported: the UI graph comes with a certified recipe's UI template (ARCH, 2026-11-15)" };
  }
}

/** Statuses a plan's selection may hold. */
const SELECTABLE: readonly PlanCandidate["status"][] = ["feasible", "acquirable"];

function blockingChecks(report: ValidationReport): string[] {
  return report.checks.filter((c) => c.hard && (c.verdict === "fail" || c.verdict === "unknown")).map((c) => `${c.verdict}: ${c.message}`);
}

/** What the agent sees of a candidate: decisions and reasons, not the whole report. */
export function candidateSummary(c: PlanCandidate) {
  return {
    id: c.id,
    recipe: `${c.recipeId} r${c.recipeRevision}`,
    status: c.status,
    tier: c.ranking.tier,
    bindings: c.bindings,
    overall: c.validation.overall,
    blocking: blockingChecks(c.validation),
    softUnknowns: c.validation.checks.filter((x) => !x.hard && x.verdict === "unknown").map((x) => x.message),
    dependencyDelta: c.dependencyDelta,
    ...(c.acquisition
      ? {
          acquisition: {
            files: c.acquisition.files.map((f) => ({
              slot: f.slot,
              folder: f.folder,
              file: f.file,
              size: formatBytes(f.source.sizeBytes),
              source: `${f.source.repo}@${f.source.revision.slice(0, 8)}:${f.source.path}`,
            })),
            total: formatBytes(c.acquisition.totalBytes),
            totalBytes: c.acquisition.totalBytes,
          },
        }
      : {}),
    resourceEstimate: c.resourceEstimate,
    ranking: c.ranking.explanation,
    graphFingerprint: c.graphFingerprint,
  };
}
