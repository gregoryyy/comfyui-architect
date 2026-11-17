// The protected-region evaluator and the planning check of its guarantee (TODO 6.3.1, 6.3.2;
// ARCH 2026-11-16, protected regions). Images are synthetic, made with sharp here; the
// facade's real sharp decode reads them, and a map stands in for ComfyUI's input folder.

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { SHIPPED_RECIPES_DIR, loadRecipeDir } from "../../services/architect/catalog.js";
import { compileRecipe } from "../../services/architect/compile.js";
import type { EvaluatorContext, EvaluatorIo, FetchedOutput } from "../../services/architect/evaluators/contract.js";
import { protectedRegionChecks } from "../../services/architect/evaluators/guarantee.js";
import { protectedRegionEvaluator } from "../../services/architect/evaluators/protected-region.js";
import { sha256Hex } from "../../services/architect/hash.js";
import type { InputDimensions } from "../../services/architect/output-size.js";
import { type AcceptanceCriterion, type Recipe, RunRecord, TaskSpec, type TaskSpecInput } from "../../services/architect/schemas.js";
import { createUpstreamFacade } from "../../services/architect/upstream.js";
import { validateGraph } from "../../services/architect/validate.js";
import { run as runFixture, task as taskFixture } from "./fixtures/execution-records.js";
import { fixtureSnapshot } from "./fixtures/load.js";

const facade = createUpstreamFacade();
const W = 8;
const H = 6;

/** A source whose every pixel differs from its neighbours, so a shift or a swap shows. */
function sourcePixels(w = W, h = H): Buffer {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      px[i] = (x * 29 + y * 7) % 256;
      px[i + 1] = (x * 3 + y * 31 + 40) % 256;
      px[i + 2] = (x * 17 + y * 11 + 90) % 256;
    }
  }
  return px;
}

/** The repainted area: x 2 to 4, y 1 to 3. */
function inMask(x: number, y: number): boolean {
  return x >= 2 && x <= 4 && y >= 1 && y <= 3;
}

/** A one-channel mask, white where the image is repainted; `grey` marks a soft edge pixel. */
async function maskPng(opts: { grey?: [number, number] } = {}): Promise<Buffer> {
  const px = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px[y * W + x] = inMask(x, y) ? 255 : 0;
  if (opts.grey) px[opts.grey[1] * W + opts.grey[0]] = 128;
  return sharp(px, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
}

function rgbPng(px: Buffer, w = W, h = H): Promise<Buffer> {
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** The output ComfyUI's composite would write: the source, repainted inside the mask. */
function repainted(src: Buffer): Buffer {
  const out = Buffer.from(src);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inMask(x, y)) continue;
      const i = (y * W + x) * 3;
      out[i] = 250;
      out[i + 1] = 5;
      out[i + 2] = 5;
    }
  }
  return out;
}

/**
 * A PNG without its iCCP chunk. sharp writes an EXIF orientation only through
 * `withMetadata`, which also embeds an sRGB profile; a camera file with an orientation and no
 * profile is what the EXIF test needs.
 */
function withoutIccChunk(png: Buffer): Buffer {
  const parts = [png.subarray(0, 8)];
  let i = 8;
  while (i + 8 <= png.length) {
    const length = png.readUInt32BE(i);
    const type = png.toString("ascii", i + 4, i + 8);
    const end = i + 12 + length;
    if (type !== "iCCP") parts.push(png.subarray(i, end));
    i = end;
  }
  return Buffer.concat(parts);
}

function setPixel(px: Buffer, x: number, y: number, delta: number, w = W): Buffer {
  const out = Buffer.from(px);
  const i = (y * w + x) * 3;
  out[i] = Math.min(255, out[i] + delta);
  return out;
}

const SOURCE_ID = "comfyui-input:src.png";
const MASK_ID = "comfyui-input:mask.png";

