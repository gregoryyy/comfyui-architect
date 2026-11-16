// The shipped recipes (TODO 2.4.4) checked against the node schemas of a real ComfyUI.
//
// The fixture is `/object_info/<class>` of ComfyUI Desktop 0.44.0, stored as returned, for
// exactly the classes the shipped recipes use; so these checks need no running ComfyUI.
// A recipe that uses a new class needs that class added to the fixture from a live install,
// never written by hand.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ObjectInfo as ComfyObjectInfo } from "../../comfyui/types.js";
import { SHIPPED_RECIPES_DIR, loadRecipeDir } from "../../services/architect/catalog.js";
import { compileRecipe } from "../../services/architect/compile.js";
import { candidateStatus } from "../../services/architect/planner.js";
import { EnvironmentSnapshot, type Recipe, TaskSpec } from "../../services/architect/schemas.js";
import { validateGraph } from "../../services/architect/validate.js";

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
const ComboOptions = z.object({ options: z.array(z.string()) }).passthrough();

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
      if (Array.isArray(type) || type === "COMBO") {
        // A classic COMBO lists its choices as the type, a V3 one in `options`.
        const choices = Array.isArray(type) ? type : ComboOptions.safeParse(rawOptions ?? {}).data?.options;
        if (!slotted.has(`${id}.${name}`) && (choices === undefined || !choices.includes(String(value)))) {
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
    // A loader's file list is a classic COMBO (the choices as the type) or a V3 one ("COMBO").
    if (slot.valueType === "model_file" && !Array.isArray(type) && type !== "COMBO") {
      problems.push(`slot ${slot.id}: model_file slot writes a ${type} input`);
    }
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

/** Every shipped recipe: the five of milestones 2 to 4 and the eleven of GAPS Q24's set (TODO 5.4). */
const SHIPPED_IDS = [
  "recipe-flux1-schnell.ckpt-img2img",
  "recipe-flux1-schnell.ckpt-inpaint",
  "recipe-flux1-schnell.ckpt-t2i",
  "recipe-flux1-schnell.t2i",
  "recipe-flux2-klein-4b.edit",
  "recipe-flux2-klein-4b.masked-edit",
  "recipe-flux2-klein-4b.reference",
  "recipe-realesrgan.upscale-2x",
  "recipe-realesrgan.upscale-4x",
  "recipe-seedvr2-3b.upscale",
  "recipe-zimage-turbo.controlnet-union",
  "recipe-zimage-turbo.img2img",
  "recipe-zimage-turbo.inpaint",
  "recipe-zimage-turbo.t2i",
  "recipe-zimage-turbo.t2i-upscale2x",
  "recipe-zimage-turbo.upscale-2k",
];
const byId = new Map(loaded.recipes.map((r) => [r.recipe.id, r.recipe]));

function shipped(id: string): Recipe {
  const recipe = byId.get(id);
  if (!recipe) throw new Error(`${id} is not shipped`);
  return structuredClone(recipe);
}

describe("shipped recipes", () => {
  it("loads the shipped recipes with no errors", () => {
    expect(loaded.dirFound).toBe(true);
    expect(loaded.errors).toEqual([]);
    expect([...byId.keys()].sort()).toEqual(SHIPPED_IDS);
  });

  it("ships a recipe as curated only with the owner's review on record, else as proposed (spec §8.4)", () => {
    for (const { recipe } of loaded.recipes) {
      // A review covers the revision it looked at (EvidenceRef.revision).
      const reviewed = recipe.evidence.some((e) => e.kind === "maintainer_review" && e.revision === recipe.revision);
      expect(recipe.certification, recipe.id).toBe(reviewed ? "curated" : "proposed");
    }
    expect(shipped("recipe-flux1-schnell.ckpt-t2i").certification).toBe("proposed");
    // Reviewed at revision 3; revision 4 added pinned sources, so it waits for a new review.
    expect(shipped("recipe-zimage-turbo.t2i")).toMatchObject({ revision: 5, certification: "proposed" });
    expect(shipped("recipe-flux1-schnell.t2i").certification).toBe("curated");
    expect(shipped("recipe-zimage-turbo.t2i-upscale2x").certification).toBe("proposed");
    // The img2img recipe changed in revision 5 (an input_image slot) after its review.
    expect(shipped("recipe-zimage-turbo.img2img")).toMatchObject({ revision: 5, certification: "proposed" });
    for (const id of SHIPPED_IDS.filter((i) => i !== "recipe-flux1-schnell.t2i")) {
      expect(shipped(id).certification, id).toBe("proposed");
    }
  });

  it("starts each recipe new in this milestone at revision 1 and cites the template it was built from, by name and hash", () => {
    const fromTemplate: Record<string, string[]> = {
      "recipe-zimage-turbo.controlnet-union": ["image_z_image_turbo_fun_union_controlnet"],
      "recipe-zimage-turbo.upscale-2k": ["utility_z_image_turbo_2k_upscaler.app"],
      "recipe-flux1-schnell.ckpt-img2img": ["flux_schnell"],
      "recipe-flux1-schnell.ckpt-inpaint": ["flux_schnell"],
      "recipe-flux2-klein-4b.edit": ["image_flux2_klein_image_edit_4b_distilled", "image_flux2_klein_text_to_image"],
      "recipe-flux2-klein-4b.reference": ["image_flux2_klein_image_edit_4b_distilled", "image_flux2_klein_text_to_image"],
      "recipe-flux2-klein-4b.masked-edit": ["image_flux2_klein_image_edit_4b_distilled"],
      "recipe-seedvr2-3b.upscale": ["utility_seedvr2_3b_int8_upscale_image"],
    };
    for (const [id, templates] of Object.entries(fromTemplate)) {
      const r = shipped(id);
      expect(r.revision, id).toBe(1);
      for (const t of templates) {
        const cited = r.evidence.find((e) => e.kind === "documentation" && e.source.startsWith(`ComfyUI workflow template ${t} `));
        expect(cited?.source, `${id} cites ${t}`).toMatch(/sha256 [0-9a-f]{64}\)$/);
      }
      // An agent wrote these: no maintainer review is claimed.
      expect(r.evidence.some((e) => e.kind === "maintainer_review"), id).toBe(false);
    }
  });

  it("names the operation each recipe solves", () => {
    expect(shipped("recipe-zimage-turbo.t2i").operations).toEqual(["text_to_image"]);
    expect(shipped("recipe-flux1-schnell.t2i").operations).toEqual(["text_to_image"]);
    expect(shipped("recipe-flux1-schnell.ckpt-t2i").operations).toEqual(["text_to_image"]);
    expect(shipped("recipe-zimage-turbo.img2img").operations).toEqual(["image_edit"]);
    expect(shipped("recipe-zimage-turbo.t2i-upscale2x").operations).toEqual(["text_to_image"]);
    const ops: Record<string, string> = {
      "recipe-zimage-turbo.inpaint": "inpaint",
      "recipe-zimage-turbo.controlnet-union": "reference_guided",
      "recipe-zimage-turbo.upscale-2k": "upscale",
      "recipe-flux1-schnell.ckpt-img2img": "image_edit",
      "recipe-flux1-schnell.ckpt-inpaint": "inpaint",
      "recipe-flux2-klein-4b.edit": "image_edit",
      "recipe-flux2-klein-4b.reference": "reference_guided",
      "recipe-flux2-klein-4b.masked-edit": "inpaint",
      "recipe-realesrgan.upscale-4x": "upscale",
      "recipe-realesrgan.upscale-2x": "upscale",
      "recipe-seedvr2-3b.upscale": "upscale",
    };
    for (const [id, op] of Object.entries(ops)) expect(shipped(id).operations, id).toEqual([op]);
  });

  it.each(SHIPPED_IDS)(
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
      // A prompt slot always fills from the task's intent, so planning can compile without
      // an agent-supplied binding; the upscalers have no prompt slot. Text to image also
      // takes its size from the task.
      if (recipe.slots.some((s) => s.id === "prompt")) expect(fromTask, recipe.id).toContain("intent");
      else expect(recipe.operations, recipe.id).toEqual(["upscale"]);
      if (recipe.operations.includes("text_to_image")) {
        expect(fromTask.sort(), recipe.id).toEqual(["intent", "media.output.height", "media.output.width"]);
      }
    }
  });

  it("leaves the img2img denoise and source image to the caller", () => {
    const slots = new Map(shipped("recipe-zimage-turbo.img2img").slots.map((s) => [s.id, s]));
    expect(slots.get("denoise")).toMatchObject({ valueType: "float", required: true, min: 0, max: 1 });
    expect(slots.get("denoise")?.default).toBeUndefined();
    expect(slots.get("source_image")).toMatchObject({ valueType: "input_image", required: true, target: { input: "image" }, fromTask: "inputs.source_image" });
    expect(slots.get("source_image")?.default).toBeUndefined();
    // The output has the source's size: the task's width and height are checked against it.
    expect(shipped("recipe-zimage-turbo.img2img").outputs[0].scaleOfInput).toEqual({ input: "inputs.source_image", factor: 1, multipleOf: 8 });
  });

  it("declares each image-taking recipe's output size from an input or from the task, never both", () => {
    const rule: Record<string, string> = {
      "recipe-zimage-turbo.img2img": "x1 of inputs.source_image",
      "recipe-zimage-turbo.inpaint": "x1 of inputs.source_image",
      "recipe-zimage-turbo.controlnet-union": "x1 of inputs.reference_image.1",
      "recipe-zimage-turbo.upscale-2k": "x2 of inputs.source_image",
      "recipe-flux1-schnell.ckpt-img2img": "x1 of inputs.source_image",
      "recipe-flux1-schnell.ckpt-inpaint": "x1 of inputs.source_image",
      "recipe-flux2-klein-4b.edit": "task, scales inputs.source_image",
      "recipe-flux2-klein-4b.reference": "task",
      "recipe-flux2-klein-4b.masked-edit": "task, scales inputs.source_image",
      "recipe-realesrgan.upscale-4x": "x4 of inputs.source_image",
      "recipe-realesrgan.upscale-2x": "x2 of inputs.source_image",
      "recipe-seedvr2-3b.upscale": "x4 of inputs.source_image",
    };
    for (const [id, want] of Object.entries(rule)) {
      const r = shipped(id);
      const o = r.outputs[0];
      const fromTask = r.slots.some((s) => s.fromTask === "media.output.width");
      const got = o.scaleOfInput
        ? `x${o.scaleOfInput.factor} of ${o.scaleOfInput.input}`
        : `task${o.scalesInputToTask ? `, scales ${o.scalesInputToTask}` : ""}`;
      expect(got, id).toBe(want);
      expect(fromTask, id).toBe(o.scaleOfInput === undefined);
    }
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

describe("pinned model sources and the 2x upscale recipe (TODO 4.3)", () => {
  /** The capture as the validator reads it, a fresh copy per test. */
  function liveSchemas(): ComfyObjectInfo {
    const parsed: ComfyObjectInfo = JSON.parse(
      readFileSync(new URL("./fixtures/object-info-desktop-0.44.0.json", import.meta.url), "utf-8"),
    );
    return parsed;
  }
  const T = "2026-11-16T03:00:00.000Z";
  const task = TaskSpec.parse({
    schemaVersion: 1,
    id: "task-up1",
    revision: 1,
    createdAt: T,
    updatedAt: T,
    intent: "A lighthouse at dusk.",
    media: { kind: "image", operation: "text_to_image", output: { width: 1024, height: 768 } },
  });
  function snapshot(upscaleModels: string[]) {
    return EnvironmentSnapshot.parse({
      schemaVersion: 1,
      id: "env-up1",
      capturedAt: T,
      target: { baseUrl: "http://127.0.0.1:8188" },
      installedModels: {
        folders: {
          diffusion_models: ["z_image_turbo_bf16.safetensors"],
          text_encoders: ["qwen_3_4b.safetensors"],
          vae: ["ae.safetensors"],
          upscale_models: upscaleModels,
        },
        unanswered: [],
        absent: [],
      },
      probeErrors: [],
    });
  }

  it("pins each source of a recipe that pins any to a model slot's folder and default file", () => {
    const pinning = SHIPPED_IDS.filter((id) => (shipped(id).modelSources ?? []).length > 0);
    // Every recipe but the two FLUX.1-schnell ones of milestone 2, written before pins.
    expect(pinning.length).toBe(SHIPPED_IDS.length - 2);
    for (const id of pinning) {
      const r = shipped(id);
      const defaults = r.slots.filter((s) => s.valueType === "model_file").map((s) => `${s.modelFolder}/${String(s.default)}`);
      const pinned = (r.modelSources ?? []).map((m) => `${m.folder}/${m.file}`);
      expect(pinned.sort(), id).toEqual(defaults.sort());
      for (const m of r.modelSources ?? []) {
        expect(m.source.path.endsWith(".safetensors"), `${id} ${m.file}`).toBe(true);
        expect(m.source.path.split("/").pop(), `${id} ${m.file}`).toBe(m.file);
      }
    }
  });

  it("binds bf16 or fp16 files, except the installed fp8 FLUX.1-schnell checkpoint (ARCH 2026-11-16, precision)", () => {
    for (const id of SHIPPED_IDS) {
      for (const s of shipped(id).slots.filter((x) => x.valueType === "model_file")) {
        const file = String(s.default);
        if (file === "flux1-schnell-fp8.safetensors" || file === "t5xxl_fp8_e4m3fn.safetensors") continue;
        expect(file, `${id}.${s.id}`).not.toMatch(/fp8|int8|nvfp4|gguf/i);
      }
    }
    const pinned = SHIPPED_IDS.flatMap((id) => (shipped(id).modelSources ?? []).map((m) => m.file));
    expect(pinned).toEqual(expect.arrayContaining(["flux-2-klein-4b.safetensors", "flux2-vae.safetensors", "seedvr2_3b_fp16.safetensors", "seedvr2_ema_vae_fp16.safetensors", "Z-Image-Turbo-Fun-Controlnet-Union.safetensors"]));
  });

  it("generates at half the task's size and saves through the 4x model and a 0.5 scale", () => {
    const r = shipped("recipe-zimage-turbo.t2i-upscale2x");
    const compiled = compileRecipe(r, task, {});
    expect(compiled.checks.filter((c) => c.verdict === "fail")).toEqual([]);
    expect(compiled.graph?.["6"].inputs).toMatchObject({ width: 512, height: 384 });
    expect(compiled.graph?.["9"].inputs.model_name).toBe("RealESRGAN_x4plus.safetensors");
    expect(compiled.graph?.["11"].inputs).toMatchObject({ upscale_method: "lanczos", scale_by: 0.5, image: ["10", 0] });
    expect(compiled.graph?.["12"].inputs.images).toEqual(["11", 0]);
  });

  it("refuses a task size the divisor doesn't divide", () => {
    const odd = TaskSpec.parse({ ...task, media: { ...task.media, output: { ...task.media.output, width: 1025 } } });
    const compiled = compileRecipe(shipped("recipe-zimage-turbo.t2i-upscale2x"), odd, {});
    expect(compiled.graph).toBeUndefined();
    expect(compiled.checks.find((c) => c.id === "contract.slot.width")?.message).toMatch(/isn't divisible by 2/);
  });

  it("is acquirable against the capture when only the upscale model is missing, and feasible once it's offered", () => {
    const r = shipped("recipe-zimage-turbo.t2i-upscale2x");
    const missing = validateGraph({ recipe: r, task, bindings: {}, objectInfo: liveSchemas(), snapshot: snapshot([]) });
    const failing = missing.report.checks.filter((c) => c.hard && c.verdict !== "pass" && c.verdict !== "not_applicable");
    expect(failing.map((c) => c.id).sort()).toEqual(["dependencies.model.upscale_model", "native_types.combo.9.model_name"]);
    const status = candidateStatus({ recipe: r, task, report: missing.report, bindings: { upscale_model: "RealESRGAN_x4plus.safetensors" }, snapshot: snapshot([]) });
    expect(status.status).toBe("acquirable");
    expect(status.acquisition?.files.map((f) => [f.folder, f.file, f.source.repo])).toEqual([
      ["upscale_models", "RealESRGAN_x4plus.safetensors", "Comfy-Org/Real-ESRGAN"],
    ]);

    const schemas = liveSchemas();
    schemas.UpscaleModelLoader.input = { required: { model_name: ["COMBO", { options: ["RealESRGAN_x4plus.safetensors"] }] } };
    const present = validateGraph({ recipe: r, task, bindings: {}, objectInfo: schemas, snapshot: snapshot(["RealESRGAN_x4plus.safetensors"]) });
    expect(present.report.overall).toBe("pass");
  });
});
