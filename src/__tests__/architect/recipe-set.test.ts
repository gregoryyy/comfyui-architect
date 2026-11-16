// The recipe set of GAPS Q24 (TODO 5.4) against the captured node schemas of ComfyUI
// Desktop 0.44.0 and fixture snapshots: each recipe compiles and validates for a task that
// fits its operation and size rule; with its pinned files missing it is acquirable, and with
// them listed and offered by the loaders it is feasible. A task size that doesn't fit the
// recipe's size rule fails, naming both sizes. Input sizes are given as data, as planning
// reads them from the target (output-size.ts).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { NodeInputSpec, ObjectInfo } from "../../comfyui/types.js";
import { SHIPPED_RECIPES_DIR, loadRecipeDir } from "../../services/architect/catalog.js";
import { compileRecipe } from "../../services/architect/compile.js";
import type { InputDimensions } from "../../services/architect/output-size.js";
import { candidateStatus } from "../../services/architect/planner.js";
import { EnvironmentSnapshot, Recipe, TaskSpec, type TaskInput } from "../../services/architect/schemas.js";
import { validateGraph } from "../../services/architect/validate.js";

const T = "2026-11-16T10:00:00.000Z";

function capture(): ObjectInfo {
  const parsed: ObjectInfo = JSON.parse(readFileSync(new URL("./fixtures/object-info-desktop-0.44.0.json", import.meta.url), "utf-8"));
  return parsed;
}

const shipped = new Map(loadRecipeDir(SHIPPED_RECIPES_DIR).recipes.map((r) => [r.recipe.id, r.recipe]));
function recipe(id: string): Recipe {
  const r = shipped.get(id);
  if (!r) throw new Error(`${id} is not shipped`);
  return r;
}

/** The capture's input-folder sample files (GAPS Q19) and their sizes, as the target serves them. */
const SIZES = new Map<string, InputDimensions>([
  ["blue_poppies_field.png", { ok: true, width: 1024, height: 1024, sizeBytes: 1 }],
  ["egyptian_queen.png", { ok: true, width: 2912, height: 1632, sizeBytes: 1 }],
  ["medusa_poster.png", { ok: true, width: 1024, height: 1024, sizeBytes: 1 }],
]);

const src = (name: string): TaskInput => ({ assetId: `comfyui-input:${name}`, role: "source_image" });
const ref = (name: string): TaskInput => ({ assetId: `comfyui-input:${name}`, role: "reference_image" });
const mask = (name: string): TaskInput => ({ assetId: `comfyui-input:${name}`, role: "mask" });

/** Per recipe: a task that fits it, a size that doesn't, and bindings its open slots need. */
const CASES: Record<string, { operation: string; size: [number, number]; wrong: [number, number]; inputs: TaskInput[]; bindings?: Record<string, number> }> = {
  "recipe-zimage-turbo.img2img": { operation: "image_edit", size: [1024, 1024], wrong: [1024, 768], inputs: [src("blue_poppies_field.png")], bindings: { denoise: 0.6 } },
  "recipe-zimage-turbo.inpaint": { operation: "inpaint", size: [1024, 1024], wrong: [2048, 2048], inputs: [src("blue_poppies_field.png"), mask("medusa_poster.png")] },
  "recipe-zimage-turbo.controlnet-union": { operation: "reference_guided", size: [2912, 1632], wrong: [1024, 1024], inputs: [ref("egyptian_queen.png")] },
  "recipe-zimage-turbo.upscale-2k": { operation: "upscale", size: [2048, 2048], wrong: [1024, 1024], inputs: [src("blue_poppies_field.png")] },
  "recipe-flux1-schnell.ckpt-img2img": { operation: "image_edit", size: [1024, 1024], wrong: [768, 1024], inputs: [src("blue_poppies_field.png")], bindings: { denoise: 0.6 } },
  "recipe-flux1-schnell.ckpt-inpaint": { operation: "inpaint", size: [1024, 1024], wrong: [1024, 1000], inputs: [src("blue_poppies_field.png"), mask("medusa_poster.png")] },
  "recipe-realesrgan.upscale-4x": { operation: "upscale", size: [4096, 4096], wrong: [2048, 2048], inputs: [src("blue_poppies_field.png")] },
  "recipe-realesrgan.upscale-2x": { operation: "upscale", size: [2048, 2048], wrong: [4096, 4096], inputs: [src("blue_poppies_field.png")] },
  "recipe-seedvr2-3b.upscale": { operation: "upscale", size: [4096, 4096], wrong: [2048, 2048], inputs: [src("blue_poppies_field.png")] },
  // Size from the task: any size fits; the aspect check is soft.
  "recipe-flux2-klein-4b.edit": { operation: "image_edit", size: [1456, 816], wrong: [1024, 1024], inputs: [src("egyptian_queen.png")] },
  "recipe-flux2-klein-4b.masked-edit": { operation: "inpaint", size: [1024, 1024], wrong: [1456, 816], inputs: [src("blue_poppies_field.png"), mask("medusa_poster.png")] },
  "recipe-flux2-klein-4b.reference": { operation: "reference_guided", size: [1024, 1024], wrong: [1024, 1024], inputs: [ref("blue_poppies_field.png"), ref("medusa_poster.png")] },
};

