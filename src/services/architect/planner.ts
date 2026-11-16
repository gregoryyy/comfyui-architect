// Planning (spec §9, TODO 2.5.3): from a stored task and an environment snapshot to at most
// three validated candidates, or a report of what blocks every candidate.
//
// Bounded by construction: at most 20 recipes retrieved, 24 concrete candidates expanded
// and 3 presented (spec §9.2). Hard constraints apply before ranking; a candidate whose
// hard checks fail is blocked whatever its tier, and one with a hard unknown is kept only
// as a diagnostic candidate (spec §9.2 step 4, §9.3). A candidate blocked only by model
// files its recipe pins a source for is `acquirable` (ARCH 2026-11-16, candidates): ranked
// after feasible ones and before diagnostic ones, since the user's approval of a download
// resolves it, while a diagnostic candidate's unknowns have no such remedy.

import { deriveAcquisition, formatBytes, type AcquisitionRefusal } from "./acquisition-policy.js";
import { retrieveRecipes } from "./catalog.js";
import { compileRecipe } from "./compile.js";
import type {
  CandidateAcquisition,
  CheckResult,
  EnvironmentSnapshot,
  PlanBlockers,
  PlanCandidate,
  Recipe,
  TaskSpec,
  ValidationReport,
} from "./schemas.js";
import type { ComfyUINodeDef, ObjectInfo } from "../../comfyui/types.js";
import { type FamilyEvidence, validateGraph } from "./validate.js";

export const MAX_EXPANDED_CANDIDATES = 24;
export const MAX_PRESENTED_CANDIDATES = 3;

/** Inputs each image operation needs before planning can start (spec §7.2). */
const REQUIRED_INPUTS: Record<TaskSpec["media"]["operation"], TaskSpec["inputs"][number]["role"][]> = {
  text_to_image: [],
  image_edit: ["source_image"],
  inpaint: ["source_image", "mask"],
  reference_guided: ["reference_image"],
  upscale: ["source_image"],
};

/** What `prepare` can't fill in by itself and has to ask the user for. */
export function missingTaskFields(task: Pick<TaskSpec, "media" | "inputs">): string[] {
  const have = new Set(task.inputs.map((i) => i.role));
  return REQUIRED_INPUTS[task.media.operation]
    .filter((role) => !have.has(role))
    .map((role) => `inputs: a ${role} asset (operation ${task.media.operation})`);
}

/** Bindings the agent proposed for one recipe (spec §9.2: the agent may fill typed slots). */
export interface ProposedBinding {
  recipeId: string;
  bindings: Record<string, string | number>;
}

export interface PlanningInput {
  task: TaskSpec;
  snapshot: EnvironmentSnapshot;
  /** Live node schemas; undefined when the probe failed, which leaves schema checks unknown. */
  objectInfo: ObjectInfo | undefined;
  recipes: readonly Recipe[];
  proposals?: readonly ProposedBinding[];
  planId: string;
  /** Decides whether a node spends money remotely; the validator's own rule when absent. */
  isPaidNode?: (def: ComfyUINodeDef) => boolean;
  /** Observed families of the files `boundModelFiles` names; absent, family checks stay unknown. */
  families?: FamilyEvidence;
  now: () => Date;
  newId: () => string;
}

export interface PlanningOutput {
  /** All presented candidates, best first; at most three. */
  presented: PlanCandidate[];
  /** How many concrete candidates were built and checked. */
  expanded: number;
  blockers: PlanBlockers;
  /** True when the candidate limit cut enumeration short. */
  truncated: boolean;
}

const EMPTY_BLOCKERS = (): PlanBlockers => ({
  missing_dependencies: [],
  unsupported_operation: [],
  insufficient_evidence: [],
  resource_limits: [],
  policy_conflicts: [],
});

/**
 * Binding sets to try for a recipe: the agent's proposals for it, or else enumerated ones.
 * A model slot with a default names the file the recipe was written for: it's used as it
 * is, and when the target doesn't list it the candidate is blocked naming that file, never
 * filled with another file from the same folder, whose family nothing has checked (spec
 * §9.2, §8.1). Only a model slot without a default is enumerated over the folder's files,
 * in name order. A slot whose folder lists no file stays unbound and blocks with the reason.
 */
