// The shipped recipes (TODO 2.4.4) checked against the node schemas of a real ComfyUI.
//
// The fixture is `/object_info/<class>` of ComfyUI Desktop 0.44.0, stored as returned, for
// exactly the classes the shipped recipes use; so these checks need no running ComfyUI.
// A recipe that uses a new class needs that class added to the fixture from a live install,
// never written by hand.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { SHIPPED_RECIPES_DIR, loadRecipeDir } from "../../services/architect/catalog.js";
import type { Recipe } from "../../services/architect/schemas.js";

/** One input spec: `[type]` or `[type, options]`, where a COMBO's type is its list of choices. */
const InputSpec = z.tuple([z.union([z.string(), z.array(z.string())])]).rest(z.unknown());
const NodeSchema = z
  .object({
    input: z.object({
      required: z.record(z.string(), InputSpec).optional(),
      optional: z.record(z.string(), InputSpec).optional(),
    }),
    output: z.array(z.string()),
  })
  .passthrough();
const ObjectInfo = z.record(z.string(), NodeSchema);
type ObjectInfo = z.infer<typeof ObjectInfo>;

const objectInfo = ObjectInfo.parse(
  JSON.parse(readFileSync(new URL("./fixtures/object-info-desktop-0.44.0.json", import.meta.url), "utf-8")),
);

const NumberOptions = z.object({ min: z.number().optional(), max: z.number().optional() }).passthrough();

function inputSpec(info: ObjectInfo, classType: string, input: string) {
  const schema = info[classType];
  return schema?.input.required?.[input] ?? schema?.input.optional?.[input];
}

/**
 * Every way a recipe can disagree with the node schemas, as readable problems; empty
 * means the recipe fits. Inputs a slot writes are checked through the slot: a model file
 * or an input-folder file name is the target's to list, so the graph's placeholder isn't
 * held to the capture's choices.
 */
function schemaProblems(recipe: Recipe, info: ObjectInfo): string[] {
  const problems: string[] = [];
  const slotted = new Set(recipe.slots.map((s) => `${s.target.node}.${s.target.input}`));

  const classes = new Set(Object.values(recipe.graph).map((n) => n.class_type));
  const declared = new Set(recipe.dependencies.nodeClasses);
  for (const c of classes) if (!declared.has(c)) problems.push(`class ${c} is used but not in dependencies.nodeClasses`);
  for (const c of declared) if (!classes.has(c)) problems.push(`dependencies.nodeClasses names ${c}, which the graph doesn't use`);

  for (const [id, node] of Object.entries(recipe.graph)) {
    const schema = info[node.class_type];
    if (!schema) {
      problems.push(`node ${id}: class ${node.class_type} is not in the schema`);
      continue;
    }
    for (const name of Object.keys(schema.input.required ?? {})) {
      if (!(name in node.inputs)) problems.push(`node ${id}: required input ${name} is missing`);
    }
    for (const [name, value] of Object.entries(node.inputs)) {
      const spec = inputSpec(info, node.class_type, name);
      if (!spec) {
        problems.push(`node ${id}: ${node.class_type} has no input ${name}`);
        continue;
      }
      const [type, rawOptions] = spec;
      if (Array.isArray(value)) {
        const [source, index] = value;
        const from = recipe.graph[source];
        const produced = from ? info[from.class_type]?.output[index] : undefined;
        if (produced === undefined) problems.push(`node ${id}.${name}: link to ${source}[${index}] names no output`);
        else if (produced !== type) problems.push(`node ${id}.${name}: expects ${String(type)}, linked to ${produced}`);
        continue;
      }
      if (Array.isArray(type)) {
        if (!slotted.has(`${id}.${name}`) && !type.includes(String(value))) {
          problems.push(`node ${id}.${name}: "${String(value)}" is not one of its choices`);
        }
        continue;
      }
      if (type === "INT" || type === "FLOAT") {
        const opts = NumberOptions.safeParse(rawOptions ?? {});
        if (typeof value !== "number") problems.push(`node ${id}.${name}: ${type} input holds ${typeof value}`);
        else if (type === "INT" && !Number.isInteger(value)) problems.push(`node ${id}.${name}: INT input holds ${value}`);
        else if (opts.success && ((opts.data.min !== undefined && value < opts.data.min) || (opts.data.max !== undefined && value > opts.data.max))) {
          problems.push(`node ${id}.${name}: ${value} is outside the schema's bounds`);
        }
      } else if (type === "STRING" && typeof value !== "string") {
        problems.push(`node ${id}.${name}: STRING input holds ${typeof value}`);
      } else if (type === "BOOLEAN" && typeof value !== "boolean") {
        problems.push(`node ${id}.${name}: BOOLEAN input holds ${typeof value}`);
      }
    }
  }

  for (const slot of recipe.slots) {
    const node = recipe.graph[slot.target.node];
    const spec = node ? inputSpec(info, node.class_type, slot.target.input) : undefined;
    if (!node || !spec) {
      problems.push(`slot ${slot.id}: ${node?.class_type ?? slot.target.node} has no input ${slot.target.input}`);
      continue;
    }
    const [type, rawOptions] = spec;
    if (slot.valueType === "model_file" && !Array.isArray(type)) problems.push(`slot ${slot.id}: model_file slot writes a ${type} input`);
    if (slot.valueType === "enum") {
      const bad = (slot.choices ?? []).filter((c) => !Array.isArray(type) || !type.includes(c));
      if (bad.length > 0) problems.push(`slot ${slot.id}: choices ${bad.join(", ")} aren't in the schema`);
    }
    if (slot.valueType === "int" || slot.valueType === "float" || slot.valueType === "seed") {
      const expected = slot.valueType === "float" ? "FLOAT" : "INT";
      if (type !== expected) {
        problems.push(`slot ${slot.id}: ${slot.valueType} slot writes a ${String(type)} input`);
        continue;
      }
      const opts = NumberOptions.parse(rawOptions ?? {});
      if (slot.min !== undefined && opts.min !== undefined && slot.min < opts.min) problems.push(`slot ${slot.id}: min below the schema's`);
      if (slot.max !== undefined && opts.max !== undefined && slot.max > opts.max) problems.push(`slot ${slot.id}: max above the schema's`);
    }
  }

  for (const output of recipe.outputs) {
    if (recipe.graph[output.node]?.class_type !== "SaveImage") problems.push(`output ${output.role} is not a SaveImage node`);
  }
  return problems;
}

