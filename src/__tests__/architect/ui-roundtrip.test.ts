// AT-11 (FR-07, spec §10.4; TODO 5.5): every shipped and fixture recipe, compiled, converted
// to the UI format with upstream's convertApiToUi and back with convertUiToApi, gives the
// same executable graph, modulo the nonsemantic fields ui-graph.ts documents (`_meta`, an
// omitted input that comes back as the schema's default, the form of a link). Against the
// captured node schemas of ComfyUI Desktop 0.44.0, so no running ComfyUI is needed.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { ObjectInfo } from "../../comfyui/types.js";
import { SHIPPED_RECIPES_DIR, loadRecipeDir } from "../../services/architect/catalog.js";
import { type Bindings, compileRecipe } from "../../services/architect/compile.js";
import { type ApiGraph, type Recipe, TaskSpec } from "../../services/architect/schemas.js";
import { exportUiGraph, uiRoundTrip } from "../../services/architect/ui-graph.js";
import { fixtureRecipe } from "./fixtures/load.js";

function desktopObjectInfo(): ObjectInfo {
  const parsed: ObjectInfo = JSON.parse(readFileSync(new URL("./fixtures/object-info-desktop-0.44.0.json", import.meta.url), "utf-8"));
  return parsed;
}

const T = "2026-11-16T10:00:00.000Z";

/** A task the recipe serves: its first operation, a size its divisors divide, its input images. */
function taskFor(recipe: Recipe): TaskSpec {
  const inputs = recipe.slots.flatMap((s) => {
    if (s.valueType !== "input_image" || !s.fromTask) return [];
    const role = s.fromTask.startsWith("inputs.reference_image") ? "reference_image" : s.fromTask === "inputs.mask" ? "mask" : "source_image";
    return [{ assetId: `comfyui-input:${s.id}.png`, role }];
  });
  return TaskSpec.parse({
    schemaVersion: 1,
    id: "task-roundtrip1",
    revision: 1,
    createdAt: T,
    updatedAt: T,
    intent: "A red bicycle against a white wall.",
    media: { kind: recipe.kind, operation: recipe.operations[0], output: { width: 1024, height: 1024 } },
    inputs,
  });
}

/** A value for each required slot the recipe and the task leave open. */
function bindingsFor(recipe: Recipe): Bindings {
  const out: Bindings = {};
  for (const s of recipe.slots) {
    if (!s.required || s.default !== undefined || s.fromTask !== undefined) continue;
    switch (s.valueType) {
      case "model_file":
        out[s.id] = `${s.id}.safetensors`;
        break;
      case "string":
      case "input_image":
        out[s.id] = `${s.id}.png`;
        break;
      case "enum":
        out[s.id] = s.choices?.[0] ?? "";
        break;
      case "float":
        out[s.id] = s.min !== undefined && s.max !== undefined ? (s.min + s.max) / 2 : 0.5;
        break;
      case "int":
      case "seed":
        out[s.id] = s.min ?? 1;
        break;
    }
  }
  return out;
}

function compiled(recipe: Recipe): ApiGraph {
  const c = compileRecipe(recipe, taskFor(recipe), bindingsFor(recipe));
  if (!c.graph) {
    const failing = c.checks.filter((x) => x.hard && x.verdict === "fail").map((x) => x.message);
    throw new Error(`${recipe.id} doesn't compile: ${failing.join("; ")}`);
  }
  return c.graph;
}

const shipped = loadRecipeDir(SHIPPED_RECIPES_DIR);
const recipes: Recipe[] = [...shipped.recipes.map((r) => r.recipe), fixtureRecipe("t2i-basic"), fixtureRecipe("upscale-model")];

describe("AT-11: the UI graph loads back to the same executable graph", () => {
  it("covers every shipped recipe", () => {
    expect(shipped.errors).toEqual([]);
    expect(shipped.recipes.length).toBeGreaterThanOrEqual(5);
  });

  it.each(recipes.map((r) => [r.id, r] as const))("%s round-trips", (_id, recipe) => {
    const objectInfo = desktopObjectInfo();
    const graph = compiled(recipe);
    const rt = uiRoundTrip(graph, objectInfo);
    // Each difference names its node and input, so a failure here says what changed.
    expect(rt.differences.map((d) => `node ${d.node}${d.input ? `.${d.input}` : ""}: ${d.problem}`)).toEqual([]);
    const ui = exportUiGraph(graph, objectInfo);
    expect(ui.ok).toBe(true);
  });
});