function criterion(extra: Partial<Extract<AcceptanceCriterion, { kind: "protected_region_exact" }>> = {}): AcceptanceCriterion {
  return { id: "keep", kind: "protected_region_exact", required: true, sourceAssetId: SOURCE_ID, maskAssetId: MASK_ID, coordinateSpace: "source_pixels", ...extra };
}

/** A context whose input folder holds `files` and whose grant bound `approved` (default: those files). */
function context(files: Map<string, Buffer>, outputs: FetchedOutput[], approved?: Map<string, Buffer>): EvaluatorContext {
  const io: EvaluatorIo = {
    readInputFile: async (name) => {
      const bytes = files.get(name);
      if (!bytes) throw new Error(`ComfyUI /view returned 404 for "${name}" (input)`);
      return { bytes };
    },
    decodePixels: (bytes) => facade.decodePixels(bytes),
    imageForModel: (bytes, maxSide) => facade.imageForModel(bytes, maxSide),
    ollamaHost: () => "http://127.0.0.1:11434",
    ollamaJson: async () => {
      throw new Error("the protected-region evaluator sends nothing to Ollama");
    },
  };
  const bound = approved ?? files;
  return {
    run: RunRecord.parse(runFixture),
    task: TaskSpec.parse(taskFixture),
    outputs,
    approvedInputs: [...bound].map(([name, bytes]) => ({ assetId: `comfyui-input:${name}`, sha256: sha256Hex(bytes), sizeBytes: bytes.length })),
    io,
  };
}

const outputOf = (bytes: Buffer, filename = "inpaint_00001_.png"): FetchedOutput => ({ ref: { node: "12", filename, subfolder: "", type: "output" }, bytes });

async function inputs(src = sourcePixels()): Promise<Map<string, Buffer>> {
  return new Map([
    ["src.png", await rgbPng(src)],
    ["mask.png", await maskPng()],
  ]);
}

