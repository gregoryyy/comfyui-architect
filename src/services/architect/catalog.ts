// The local recipe catalog (spec §8, TODO 2.4): loading recipe files and retrieving the
// ones that fit a task.
//
// Recipes are JSON files validated by the `Recipe` schema. Shipped ones live in
// `architect/recipes/` at the package root; an invalid file is reported with its reason,
// never skipped silently (spec §8.4). Retrieval is a bounded filter and sort over what
// the catalog holds; nothing here fetches from outside the machine.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Hex } from "./hash.js";
import { type EnvironmentSnapshot, Recipe, type RecipeSlot, type TaskSpec } from "./schemas.js";

export { canonicalJson, sha256Hex };

/** `architect/recipes/` at the package root: three levels up from src/ and from dist/. */
export const SHIPPED_RECIPES_DIR = fileURLToPath(new URL("../../../architect/recipes/", import.meta.url));

/** Retrieve at most this many recipes for one task (spec §9.2). */
export const MAX_RETRIEVED_RECIPES = 20;

export interface LoadedRecipe {
  recipe: Recipe;
  file: string;
  /** sha256 of the canonical JSON of the parsed recipe. */
  contentHash: string;
}

export interface RecipeLoadResult {
  recipes: LoadedRecipe[];
  errors: { file: string; message: string }[];
  /** False when the directory doesn't exist, so "no recipes" is told apart from "not read". */
  dirFound: boolean;
}

/**
 * Whether a recipe's tier is one its evidence supports, for a shipped source (spec §8.4,
 * GAPS Q27): `curated` needs a maintainer review of this revision, and a recipe without one
 * ships as `proposed`. A review entry written before `EvidenceRef.revision` existed carries
 * no revision: those are the owner's reviews of GAPS Q12 and PR #7, which looked at
 * revision 3, so a missing revision counts as 3. Checked when shipped recipes load, not in
 * the Recipe schema, so a stored older revision still parses. Undefined when the tier holds.
 */
export function shippedTierProblem(recipe: Recipe): string | undefined {
  const reviewed = recipe.evidence.some((e) => e.kind === "maintainer_review" && (e.revision ?? 3) === recipe.revision);
  if (recipe.certification === "curated" && !reviewed) {
    return `${recipe.id} r${recipe.revision} is curated without a maintainer review of revision ${recipe.revision}`;
  }
  if (recipe.certification === "proposed" && reviewed) {
    return `${recipe.id} r${recipe.revision} has a maintainer review of this revision but is marked proposed`;
  }
  if (recipe.certification === "fixture") return `${recipe.id} is a test fixture, which is never shipped`;
  return undefined;
}

/**
 * Load every `*.recipe.json` in `dir`, in file-name order. Two files with one id and revision
 * is an error. With `shipped`, a recipe whose tier its evidence doesn't support is refused.
 */
export function loadRecipeDir(dir: string, options: { shipped?: boolean } = {}): RecipeLoadResult {
  if (!existsSync(dir)) return { recipes: [], errors: [], dirFound: false };
  const recipes: LoadedRecipe[] = [];
  const errors: RecipeLoadResult["errors"] = [];
  const seen = new Map<string, string>();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".recipe.json"))
    .sort();
  for (const name of files) {
    const file = join(dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf-8"));
    } catch (err) {
      errors.push({ file, message: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const parsed = Recipe.safeParse(raw);
    if (!parsed.success) {
      errors.push({ file, message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") });
      continue;
    }
    const tier = options.shipped ? shippedTierProblem(parsed.data) : undefined;
    if (tier !== undefined) {
      errors.push({ file, message: tier });
      continue;
    }
    const key = `${parsed.data.id}@${parsed.data.revision}`;
    const earlier = seen.get(key);
    if (earlier) {
      errors.push({ file, message: `${key} is already defined in ${earlier}` });
      continue;
    }
    seen.set(key, file);
    recipes.push({ recipe: parsed.data, file, contentHash: sha256Hex(canonicalJson(parsed.data)) });
  }
  return { recipes, errors, dirFound: true };
}

const TIER_ORDER = { certified: 0, curated: 1, proposed: 2, fixture: 3 } as const;

export interface RetrievedRecipe {
  recipe: Recipe;
  /** Model slots an installed file could fill feasibly (see `fillableFrom`), out of all model slots. */
  installedOverlap: { satisfiable: number; total: number };
  /** Model slots whose folder the snapshot couldn't read: their fit is unknown. */
  unknownFolders: string[];
}

/**
 * Whether a model slot could be filled feasibly from a folder's listed files. It mirrors the
 * validator's rules, so the fit `prepare` reports doesn't promise what `propose` then blocks:
 * a slot with a default needs that file (any other file of the folder fails the family check
 * once the slot names a family, GAPS Q14); a slot with a family but no default can't be
 * filled feasibly at all; a slot with neither takes any listed file. Whether the loader
 * offers the file is still the validator's question.
 */
function fillableFrom(slot: RecipeSlot, listed: readonly string[]): boolean {
  if (slot.default !== undefined) return typeof slot.default === "string" && listed.includes(slot.default);
  if (slot.modelFamily !== undefined) return false;
  return listed.length > 0;
}

/**
 * Recipes that solve the task's kind and operation, best first: evidence tier, then the
 * share of model slots the target could fill from installed files (`fillableFrom`), then id
 * (spec §8.5). A folder the snapshot couldn't read counts as unknown, never as empty (#796).
 */
export function retrieveRecipes(
  recipes: readonly Recipe[],
  task: Pick<TaskSpec, "media">,
  snapshot: Pick<EnvironmentSnapshot, "installedModels">,
  limit = MAX_RETRIEVED_RECIPES,
): RetrievedRecipe[] {
  const matching = recipes.filter((r) => r.kind === task.media.kind && r.operations.includes(task.media.operation));
  const scored = matching.map((recipe): RetrievedRecipe => {
    const modelSlots = recipe.slots.filter((s) => s.valueType === "model_file");
    let satisfiable = 0;
    const unknownFolders: string[] = [];
    for (const slot of modelSlots) {
      const folder = slot.modelFolder ?? "";
      const listed = snapshot.installedModels?.folders[folder];
      if (listed === undefined) {
        if (!snapshot.installedModels?.absent.includes(folder)) unknownFolders.push(folder);
      } else if (fillableFrom(slot, listed)) {
        satisfiable += 1;
      }
    }
    return { recipe, installedOverlap: { satisfiable, total: modelSlots.length }, unknownFolders };
  });
  const share = (r: RetrievedRecipe) => (r.installedOverlap.total === 0 ? 1 : r.installedOverlap.satisfiable / r.installedOverlap.total);
  scored.sort(
    (a, b) =>
      TIER_ORDER[a.recipe.certification] - TIER_ORDER[b.recipe.certification] ||
      share(b) - share(a) ||
      (a.recipe.id < b.recipe.id ? -1 : a.recipe.id > b.recipe.id ? 1 : 0),
  );
  return scored.slice(0, Math.max(0, limit));
}
