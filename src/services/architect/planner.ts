// Planning (spec §9, TODO 2.5.3): from a stored task and an environment snapshot to at most
// three validated candidates, or a report of what blocks every candidate.
//
// Bounded by construction: at most 20 recipes retrieved, 24 concrete candidates expanded
// and 3 presented (spec §9.2). Hard constraints apply before ranking; a candidate whose
// hard checks fail is blocked whatever its tier, and one with a hard unknown is kept only
// as a diagnostic candidate (spec §9.2 step 4, §9.3).

import { retrieveRecipes } from "./catalog.js";
import { compileRecipe } from "./compile.js";
import type { CheckResult, EnvironmentSnapshot, PlanBlockers, PlanCandidate, Recipe, TaskSpec } from "./schemas.js";
import type { ComfyUINodeDef, ObjectInfo } from "../../comfyui/types.js";
import { validateGraph } from "./validate.js";

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

const STATUS_ORDER = { feasible: 0, diagnostic: 1, blocked: 2 } as const;
const TIER_ORDER = { certified: 0, curated: 1, proposed: 2, fixture: 3 } as const;

function statusFor(overall: "pass" | "fail" | "unknown"): PlanCandidate["status"] {
  return overall === "pass" ? "feasible" : overall === "unknown" ? "diagnostic" : "blocked";
}

/** Sort blocking checks into the groups spec §9.5 asks for. */
function addBlockers(into: PlanBlockers, recipe: Recipe, checks: readonly CheckResult[]): void {
  for (const c of checks) {
    if (!c.hard || (c.verdict !== "fail" && c.verdict !== "unknown")) continue;
    const line = `${recipe.id}: ${c.message}`;
    if (c.verdict === "unknown") into.insufficient_evidence.push(line);
    else if (c.layer === "dependencies") into.missing_dependencies.push(line);
    else if (c.layer === "policy") into.policy_conflicts.push(line);
    else if (c.layer === "contract" && c.id.startsWith("contract.operation")) into.unsupported_operation.push(line);
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
      const report = validateGraph({ graph: compiled.graph, recipe, task, bindings, objectInfo, snapshot, ...(input.isPaidNode ? { isPaidNode: input.isPaidNode } : {}) });
      addBlockers(blockers, recipe, report.report.checks);
      built.push({
        schemaVersion: 1,
        id: `cand-${newId()}`,
        planId,
        taskId: task.id,
        taskRevision: task.revision,
        recipeId: recipe.id,
        recipeRevision: recipe.revision,
        environmentId: snapshot.id,
        // The model files the graph actually binds, defaults included, so the candidate,
        // the agent and the export's lock name every file (compiling these again gives the
        // same graph).
        bindings: { ...modelValues(recipe, compiled.values), ...bindings },
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
            `${report.dependencyDelta.missingNodeClasses.length} missing node class(es)`,
        },
        status: statusFor(report.report.overall),
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