const loaded = loadRecipeDir(SHIPPED_RECIPES_DIR);
const byId = new Map(loaded.recipes.map((r) => [r.recipe.id, r.recipe]));

function shipped(id: string): Recipe {
  const recipe = byId.get(id);
  if (!recipe) throw new Error(`${id} is not shipped`);
  return structuredClone(recipe);
}

describe("shipped recipes", () => {
  it("loads the three first recipes with no errors", () => {
    expect(loaded.dirFound).toBe(true);
    expect(loaded.errors).toEqual([]);
    expect([...byId.keys()].sort()).toEqual([
      "recipe-flux1-schnell.t2i",
      "recipe-zimage-turbo.img2img",
      "recipe-zimage-turbo.t2i",
    ]);
  });

  it("ships every recipe as proposed: an agent wrote them and the owner hasn't reviewed them (spec §8.4)", () => {
    for (const { recipe } of loaded.recipes) expect(recipe.certification, recipe.id).toBe("proposed");
  });

  it("names the operation each recipe solves", () => {
    expect(shipped("recipe-zimage-turbo.t2i").operations).toEqual(["text_to_image"]);
    expect(shipped("recipe-flux1-schnell.t2i").operations).toEqual(["text_to_image"]);
    expect(shipped("recipe-zimage-turbo.img2img").operations).toEqual(["image_edit"]);
  });

  it.each(["recipe-zimage-turbo.t2i", "recipe-flux1-schnell.t2i", "recipe-zimage-turbo.img2img"])(
    "%s fits the node schemas of ComfyUI Desktop 0.44.0",
    (id) => {
      expect(schemaProblems(shipped(id), objectInfo)).toEqual([]);
    },
  );

  it("cites an upstream skill and the live schema check for every recipe", () => {
    for (const { recipe } of loaded.recipes) {
      const kinds = recipe.evidence.map((e) => e.kind);
      expect(kinds, recipe.id).toContain("upstream_pack");
      expect(recipe.evidence.some((e) => e.kind === "documentation" && e.source.includes("/object_info")), recipe.id).toBe(true);
    }
  });

  it("gives every model slot a folder and a family, and fills width and height from the task", () => {
    for (const { recipe } of loaded.recipes) {
      for (const slot of recipe.slots.filter((s) => s.valueType === "model_file")) {
        expect(slot.modelFolder, `${recipe.id}.${slot.id}`).toBeTruthy();
        expect(slot.modelFamily, `${recipe.id}.${slot.id}`).toBeTruthy();
      }
      const fromTask = recipe.slots.flatMap((s) => (s.fromTask ? [s.fromTask] : []));
      if (recipe.operations.includes("text_to_image")) {
        expect(fromTask.sort(), recipe.id).toEqual(["media.output.height", "media.output.width"]);
      }
    }
  });

  it("leaves the img2img denoise and source image to the caller", () => {
    const slots = new Map(shipped("recipe-zimage-turbo.img2img").slots.map((s) => [s.id, s]));
    expect(slots.get("denoise")).toMatchObject({ valueType: "float", required: true, min: 0, max: 1 });
    expect(slots.get("denoise")?.default).toBeUndefined();
    expect(slots.get("source_image")).toMatchObject({ valueType: "string", required: true, target: { input: "image" } });
    expect(slots.get("source_image")?.default).toBeUndefined();
  });
});