function taskFor(id: string, size?: [number, number], inputs?: TaskInput[]): TaskSpec {
  const c = CASES[id];
  const [width, height] = size ?? c.size;
  return TaskSpec.parse({
    schemaVersion: 1,
    id: "task-set1",
    revision: 1,
    createdAt: T,
    updatedAt: T,
    intent: "A field of blue poppies under a stormy sky.",
    media: { kind: "image", operation: c.operation, output: { width, height } },
    inputs: inputs ?? c.inputs,
  });
}

/** Every model file the recipe's slots default to, by folder. */
function defaults(r: Recipe): Record<string, string[]> {
  const out: Record<string, string[]> = { checkpoints: [], diffusion_models: [], text_encoders: [], vae: [], upscale_models: [], model_patches: [] };
  for (const s of r.slots.filter((x) => x.valueType === "model_file")) (out[s.modelFolder ?? ""] ??= []).push(String(s.default));
  return out;
}

function snapshot(folders: Record<string, string[]>): EnvironmentSnapshot {
  return EnvironmentSnapshot.parse({
    schemaVersion: 1,
    id: "env-set1",
    capturedAt: T,
    target: { baseUrl: "http://127.0.0.1:8188" },
    installedModels: { folders, unanswered: [], absent: [] },
    probeErrors: [],
  });
}

/** The capture with each model slot's loader offering the recipe's file, as after placement. */
function offering(r: Recipe): ObjectInfo {
  const info = capture();
  for (const s of r.slots.filter((x) => x.valueType === "model_file")) {
    const def = info[r.graph[s.target.node].class_type];
    const required = def.input?.required ?? {};
    const spec: NodeInputSpec | undefined = required[s.target.input];
    const file = String(s.default);
    const choices = spec && Array.isArray(spec[0]) ? spec[0] : [];
    required[s.target.input] = [[...choices.filter((c) => c !== file), file]];
  }
  return info;
}

const failing = (checks: readonly { hard: boolean; verdict: string; id: string }[]) => checks.filter((c) => c.hard && c.verdict === "fail").map((c) => c.id).sort();

