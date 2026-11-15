import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SHIPPED_RECIPES_DIR,
  canonicalJson,
  loadRecipeDir,
  retrieveRecipes,
} from "../../services/architect/catalog.js";
import { Recipe } from "../../services/architect/schemas.js";

function recipe(id: string, over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id,
    revision: 1,
    title: id,
    kind: "image",
    operations: ["text_to_image"],
    graph: {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "x.safetensors" } },
      "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
    },
    slots: [
      {
        id: "checkpoint",
        label: "Checkpoint",
        valueType: "model_file",
        target: { node: "1", input: "ckpt_name" },
        required: true,
        modelFolder: "checkpoints",
      },
    ],
    outputs: [{ role: "image", node: "2" }],
    dependencies: { nodeClasses: ["CheckpointLoaderSimple", "SaveImage"] },
    certification: "fixture",
    evidence: [],
    ...over,
  };
}

const dirs: string[] = [];
function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "architect-catalog-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("canonicalJson", () => {
  it("is independent of key order and drops undefined values", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(
      canonicalJson({ a: { d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });
});

describe("loadRecipeDir", () => {
  it("loads valid recipes in file order with a content hash", () => {
    const dir = dirWith({
      "b.recipe.json": JSON.stringify(recipe("recipe-b")),
      "a.recipe.json": JSON.stringify(recipe("recipe-a")),
      "notes.md": "ignored: not a recipe file",
    });
    const res = loadRecipeDir(dir);
    expect(res.dirFound).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.recipes.map((r) => r.recipe.id)).toEqual(["recipe-a", "recipe-b"]);
    expect(res.recipes[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the same recipe the same, whatever the key order in the file", () => {
    const r = recipe("recipe-a");
    const reordered = Object.fromEntries(Object.entries(r).reverse());
    const one = loadRecipeDir(dirWith({ "a.recipe.json": JSON.stringify(r) }));
    const two = loadRecipeDir(dirWith({ "a.recipe.json": JSON.stringify(reordered) }));
    expect(one.recipes[0].contentHash).toBe(two.recipes[0].contentHash);
  });

  it("reports broken JSON, a schema violation and a duplicate id and revision, and keeps the valid rest", () => {
    const dir = dirWith({
      "1.recipe.json": "{ not json",
      "2.recipe.json": JSON.stringify(recipe("recipe-x", { operations: ["paint"] })),
      "3.recipe.json": JSON.stringify(recipe("recipe-ok")),
      "4.recipe.json": JSON.stringify(recipe("recipe-ok")),
    });
    const res = loadRecipeDir(dir);
    expect(res.recipes.map((r) => r.recipe.id)).toEqual(["recipe-ok"]);
    expect(res.errors.map((e) => e.file.split("/").pop())).toEqual(["1.recipe.json", "2.recipe.json", "4.recipe.json"]);
    expect(res.errors[0].message).toMatch(/not valid JSON/);
    expect(res.errors[1].message).toMatch(/unknown image operation/);
    expect(res.errors[2].message).toMatch(/already defined/);
  });

  it("tells a missing directory apart from an empty one", () => {
    expect(loadRecipeDir(join(tmpdir(), "architect-no-such-dir-x9")).dirFound).toBe(false);
    expect(loadRecipeDir(dirWith({})).dirFound).toBe(true);
  });

  it("finds the shipped folder and loads it without errors, with no fixture recipe in it", () => {
    const res = loadRecipeDir(SHIPPED_RECIPES_DIR);
    expect(res.dirFound).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.recipes.every((r) => r.recipe.certification !== "fixture")).toBe(true);
  });
});

describe("retrieveRecipes", () => {
  const task = { media: { kind: "image", operation: "text_to_image", output: { width: 512, height: 512, count: 1, format: "png" } } } as const;
  const parse = (r: unknown) => Recipe.parse(r);

  it("keeps only recipes for the task's kind and operation", () => {
    const rs = [
      parse(recipe("recipe-t2i")),
      parse(recipe("recipe-edit", { operations: ["image_edit"] })),
    ];
    expect(retrieveRecipes(rs, task, {}).map((r) => r.recipe.id)).toEqual(["recipe-t2i"]);
  });

  it("ranks by evidence tier, then by installed fit, then by id", () => {
    const rs = [
      parse(recipe("recipe-a-fixture")),
      parse(recipe("recipe-b-curated", { certification: "curated" })),
      parse(recipe("recipe-c-curated-diffusion", {
        certification: "curated",
        slots: [{ id: "unet", label: "UNet", valueType: "model_file", target: { node: "1", input: "ckpt_name" }, required: true, modelFolder: "diffusion_models" }],
      })),
    ];
    const snapshot = { installedModels: { folders: { checkpoints: [], diffusion_models: ["u.safetensors"] }, unanswered: [], absent: [] } };
    expect(retrieveRecipes(rs, task, snapshot).map((r) => r.recipe.id)).toEqual([
      "recipe-c-curated-diffusion",
      "recipe-b-curated",
      "recipe-a-fixture",
    ]);
  });

  it("counts an unread folder as unknown, never as empty", () => {
    const [r] = retrieveRecipes([parse(recipe("recipe-a"))], task, {
      installedModels: { folders: {}, unanswered: [{ folder: "checkpoints", reason: "timeout" }], absent: [] },
    });
    expect(r.unknownFolders).toEqual(["checkpoints"]);
    expect(r.installedOverlap).toEqual({ satisfiable: 0, total: 1 });
    const [noSnapshot] = retrieveRecipes([parse(recipe("recipe-a"))], task, {});
    expect(noSnapshot.unknownFolders).toEqual(["checkpoints"]);
  });

  it("returns at most the limit", () => {
    const rs = Array.from({ length: 25 }, (_, i) => parse(recipe(`recipe-${String(i).padStart(2, "0")}`)));
    expect(retrieveRecipes(rs, task, {})).toHaveLength(20);
    expect(retrieveRecipes(rs, task, {}, 3)).toHaveLength(3);
  });
});
