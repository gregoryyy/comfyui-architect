// The local recipe catalog (spec §8, TODO 2.4): loading recipe files and retrieving the
// ones that fit a task.
//
// Recipes are JSON files validated by the `Recipe` schema. Shipped ones live in
// `architect/recipes/` at the package root; an invalid file is reported with its reason,
// never skipped silently (spec §8.4). Retrieval is a bounded filter and sort over what
// the catalog holds; nothing here fetches from outside the machine.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type EnvironmentSnapshot, Recipe, type TaskSpec } from "./schemas.js";

/** `architect/recipes/` at the package root: three levels up from src/ and from dist/. */
export const SHIPPED_RECIPES_DIR = fileURLToPath(new URL("../../../architect/recipes/", import.meta.url));

/** Retrieve at most this many recipes for one task (spec §9.2). */
export const MAX_RETRIEVED_RECIPES = 20;

/** JSON with object keys sorted at every level, so equal content hashes equal (spec §10.5). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

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

/** Load every `*.recipe.json` in `dir`, in file-name order. Two files with one id and revision is an error. */
export function loadRecipeDir(dir: string): RecipeLoadResult {
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

const TIER_ORDER = { certified: 0, curated: 1, fixture: 2 } as const;

export interface RetrievedRecipe {
  recipe: Recipe;
  /** Model slots whose folder lists at least one installed file, out of all model slots. */
  installedOverlap: { satisfiable: number; total: number };
  /** Model slots whose folder the snapshot couldn't read: their fit is unknown. */
  unknownFolders: string[];
}

/**
 * Recipes that solve the task's kind and operation, best first: evidence tier, then the
 * share of model slots the target could fill from installed files, then id (spec §8.5).
 * "Could fill" only means the folder lists some file; whether a file fits is the
 * validator's question. A folder the snapshot couldn't read counts as unknown, never as
 * empty (#796).
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
      } else if (listed.length > 0) {
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