describe("the recipe set against the capture", () => {
  it("covers every recipe that takes an input image", () => {
    const taking = [...shipped.values()].filter((r) => r.slots.some((s) => s.valueType === "input_image")).map((r) => r.id).sort();
    expect(Object.keys(CASES).sort()).toEqual(taking);
  });

  it.each(Object.keys(CASES))("%s compiles for its task and is feasible with its files listed and offered", (id) => {
    const r = recipe(id);
    const t = taskFor(id);
    const bindings = CASES[id].bindings ?? {};
    const compiled = compileRecipe(r, t, bindings);
    expect(compiled.checks.filter((c) => c.verdict === "fail")).toEqual([]);
    expect(compiled.graph).toBeDefined();
    const out = validateGraph({ recipe: r, task: t, bindings, objectInfo: offering(r), snapshot: snapshot(defaults(r)), inputSizes: SIZES });
    const blocking = out.report.checks.filter((c) => c.hard && c.verdict !== "pass" && c.verdict !== "not_applicable");
    expect(blocking.map((c) => `${c.id}: ${c.message}`)).toEqual([]);
    expect(out.report.overall).toBe("pass");
    // The soft checks a feasible candidate may carry: the family of a default file not yet
    // observed (GAPS Q14), and a stretch when the aspect ratios differ.
    for (const c of out.report.checks.filter((x) => !x.hard && (x.verdict === "unknown" || x.verdict === "fail"))) {
      expect(c.id, c.message).toMatch(/^semantic_types\.model_family\.|^contract\.mask_channels$/);
    }
  });

  it.each(Object.keys(CASES))("%s is acquirable with its pinned files missing, for exactly those files", (id) => {
    const r = recipe(id);
    const t = taskFor(id);
    const bindings = CASES[id].bindings ?? {};
    const empty = Object.fromEntries(Object.keys(defaults(r)).map((f) => [f, []]));
    const out = validateGraph({ recipe: r, task: t, bindings, objectInfo: capture(), snapshot: snapshot(empty), inputSizes: SIZES });
    const modelSlots = r.slots.filter((s) => s.valueType === "model_file");
    const bound = { ...Object.fromEntries(modelSlots.map((s) => [s.id, String(s.default)])), ...bindings };
    const status = candidateStatus({ recipe: r, task: t, report: out.report, bindings: bound, snapshot: snapshot(empty) });
    expect(status.refusals).toEqual([]);
    expect(status.status).toBe("acquirable");
    expect(status.acquisition?.files.map((f) => `${f.folder}/${f.file}`).sort()).toEqual(modelSlots.map((s) => `${s.modelFolder}/${String(s.default)}`).sort());
    for (const f of status.acquisition?.files ?? []) expect(f.source.revision, f.file).toMatch(/^[0-9a-f]{40}$/);
  });

  it.each(Object.keys(CASES).filter((id) => recipe(id).outputs[0].scaleOfInput !== undefined))(
    "%s fails a task size other than its input times its factor, naming both sizes",
    (id) => {
      const r = recipe(id);
      const [w, h] = CASES[id].wrong;
      const out = validateGraph({ recipe: r, task: taskFor(id, [w, h]), bindings: CASES[id].bindings ?? {}, objectInfo: offering(r), snapshot: snapshot(defaults(r)), inputSizes: SIZES });
      expect(out.report.overall).toBe("fail");
      const size = out.report.checks.filter((c) => c.id === "contract.task.width" || c.id === "contract.task.height");
      const failed = size.filter((c) => c.verdict === "fail");
      expect(failed.length).toBeGreaterThan(0);
      for (const c of failed) {
        expect(c.hard).toBe(true);
        expect(c.message).toContain(`${w}×${h}`);
        expect(c.message).toMatch(/\d+×\d+\)/);
      }
    },
  );

  it.each(Object.keys(CASES).filter((id) => recipe(id).outputs[0].scaleOfInput !== undefined))(
    "%s stays diagnostic when the input's size wasn't read",
    (id) => {
      const r = recipe(id);
      const out = validateGraph({ recipe: r, task: taskFor(id), bindings: CASES[id].bindings ?? {}, objectInfo: offering(r), snapshot: snapshot(defaults(r)) });
      expect(out.report.overall).toBe("unknown");
      expect(out.report.checks.find((c) => c.id === "contract.task.width")).toMatchObject({ verdict: "unknown", hard: true });
    },
  );

  it("refuses a source whose sides the VAE would crop, for the recipes that encode the source as it is", () => {
    const odd = new Map(SIZES);
    odd.set("blue_poppies_field.png", { ok: true, width: 1020, height: 1024, sizeBytes: 1 });
    for (const id of ["recipe-zimage-turbo.img2img", "recipe-flux1-schnell.ckpt-img2img"]) {
      const r = recipe(id);
      const out = validateGraph({ recipe: r, task: taskFor(id, [1020, 1024]), bindings: CASES[id].bindings ?? {}, objectInfo: offering(r), snapshot: snapshot(defaults(r)), inputSizes: odd });
      expect(failing(out.report.checks), id).toEqual(["contract.task.width"]);
      expect(out.report.checks.find((c) => c.id === "contract.task.width")?.message).toMatch(/would be 1016/);
    }
    // The inpaint recipes composite onto the source, so its size comes through unrounded
    // (with a mask of the same size).
    odd.set("medusa_poster.png", { ok: true, width: 1020, height: 1024, sizeBytes: 1 });
    const r = recipe("recipe-zimage-turbo.inpaint");
    const out = validateGraph({ recipe: r, task: taskFor("recipe-zimage-turbo.inpaint", [1020, 1024]), bindings: {}, objectInfo: offering(r), snapshot: snapshot(defaults(r)), inputSizes: odd });
    expect(out.report.overall).toBe("pass");
  });

  it("reports a stretched source on the Klein edit recipes as a soft failure that doesn't block", () => {
    for (const id of ["recipe-flux2-klein-4b.edit", "recipe-flux2-klein-4b.masked-edit"]) {
      const r = recipe(id);
      const [w, h] = CASES[id].wrong;
      const out = validateGraph({ recipe: r, task: taskFor(id, [w, h]), bindings: {}, objectInfo: offering(r), snapshot: snapshot(defaults(r)), inputSizes: SIZES });
      expect(out.report.overall, id).toBe("pass");
      expect(out.report.checks.find((c) => c.id === "contract.input_aspect.inputs.source_image"), id).toMatchObject({ verdict: "fail", hard: false });
    }
  });

  it("refuses a task size off the latent's step for the recipes sized from the task, with the reason", () => {
    const steps: Record<string, number> = {
      "recipe-zimage-turbo.t2i": 16,
      "recipe-flux1-schnell.ckpt-t2i": 16,
      "recipe-zimage-turbo.t2i-upscale2x": 32,
      "recipe-flux2-klein-4b.edit": 16,
      "recipe-flux2-klein-4b.reference": 16,
      "recipe-flux2-klein-4b.masked-edit": 16,
    };
    for (const [id, step] of Object.entries(steps)) {
      const r = recipe(id);
      expect(r.outputs[0].multipleOf, id).toBe(step);
      const op = r.operations[0];
      const inputs = CASES[id]?.inputs ?? [];
      const t = TaskSpec.parse({ ...taskFor(Object.keys(CASES)[0]), media: { kind: "image", operation: op, output: { width: 1024 + step / 2, height: 1024 } }, inputs });
      const c = compileRecipe(r, t, {}).checks.find((x) => x.id === "contract.task.width");
      expect(c, id).toMatchObject({ verdict: "fail", hard: true });
      expect(c?.message, id).toContain(`isn't a multiple of ${step}`);
      const ok = TaskSpec.parse({ ...t, media: { ...t.media, output: { width: 1024, height: 1024, count: 1, format: "png" } } });
      expect(compileRecipe(r, ok, {}).checks.find((x) => x.id === "contract.task.width")?.verdict, id).toBe("pass");
    }
    expect(Recipe.safeParse({ ...recipe("recipe-realesrgan.upscale-4x"), outputs: [{ ...recipe("recipe-realesrgan.upscale-4x").outputs[0], multipleOf: 8 }] }).success).toBe(false);
  });

  it("takes exactly two references for the Klein reference recipe: one is missing an input, three is unsupported", () => {
    const id = "recipe-flux2-klein-4b.reference";
    const one = compileRecipe(recipe(id), taskFor(id, undefined, [ref("blue_poppies_field.png")]), {});
    expect(one.checks.find((c) => c.id === "contract.slot.reference_image_2")).toMatchObject({ verdict: "fail" });
    const three = compileRecipe(recipe(id), taskFor(id, undefined, [ref("blue_poppies_field.png"), ref("medusa_poster.png"), ref("egyptian_queen.png")]), {});
    expect(three.checks.find((c) => c.id === "contract.task.inputs.reference_image.3")?.message).toMatch(/unsupported/);
  });

  it("fails a mask of another size than the source, hard, and leaves its channels a soft unknown unless it has one", () => {
    for (const id of ["recipe-zimage-turbo.inpaint", "recipe-flux1-schnell.ckpt-inpaint", "recipe-flux2-klein-4b.masked-edit"]) {
      const r = recipe(id);
      const sizes = new Map(SIZES);
      sizes.set("medusa_poster.png", { ok: true, width: 512, height: 512, sizeBytes: 1, channels: 1 });
      const out = validateGraph({ recipe: r, task: taskFor(id), bindings: {}, objectInfo: offering(r), snapshot: snapshot(defaults(r)), inputSizes: sizes });
      const size = out.report.checks.find((c) => c.id === "contract.mask_size");
      expect(size, id).toMatchObject({ verdict: "fail", hard: true });
      expect(size?.message).toMatch(/512×512.*1024×1024/);
      expect(out.report.checks.find((c) => c.id === "contract.mask_channels"), id).toMatchObject({ verdict: "pass", hard: false });
      const unread = validateGraph({ recipe: r, task: taskFor(id), bindings: {}, objectInfo: offering(r), snapshot: snapshot(defaults(r)) });
      expect(unread.report.checks.find((c) => c.id === "contract.mask_size"), id).toMatchObject({ verdict: "unknown", hard: true });
      const colour = validateGraph({ recipe: r, task: taskFor(id), bindings: {}, objectInfo: offering(r), snapshot: snapshot(defaults(r)), inputSizes: SIZES });
      expect(colour.report.checks.find((c) => c.id === "contract.mask_channels")?.message, id).toMatch(/^mask channels unverified/);
    }
  });

  it("discloses that the 2K upscaler redraws content, in a notice and its description", () => {
    const r = recipe("recipe-zimage-turbo.upscale-2k");
    expect(r.notices?.[0]).toMatch(/denoise 0\.33.*fixed prompt.*change/);
    expect(r.description).toMatch(/fixed prompt that redraws detail/);
  });

  it("refuses an inpaint task without a mask and a mask the edit recipes have no slot for", () => {
    const noMask = compileRecipe(recipe("recipe-zimage-turbo.inpaint"), taskFor("recipe-zimage-turbo.inpaint", undefined, [src("blue_poppies_field.png")]), {});
    expect(noMask.checks.find((c) => c.id === "contract.slot.mask")?.verdict).toBe("fail");
    const extra = compileRecipe(recipe("recipe-flux2-klein-4b.edit"), taskFor("recipe-flux2-klein-4b.edit", undefined, [src("egyptian_queen.png"), mask("medusa_poster.png")]), {});
    expect(extra.checks.find((c) => c.id === "contract.task.inputs.mask")?.verdict).toBe("fail");
  });

  it("keeps the img2img recipes' denoise to the caller: without a binding they don't compile", () => {
    for (const id of ["recipe-zimage-turbo.img2img", "recipe-flux1-schnell.ckpt-img2img"]) {
      const compiled = compileRecipe(recipe(id), taskFor(id), {});
      expect(compiled.graph, id).toBeUndefined();
      expect(compiled.checks.find((c) => c.id === "contract.slot.denoise")?.message).toMatch(/no binding, task value or default/);
    }
  });
});