describe("the round trip catches what doesn't survive", () => {
  const recipe = (): Recipe => {
    const r = shipped.recipes.find((x) => x.recipe.id === "recipe-zimage-turbo.t2i")?.recipe;
    if (!r) throw new Error("recipe-zimage-turbo.t2i is not shipped");
    return structuredClone(r);
  };

  it("names a node whose class the schemas lack: it doesn't come back", () => {
    const objectInfo = desktopObjectInfo();
    const graph = compiled(recipe());
    delete objectInfo.ConditioningZeroOut;
    const rt = uiRoundTrip(graph, objectInfo);
    const zero = Object.entries(graph).find(([, n]) => n.class_type === "ConditioningZeroOut")?.[0];
    expect(rt.differences).toEqual(expect.arrayContaining([expect.objectContaining({ node: zero, problem: expect.stringContaining("missing after the round trip") })]));
    const ui = exportUiGraph(graph, objectInfo);
    expect(ui.ok).toBe(false);
    if (!ui.ok) expect(ui.reason).toContain(`node ${zero}`);
  });

  it("names the node and input when a value comes back changed: a sampler the target doesn't offer", () => {
    const objectInfo = desktopObjectInfo();
    const graph = compiled(recipe());
    const sampler = Object.entries(graph).find(([, n]) => n.class_type === "KSampler")?.[0] ?? "";
    graph[sampler].inputs.sampler_name = "res_2s";
    const rt = uiRoundTrip(graph, objectInfo);
    expect(rt.differences).toEqual([expect.objectContaining({ node: sampler, input: "sampler_name", problem: expect.stringContaining('was "res_2s"') })]);
  });

  it("counts an added input as a difference unless it holds the schema's default", () => {
    const objectInfo = desktopObjectInfo();
    const graph = compiled(recipe());
    const loader = Object.entries(graph).find(([, n]) => n.class_type === "CLIPLoader")?.[0] ?? "";
    expect(graph[loader].inputs.device).toBeUndefined();
    expect(uiRoundTrip(graph, objectInfo).differences).toEqual([]);
    // The same input with no default in the schema: the value it comes back with is a change.
    const spec = objectInfo.CLIPLoader.input.optional?.device;
    if (!spec) throw new Error("CLIPLoader has no optional device input in the fixture");
    objectInfo.CLIPLoader.input.optional = { ...objectInfo.CLIPLoader.input.optional, device: ["STRING", {}] };
    expect(uiRoundTrip(graph, objectInfo).differences).toEqual([
      expect.objectContaining({ node: loader, input: "device", problem: expect.stringContaining("was added") }),
    ]);
  });

  it("counts a required input the graph left out as a difference even when it comes back holding the schema's default", () => {
    const objectInfo = desktopObjectInfo();
    const graph = compiled(recipe());
    const unet = Object.entries(graph).find(([, n]) => n.class_type === "UNETLoader")?.[0] ?? "";
    // weight_dtype is required; its first choice, "default", is what it held.
    expect(Object.hasOwn(objectInfo.UNETLoader.input.required ?? {}, "weight_dtype")).toBe(true);
    delete graph[unet].inputs.weight_dtype;
    expect(uiRoundTrip(graph, objectInfo).differences).toEqual([
      expect.objectContaining({ node: unet, input: "weight_dtype", problem: expect.stringContaining("was added") }),
    ]);
  });

  it("ignores _meta, which ComfyUI doesn't execute", () => {
    const objectInfo = desktopObjectInfo();
    const graph = compiled(recipe());
    for (const node of Object.values(graph)) node._meta = { title: "renamed" };
    expect(uiRoundTrip(graph, objectInfo).differences).toEqual([]);
  });
});