function bindingSets(
  recipe: Recipe,
  snapshot: EnvironmentSnapshot,
  proposals: readonly ProposedBinding[],
  budget: number,
): { sets: Record<string, string | number>[]; truncated: boolean } {
  const own = proposals.filter((p) => p.recipeId === recipe.id).map((p) => p.bindings);
  if (own.length > 0) return { sets: own.slice(0, budget), truncated: own.length > budget };
  let sets: Record<string, string | number>[] = [{}];
  let truncated = false;
  for (const slot of recipe.slots) {
    if (slot.valueType !== "model_file" || slot.default !== undefined) continue;
    const files = snapshot.installedModels?.folders[slot.modelFolder ?? ""] ?? [];
    if (files.length === 0) continue;
    const next: Record<string, string | number>[] = [];
    for (const set of sets) {
      for (const file of files) {
        if (next.length >= budget) {
          truncated = true;
          break;
        }
        next.push({ ...set, [slot.id]: file });
      }
    }
    sets = next;
  }
  return { sets, truncated };
}

/** The resolved values of a recipe's model slots. */
function modelValues(recipe: Recipe, values: Record<string, string | number>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const slot of recipe.slots) {
    const v = values[slot.id];
    if (slot.valueType === "model_file" && v !== undefined) out[slot.id] = v;
  }
  return out;
}

/**
 * The installed model files the candidates `planCandidates` builds would bind, so planning
 * can read their families before it validates (TODO 5.3): the same retrieval, binding sets
 * and compilation, without validation. Files the snapshot doesn't list for their folder are
 * left out: there is nothing on the target to read.
 */
export function boundModelFiles(input: Pick<PlanningInput, "task" | "snapshot" | "recipes" | "proposals">): { folder: string; file: string }[] {
  const { task, snapshot } = input;
  const proposals = input.proposals ?? [];
  const retrieved = retrieveRecipes(input.recipes, task, snapshot);
  const share = retrieved.length === 0 ? 0 : Math.max(1, Math.floor(MAX_EXPANDED_CANDIDATES / retrieved.length));
  const out = new Map<string, { folder: string; file: string }>();
  let built = 0;
  for (const { recipe } of retrieved) {
    const budget = Math.min(share, MAX_EXPANDED_CANDIDATES - built);
    if (budget <= 0) break;
    const { sets } = bindingSets(recipe, snapshot, proposals, budget);
    built += sets.length;
    for (const bindings of sets) {
      const values = { ...compileRecipe(recipe, task, bindings).values, ...bindings };
      for (const slot of recipe.slots) {
        const file = values[slot.id];
        const folder = slot.modelFolder ?? "";
        if (slot.valueType !== "model_file" || typeof file !== "string") continue;
        if (!snapshot.installedModels?.folders[folder]?.includes(file)) continue;
        out.set(`${folder}/${file}`, { folder, file });
      }
    }
  }
  return [...out.values()];
}

/** Candidate statuses in ranking order; the loop that groups candidates walks it too. */
export const STATUS_ORDER = { feasible: 0, acquirable: 1, diagnostic: 2, blocked: 3 } as const satisfies Record<PlanCandidate["status"], number>;
const TIER_ORDER = { certified: 0, curated: 1, proposed: 2, fixture: 3 } as const;

/** A candidate's status from its checks, and for a failing one whether it can be acquired. */
export interface CandidateStatusResult {
  status: PlanCandidate["status"];
  acquisition?: CandidateAcquisition;
  /** Why a candidate that only lacks model files can't acquire them; empty otherwise. */
  refusals: AcquisitionRefusal[];
}

/**
 * The status planning and revalidation both give a candidate: feasible when its hard checks
 * pass, diagnostic when one is unknown, acquirable when `deriveAcquisition` accepts its
 * missing files, else blocked.
 */
export function candidateStatus(input: {
  recipe: Recipe;
  task: Pick<TaskSpec, "constraints" | "budgets">;
  report: ValidationReport;
  bindings: PlanCandidate["bindings"];
  snapshot: Pick<EnvironmentSnapshot, "installedModels"> | undefined;
}): CandidateStatusResult {
  const { report } = input;
  if (report.overall === "pass") return { status: "feasible", refusals: [] };
  if (report.overall === "unknown") return { status: "diagnostic", refusals: [] };
  const acq = deriveAcquisition({
    recipe: input.recipe,
    task: input.task,
    candidate: { validation: report, bindings: input.bindings },
    snapshot: input.snapshot,
  });
  return acq.acquirable ? { status: "acquirable", acquisition: acq.acquisition, refusals: [] } : { status: "blocked", refusals: acq.refusals };
}