describe("the facade's pixel decode", () => {
  it("gives 8-bit RGB for a grey file and drops alpha without blending", async () => {
    const grey = await sharp(Buffer.from([0, 128, 255, 7]), { raw: { width: 2, height: 2, channels: 1 } }).png().toBuffer();
    const g = await facade.decodePixels(grey);
    expect([g.width, g.height, g.hasIccProfile, g.bitsPerSample]).toEqual([2, 2, false, 8]);
    expect([...g.data.subarray(0, 6)]).toEqual([0, 0, 0, 128, 128, 128]);
    const rgba = await sharp(Buffer.from([200, 100, 50, 10]), { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
    expect([...(await facade.decodePixels(rgba)).data]).toEqual([200, 100, 50]);
    await expect(facade.decodePixels(Buffer.from("not an image"))).rejects.toThrow();
  });
});

describe("protected-region evaluator", () => {
  it("passes when every protected pixel is the source's, whatever the mask's area holds", async () => {
    const src = sourcePixels();
    const v = await protectedRegionEvaluator.evaluate(criterion(), context(await inputs(src), [outputOf(await rgbPng(repainted(src)))]));
    expect(v.verdict).toBe("pass");
    expect(v.measurement).toEqual({ value: 0, unit: "pixels" });
    expect(v.explanation).toContain(`0 of ${W * H - 9} protected pixels differ by more than 0`);
    expect(v.evidence).toEqual([SOURCE_ID, MASK_ID, "output/inpaint_00001_.png"]);
  });

  it("fails on one changed protected pixel and counts it", async () => {
    const src = sourcePixels();
    const out = setPixel(repainted(src), 0, 0, 1);
    const v = await protectedRegionEvaluator.evaluate(criterion(), context(await inputs(src), [outputOf(await rgbPng(out))]));
    expect(v.verdict).toBe("fail");
    expect(v.measurement).toEqual({ value: 1, unit: "pixels" });
    expect(v.explanation).toContain("the largest difference is 1");
  });

  it("allows differences up to the criterion's tolerance and fails above it", async () => {
    const src = sourcePixels();
    const out = await rgbPng(setPixel(repainted(src), 7, 5, 3));
    const files = await inputs(src);
    expect((await protectedRegionEvaluator.evaluate(criterion({ tolerance: 3 }), context(files, [outputOf(out)]))).verdict).toBe("pass");
    const strict = await protectedRegionEvaluator.evaluate(criterion({ tolerance: 2 }), context(files, [outputOf(out)]));
    expect(strict.verdict).toBe("fail");
    expect(strict.explanation).toContain("differ by more than 2");
  });

  it("treats a grey mask pixel as repainted, not protected", async () => {
    const src = sourcePixels();
    const files = new Map([
      ["src.png", await rgbPng(src)],
      ["mask.png", await maskPng({ grey: [0, 0] })],
    ]);
    const out = await rgbPng(setPixel(repainted(src), 0, 0, 40));
    expect((await protectedRegionEvaluator.evaluate(criterion(), context(files, [outputOf(out)]))).verdict).toBe("pass");
  });

  it("fails an output of another size than the source", async () => {
    const src = sourcePixels();
    const bigger = await sharp({ create: { width: W * 2, height: H * 2, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    const v = await protectedRegionEvaluator.evaluate(criterion(), context(await inputs(src), [outputOf(bigger)]));
    expect(v.verdict).toBe("fail");
    expect(v.explanation).toContain(`the output is ${W * 2}×${H * 2}, the source ${W}×${H}`);
  });

  it("is unknown for a source with an embedded ICC profile, since ComfyUI's loader ignores it", async () => {
    const src = sourcePixels();
    const files = await inputs(src);
    files.set("src.png", await sharp(src, { raw: { width: W, height: H, channels: 3 } }).withIccProfile("p3").png().toBuffer());
    const v = await protectedRegionEvaluator.evaluate(criterion(), context(files, [outputOf(await rgbPng(repainted(src)))]));
    expect(v.verdict).toBe("unknown");
    expect(v.explanation).toContain("ICC profile");
  });

  it("is unknown for a 16-bit source", async () => {
    const src = sourcePixels();
    const files = await inputs(src);
    files.set("src.png", await sharp(src, { raw: { width: W, height: H, channels: 3 } }).toColourspace("rgb16").png().toBuffer());
    const v = await protectedRegionEvaluator.evaluate(criterion(), context(files, [outputOf(await rgbPng(repainted(src)))]));
    expect(v.verdict).toBe("unknown");
    expect(v.explanation).toContain("more than 8 bits");
  });

  it("applies a source's EXIF orientation, as ComfyUI's loader does", async () => {
    // Stored 8×6 with orientation 6 (rotate 90° clockwise): ComfyUI reads it as 6×8, so the
    // mask and the output are 6×8 too.
    const stored = sourcePixels(W, H);
    const rotatedSource = withoutIccChunk(await sharp(stored, { raw: { width: W, height: H, channels: 3 } }).withMetadata({ orientation: 6 }).png().toBuffer());
    const upright = await facade.decodePixels(rotatedSource);
    expect([upright.width, upright.height, upright.hasIccProfile]).toEqual([H, W, false]);
    const mask = Buffer.alloc(H * W);
    mask[0] = 255; // the top-left pixel of the upright image is repainted
    const maskFile = await sharp(mask, { raw: { width: H, height: W, channels: 1 } }).png().toBuffer();
    const out = Buffer.from(upright.data);
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    const files = new Map([
      ["src.png", rotatedSource],
      ["mask.png", maskFile],
    ]);
    const outputFile = await sharp(out, { raw: { width: H, height: W, channels: 3 } }).png().toBuffer();
    const v = await protectedRegionEvaluator.evaluate(criterion(), context(files, [outputOf(outputFile)]));
    expect(v.verdict).toBe("pass");
    // The same output against the stored (unrotated) orientation would differ in size.
    const unrotated = new Map([
      ["src.png", await rgbPng(stored)],
      ["mask.png", maskFile],
    ]);
    expect((await protectedRegionEvaluator.evaluate(criterion(), context(unrotated, [outputOf(outputFile)]))).verdict).toBe("unknown");
  });

  it("is unknown when the source changed after the approval, since ComfyUI may have read either", async () => {
    const src = sourcePixels();
    const approved = await inputs(src);
    const now = new Map(approved);
    now.set("src.png", await rgbPng(setPixel(src, 0, 0, 9)));
    const v = await protectedRegionEvaluator.evaluate(criterion(), context(now, [outputOf(await rgbPng(repainted(src)))], approved));
    expect(v.verdict).toBe("unknown");
    expect(v.explanation).toContain("changed since the approval");
  });

  it("is unknown when the grant bound no such input, when the input can't be read, or when the output wasn't fetched", async () => {
    const src = sourcePixels();
    const files = await inputs(src);
    const out = outputOf(await rgbPng(repainted(src)));
    const unbound = await protectedRegionEvaluator.evaluate(criterion(), context(files, [out], new Map([["mask.png", files.get("mask.png")!]])));
    expect(unbound).toMatchObject({ verdict: "unknown" });
    expect(unbound.explanation).toContain("the grant binds no source");
    const gone = new Map(files);
    gone.delete("mask.png");
    const unread = await protectedRegionEvaluator.evaluate(criterion(), context(gone, [out], files));
    expect(unread.verdict).toBe("unknown");
    expect(unread.explanation).toContain("couldn't be read again");
    const notFetched = await protectedRegionEvaluator.evaluate(criterion(), context(files, [{ ref: out.ref, reason: "couldn't fetch the file: 502" }]));
    expect(notFetched.verdict).toBe("unknown");
    expect(notFetched.measurement).toBeUndefined();
  });

  it("decides on several outputs together: one failing output fails the criterion", async () => {
    const src = sourcePixels();
    const good = outputOf(await rgbPng(repainted(src)), "a.png");
    const bad = outputOf(await rgbPng(setPixel(repainted(src), 1, 0, 5)), "b.png");
    const v = await protectedRegionEvaluator.evaluate(criterion(), context(await inputs(src), [good, bad]));
    expect(v.verdict).toBe("fail");
    expect(v.measurement).toEqual({ value: 1, unit: "pixels" });
  });

  it("calls a mask that protects nothing not applicable", async () => {
    const src = sourcePixels();
    const white = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
    const files = new Map([
      ["src.png", await rgbPng(src)],
      ["mask.png", white],
    ]);
    const v = await protectedRegionEvaluator.evaluate(criterion(), context(files, [outputOf(await rgbPng(repainted(src)))]));
    expect(v.verdict).toBe("not_applicable");
  });
});

// ---------------------------------------------------------------------------------------
// The planning check on the shipped recipes

const shipped = new Map(loadRecipeDir(SHIPPED_RECIPES_DIR, { shipped: true }).recipes.map((r) => [r.recipe.id, r.recipe]));
function recipe(id: string): Recipe {
  const r = shipped.get(id);
  if (!r) throw new Error(`${id} isn't shipped`);
  return r;
}

function inpaintTask(opts: { size?: [number, number]; required?: boolean; operation?: "inpaint" | "image_edit"; acceptance?: AcceptanceCriterion[] } = {}): TaskSpec {
  const [width, height] = opts.size ?? [1024, 768];
  const input: TaskSpecInput = {
    intent: "Replace the sky with a sunset.",
    media: { kind: "image", operation: opts.operation ?? "inpaint", output: { width, height } },
    inputs: [
      { assetId: SOURCE_ID, role: "source_image" },
      { assetId: MASK_ID, role: "mask" },
    ],
    acceptance: opts.acceptance ?? [criterion({ required: opts.required ?? true })],
  };
  return TaskSpec.parse({ ...input, schemaVersion: 1, id: "task-inpaint1", revision: 1, createdAt: taskFixture.createdAt, updatedAt: taskFixture.updatedAt });
}

const SIZES: ReadonlyMap<string, InputDimensions> = new Map([
  ["src.png", { ok: true, width: 1024, height: 768, sizeBytes: 1000, channels: 3 }],
  ["mask.png", { ok: true, width: 1024, height: 768, sizeBytes: 100, channels: 1 }],
]);

function guarantee(id: string, task: TaskSpec, sizes: ReadonlyMap<string, InputDimensions> | undefined = SIZES) {
  const r = recipe(id);
  // img2img doesn't compile with a mask input; the check then reads the recipe's own graph.
  const { graph } = compileRecipe(r, task, {});
  const checks = protectedRegionChecks(graph, r, task, sizes);
  expect(checks).toHaveLength(1);
  return checks[0];
}

describe("protected-region guarantee in planning", () => {
  it.each(["recipe-zimage-turbo.inpaint", "recipe-flux1-schnell.ckpt-inpaint", "recipe-flux2-klein-4b.masked-edit"])("%s composites over the source and passes", (id) => {
    const check = guarantee(id, inpaintTask());
    expect(check).toMatchObject({ id: "contract.protected_region.keep", verdict: "pass", hard: true, layer: "contract" });
  });

  it("fails FLUX.2 Klein's masked edit when the task's size isn't the source's, since its ImageScale resamples the source", () => {
    const check = guarantee("recipe-flux2-klein-4b.masked-edit", inpaintTask({ size: [512, 384] }));
    expect(check).toMatchObject({ verdict: "fail", hard: true });
    expect(check.message).toContain("resampled");
  });

  it("is unknown for the Klein recipe when the source's size wasn't read", () => {
    const check = guarantee("recipe-flux2-klein-4b.masked-edit", inpaintTask(), new Map());
    expect(check).toMatchObject({ verdict: "unknown", hard: true });
  });

  it("fails a recipe that doesn't composite: hard for a required criterion, soft for an optional one", () => {
    const required = guarantee("recipe-zimage-turbo.img2img", inpaintTask({ operation: "image_edit", required: true }));
    expect(required).toMatchObject({ verdict: "fail", hard: true });
    expect(required.message).toContain("doesn't guarantee the protected region");
    const optional = guarantee("recipe-zimage-turbo.img2img", inpaintTask({ operation: "image_edit", required: false }));
    expect(optional).toMatchObject({ verdict: "fail", hard: false });
  });

  it("fails a criterion that protects another image than the one the recipe edits", () => {
    const task = inpaintTask({ acceptance: [criterion({ sourceAssetId: "comfyui-input:other.png" })] });
    const check = guarantee("recipe-zimage-turbo.inpaint", task);
    expect(check).toMatchObject({ verdict: "fail", hard: true });
    expect(check.message).toContain("comfyui-input:other.png");
  });

  it("fails a graph whose composite was moved or whose mask channel changed", () => {
    const r = recipe("recipe-zimage-turbo.inpaint");
    const task = inpaintTask();
    const { graph } = compileRecipe(r, task, {});
    const shifted = structuredClone(graph!);
    shifted["11"].inputs.x = 8;
    expect(protectedRegionChecks(shifted, r, task, SIZES)[0]).toMatchObject({ verdict: "fail" });
    const alpha = structuredClone(graph!);
    alpha["7"].inputs.channel = "alpha";
    expect(protectedRegionChecks(alpha, r, task, SIZES)[0].message).toContain("red channel");
    expect(protectedRegionChecks(undefined, r, task, SIZES)[0]).toMatchObject({ verdict: "unknown", hard: true });
  });

  it("is part of validation, so a required criterion blocks a recipe without the guarantee", () => {
    const task = inpaintTask({ operation: "image_edit" });
    const outcome = validateGraph({ recipe: recipe("recipe-zimage-turbo.img2img"), task, bindings: {}, snapshot: fixtureSnapshot(), inputSizes: SIZES });
    const check = outcome.report.checks.find((c) => c.id === "contract.protected_region.keep");
    expect(check).toMatchObject({ verdict: "fail", hard: true });
    expect(outcome.report.overall).toBe("fail");
  });
});