describe("the schema check catches what a recipe gets wrong", () => {
  it("flags a class the schema doesn't know", () => {
    const r = shipped("recipe-zimage-turbo.t2i");
    r.graph["6"] = { ...r.graph["6"], class_type: "EmptyZImageLatent" };
    expect(schemaProblems(r, objectInfo)).toEqual(
      expect.arrayContaining([expect.stringContaining("class EmptyZImageLatent is not in the schema")]),
    );
  });

  it("flags an input name the class doesn't have", () => {
    const r = shipped("recipe-flux1-schnell.t2i");
    r.graph["7"].inputs.guidance = 3.5;
    expect(schemaProblems(r, objectInfo)).toEqual([expect.stringContaining("KSampler has no input guidance")]);
  });

  it("flags a COMBO value outside the choices, such as a sampler from a custom node pack", () => {
    const r = shipped("recipe-zimage-turbo.t2i");
    r.graph["7"].inputs.sampler_name = "res_2s";
    expect(schemaProblems(r, objectInfo)).toEqual([expect.stringContaining('"res_2s" is not one of its choices')]);
  });

  it("flags a missing required input and a link of the wrong type", () => {
    const r = shipped("recipe-zimage-turbo.img2img");
    delete r.graph["8"].inputs.scheduler;
    r.graph["7"].inputs.pixels = ["3", 0];
    const problems = schemaProblems(r, objectInfo);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("required input scheduler is missing"),
        expect.stringContaining("expects IMAGE, linked to VAE"),
      ]),
    );
  });

  it("flags a slot that targets an input its node doesn't have, and bounds wider than the schema's", () => {
    const r = shipped("recipe-zimage-turbo.img2img");
    r.slots = r.slots.map((s) =>
      s.id === "seed" ? { ...s, target: { ...s.target, input: "noise_seed" } } : s.id === "denoise" ? { ...s, max: 2 } : s,
    );
    expect(schemaProblems(r, objectInfo)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("slot seed: KSampler has no input noise_seed"),
        expect.stringContaining("slot denoise: max above the schema's"),
      ]),
    );
  });

  it("flags a class missing from dependencies.nodeClasses", () => {
    const r = shipped("recipe-flux1-schnell.t2i");
    r.dependencies.nodeClasses = r.dependencies.nodeClasses.filter((c) => c !== "VAEDecode");
    expect(schemaProblems(r, objectInfo)).toEqual([expect.stringContaining("class VAEDecode is used but not in dependencies.nodeClasses")]);
  });

  it("holds an unslotted COMBO to the choices but lets a model slot's placeholder through", () => {
    const r = shipped("recipe-flux1-schnell.t2i");
    // clip_name1 is a model_file slot: t5xxl_fp8_e4m3fn.safetensors isn't installed on the
    // capture's machine; the validator reports that, and the schema check leaves it alone.
    expect(r.graph["2"].inputs.clip_name1).toBe("t5xxl_fp8_e4m3fn.safetensors");
    r.graph["2"].inputs.type = "flux1";
    expect(schemaProblems(r, objectInfo)).toEqual([expect.stringContaining('"flux1" is not one of its choices')]);
  });
});