/** Sort blocking checks into the groups spec §9.5 asks for. */
function addBlockers(into: PlanBlockers, recipe: Recipe, checks: readonly CheckResult[]): void {
  for (const c of checks) {
    if (!c.hard || (c.verdict !== "fail" && c.verdict !== "unknown")) continue;
    const line = `${recipe.id}: ${c.message}`;
    if (c.verdict === "unknown") into.insufficient_evidence.push(line);
    else if (c.layer === "dependencies") into.missing_dependencies.push(line);
    else if (c.layer === "policy") into.policy_conflicts.push(line);
    // A task input no slot takes, or an asset form Architect can't resolve, is unsupported
    // by the recipe (GAPS Q16), not a dependency to install.
    else if (c.layer === "contract" && (c.id.startsWith("contract.operation") || c.id.startsWith("contract.task.inputs."))) into.unsupported_operation.push(line);
    else into.missing_dependencies.push(line);
  }
}

function dedupe(b: PlanBlockers): PlanBlockers {
  const out = EMPTY_BLOCKERS();
  for (const k of Object.keys(out) as (keyof PlanBlockers)[]) out[k] = [...new Set(b[k])];
  return out;
}

/** Build, check and rank candidates for one task. Pure apart from the injected clock and ids. */
export function planCandidates(input: PlanningInput): PlanningOutput {
  const { task, snapshot, objectInfo, planId, now, newId } = input;
  const proposals = input.proposals ?? [];
  const blockers = EMPTY_BLOCKERS();
  const retrieved = retrieveRecipes(input.recipes, task, snapshot);
  if (retrieved.length === 0) {
    blockers.unsupported_operation.push(
      `no recipe in the catalog solves ${task.media.kind}/${task.media.operation}`,
    );
    return { presented: [], expanded: 0, blockers, truncated: false };
  }
  for (const p of proposals) {
    if (!retrieved.some((r) => r.recipe.id === p.recipeId)) {
      blockers.unsupported_operation.push(`${p.recipeId}: not a recipe in the catalog for ${task.media.kind}/${task.media.operation}`);
    }
  }

  const built: PlanCandidate[] = [];
  let truncated = false;
  // Each recipe gets an equal share of the expansion budget, so one recipe's combinations
  // can't crowd out every other recipe (spec §9.2 step 6: distinct trade-offs).
  const share = Math.max(1, Math.floor(MAX_EXPANDED_CANDIDATES / retrieved.length));
  for (const { recipe } of retrieved) {
    const budget = Math.min(share, MAX_EXPANDED_CANDIDATES - built.length);
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const expansion = bindingSets(recipe, snapshot, proposals, budget);
    if (expansion.truncated) truncated = true;
    for (const bindings of expansion.sets) {
      const compiled = compileRecipe(recipe, task, bindings);
      const report = validateGraph({
        graph: compiled.graph,
        recipe,
        task,
        bindings,
        objectInfo,
        snapshot,
        ...(input.isPaidNode ? { isPaidNode: input.isPaidNode } : {}),
        ...(input.families ? { families: input.families } : {}),
      });
      // The model files the graph actually binds, defaults included, so the candidate,
      // the agent and the export's lock name every file (compiling these again gives the
      // same graph).
      const bound = { ...modelValues(recipe, compiled.values), ...bindings };
      const verdict = candidateStatus({ recipe, task, report: report.report, bindings: bound, snapshot });
      // An acquirable candidate's failing checks are the files the approval would fetch, not
      // blockers; a refused acquisition adds why next to the checks it leaves failing.
      if (verdict.status !== "acquirable") addBlockers(blockers, recipe, report.report.checks);
      for (const r of verdict.refusals) blockers[r.group].push(`${recipe.id}: ${r.message}`);
      const scaleNote = renderScaleNote(recipe, task, bound);
      const acquisitionNote = verdict.acquisition
        ? `; acquirable: ${verdict.acquisition.files.length} file(s), ${formatBytes(verdict.acquisition.totalBytes)} to download`
        : verdict.refusals.length > 0
          ? `; not acquirable: ${verdict.refusals.map((r) => r.message).join("; ")}`
          : "";
      built.push({
        schemaVersion: 1,
        id: `cand-${newId()}`,
        planId,
        taskId: task.id,
        taskRevision: task.revision,
        recipeId: recipe.id,
        recipeRevision: recipe.revision,
        environmentId: snapshot.id,
        bindings: bound,
        transforms: [],
        ...(compiled.fingerprint ? { graphFingerprint: compiled.fingerprint } : {}),
        roleMap: compiled.roleMap,
        validation: report.report,
        dependencyDelta: report.dependencyDelta,
        resourceEstimate: { status: "unknown", reason: "no measured resource profile for this recipe on this target yet" },
        ranking: {
          tier: recipe.certification,
          explanation:
            `${recipe.certification} recipe ${recipe.id} r${recipe.revision}; ` +
            `${report.dependencyDelta.missingModels.length} missing model(s), ` +
            `${report.dependencyDelta.missingNodeClasses.length} missing node class(es)${scaleNote}${acquisitionNote}`,
        },
        status: verdict.status,
        ...(verdict.acquisition ? { acquisition: verdict.acquisition } : {}),
        createdAt: now().toISOString(),
      });
    }
  }

  // Hard constraints first (status), then evidence tier, then dependency burden. Within a
  // status, the first candidate of each recipe goes before a second of any, so three slots
  // show three trade-offs where three exist (spec §9.2 step 6) — but never ahead of a
  // candidate with a better status: a blocked candidate can't push out a feasible one.
  const burden = (c: PlanCandidate) => c.dependencyDelta.missingModels.length + c.dependencyDelta.missingNodeClasses.length;
  const ranked = [...built].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      TIER_ORDER[a.ranking.tier] - TIER_ORDER[b.ranking.tier] ||
      burden(a) - burden(b) ||
      (a.recipeId < b.recipeId ? -1 : a.recipeId > b.recipeId ? 1 : 0),
  );
  const ordered: PlanCandidate[] = [];
  for (const status of Object.keys(STATUS_ORDER) as PlanCandidate["status"][]) {
    const group = ranked.filter((c) => c.status === status);
    const firstPerRecipe = group.filter((c, i) => group.findIndex((d) => d.recipeId === c.recipeId) === i);
    ordered.push(...firstPerRecipe, ...group.filter((c) => !firstPerRecipe.includes(c)));
  }
  const presented = ordered.slice(0, MAX_PRESENTED_CANDIDATES);
  return { presented, expanded: built.length, blockers: dedupe(blockers), truncated };
}

/**
 * What a recipe that generates below the task's size does about it, for the candidate's
 * rationale, so the user sees it before selecting (`fromTaskDivisor`; GAPS Q15, Q16): e.g.
 * "; generates at 1024×1024 and upscales 2× to 2048×2048 with RealESRGAN_x4plus.safetensors".
 * Empty for a recipe that renders at the task's size. The delivered size is still checked
 * after the run (output_dimensions).
 */
export function renderScaleNote(recipe: Recipe, task: TaskSpec, bindings: Record<string, string | number>): string {
  const divided = recipe.slots.filter((s) => s.fromTaskDivisor !== undefined && s.fromTask !== undefined);
  if (divided.length === 0) return "";
  const out = task.media.output;
  const divisorOf = (path: string) => divided.find((s) => s.fromTask === path)?.fromTaskDivisor;
  const dw = divisorOf("media.output.width");
  const dh = divisorOf("media.output.height");
  const upscaler = recipe.slots.find((s) => s.valueType === "model_file" && s.modelFolder === "upscale_models");
  const model = upscaler ? bindings[upscaler.id] : undefined;
  const via = typeof model === "string" ? ` with ${model}` : "";
  if (dw !== undefined && dh !== undefined) {
    const factor = dw === dh ? `${dw}×` : `${dw}× by ${dh}×`;
    return `; generates at ${out.width / dw}×${out.height / dh} and upscales ${factor} to ${out.width}×${out.height}${via}`;
  }
  return `; generates ${divided.map((s) => `${s.fromTask} at 1/${s.fromTaskDivisor}`).join(", ")} and scales back${via}`;
}
