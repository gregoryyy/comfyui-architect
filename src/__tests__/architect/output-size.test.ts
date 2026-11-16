// Output size from input images (TODO 5.4; ARCH 2026-11-16, output size): the recipe
// declaration, the bounded read of an input's size through the facade, the contract checks
// against the task's width and height, the soft aspect check, and planning reading the
// sizes before it validates.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectInfo } from "../../comfyui/types.js";
import { compileRecipe } from "../../services/architect/compile.js";
import {
  type InputDimensions,
  MAX_DECODED_SIDE,
  inputNamesToSize,
  outputSizeChecks,
  readInputSizes,
} from "../../services/architect/output-size.js";
import { ApprovalError, describeActionPlan } from "../../services/architect/admission.js";
import { ArchitectExecution, type RunDriver } from "../../services/architect/execution.js";
import { sha256Hex } from "../../services/architect/hash.js";
import { ArchitectPlanning, type RecipeSource, candidateSummary } from "../../services/architect/planning.js";
import { Recipe, type TaskInput } from "../../services/architect/schemas.js";
import { ArchitectService } from "../../services/architect/service.js";
import { ArchitectStore } from "../../services/architect/store.js";
import { ImageDecoderUnavailableError, type UpstreamFacade } from "../../services/architect/upstream.js";
import { validateGraph } from "../../services/architect/validate.js";
import { fixtureSnapshot, fixtureTask } from "./fixtures/load.js";

const T = "2026-11-16T10:00:00.000Z";

function desktopObjectInfo(): ObjectInfo {
  const parsed: ObjectInfo = JSON.parse(readFileSync(new URL("./fixtures/object-info-desktop-0.44.0.json", import.meta.url), "utf-8"));
  return parsed;
}

/** A recipe that scales its source image by `factor` (ImageScaleBy), declared as scaleOfInput. */
function scaleByRecipe(factor = 2, opts: { multipleOf?: number; extra?: Record<string, unknown> } = {}): Recipe {
  return Recipe.parse({
    schemaVersion: 1,
    id: "recipe-fixture.scale-by",
    revision: 1,
    title: "Fixture: scale the source by a factor",
    kind: "image",
    operations: ["upscale"],
    graph: {
      "1": { class_type: "LoadImage", inputs: { image: "" } },
      "2": { class_type: "ImageScaleBy", inputs: { image: ["1", 0], upscale_method: "lanczos", scale_by: factor } },
      "3": { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "architect-fixture" } },
    },
    slots: [{ id: "source_image", label: "Source", valueType: "input_image", target: { node: "1", input: "image" }, required: true, fromTask: "inputs.source_image" }],
    outputs: [
      {
        role: "image",
        node: "3",
        format: "png",
        count: 1,
        scaleOfInput: { input: "inputs.source_image", factor, ...(opts.multipleOf ? { multipleOf: opts.multipleOf } : {}) },
        ...opts.extra,
      },
    ],
    dependencies: { nodeClasses: ["LoadImage", "ImageScaleBy", "SaveImage"] },
    certification: "fixture",
    evidence: [],
  });
}

/** A recipe that scales its source to the task's width and height (ImageScale). */
function fitRecipe(): Recipe {
  return Recipe.parse({
    schemaVersion: 1,
    id: "recipe-fixture.fit",
    revision: 1,
    title: "Fixture: scale the source to the task's size",
    kind: "image",
    operations: ["image_edit"],
    graph: {
      "1": { class_type: "LoadImage", inputs: { image: "" } },
      "2": { class_type: "ImageScale", inputs: { image: ["1", 0], upscale_method: "lanczos", width: 512, height: 512, crop: "disabled" } },
      "3": { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "architect-fixture" } },
    },
    slots: [
      { id: "source_image", label: "Source", valueType: "input_image", target: { node: "1", input: "image" }, required: true, fromTask: "inputs.source_image" },
      { id: "width", label: "Width", valueType: "int", target: { node: "2", input: "width" }, required: true, fromTask: "media.output.width" },
      { id: "height", label: "Height", valueType: "int", target: { node: "2", input: "height" }, required: true, fromTask: "media.output.height" },
    ],
    outputs: [{ role: "image", node: "3", format: "png", count: 1, scalesInputToTask: "inputs.source_image" }],
    dependencies: { nodeClasses: ["LoadImage", "ImageScale", "SaveImage"] },
    certification: "fixture",
    evidence: [],
  });
}

function task(width: number, height: number, inputs: TaskInput[] = [{ assetId: "comfyui-input:blue_poppies_field.png", role: "source_image" }], operation: "upscale" | "image_edit" = "upscale") {
  return fixtureTask({ media: { kind: "image", operation, output: { width, height } }, inputs });
}

const sized = (entries: Record<string, InputDimensions>) => new Map(Object.entries(entries));
const POPPIES = { ok: true as const, width: 1024, height: 1024, sizeBytes: 1000 };
const check = (checks: ReturnType<typeof outputSizeChecks>, id: string) => {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}: ${checks.map((x) => x.id).join(", ")}`);
  return c;
};

/** The first bytes of a PNG of this size: the signature and the IHDR chunk. */
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

describe("the output size declaration", () => {
  it("takes an input an input_image slot reads, and a factor above 0", () => {
    expect(scaleByRecipe(4).outputs[0].scaleOfInput).toEqual({ input: "inputs.source_image", factor: 4 });
    expect(() => scaleByRecipe(0)).toThrow();
    const raw = JSON.parse(JSON.stringify(scaleByRecipe(2)));
    raw.outputs[0].scaleOfInput.input = "inputs.mask";
    expect(Recipe.safeParse(raw).error?.issues.map((i) => i.message).join(" ")).toMatch(/inputs\.mask, which no input_image slot takes/);
  });

  it("excludes a size from the task, and scalesInputToTask needs one", () => {
    const both = JSON.parse(JSON.stringify(scaleByRecipe(2)));
    both.slots.push({ id: "width", label: "Width", valueType: "int", target: { node: "2", input: "scale_by" }, required: true, fromTask: "media.output.width" });
    expect(Recipe.safeParse(both).error?.issues.map((i) => i.message).join(" ")).toMatch(/also takes the size from the task/);
    const fit = JSON.parse(JSON.stringify(fitRecipe()));
    fit.slots = fit.slots.filter((s: { id: string }) => s.id !== "height");
    expect(Recipe.safeParse(fit).error?.issues.map((i) => i.message).join(" ")).toMatch(/needs slots that take width and height/);
    const mixed = JSON.parse(JSON.stringify(scaleByRecipe(2)));
    mixed.outputs[0].scalesInputToTask = "inputs.source_image";
    expect(Recipe.safeParse(mixed).error?.issues.map((i) => i.message).join(" ")).toMatch(/exclude each other/);
  });

  it("leaves width and height to the validator: the compiler emits no size check for it", () => {
    const compiled = compileRecipe(scaleByRecipe(2), task(2048, 2048), {});
    expect(compiled.checks.map((c) => c.id)).not.toContain("contract.task.width");
    expect(compiled.graph).toBeDefined();
  });
});

describe("the size checks against the task", () => {
  it("pass when the input times the factor is the task's size", () => {
    const checks = outputSizeChecks(scaleByRecipe(2), task(2048, 2048), sized({ "blue_poppies_field.png": POPPIES }));
    expect(check(checks, "contract.task.width")).toMatchObject({ verdict: "pass", hard: true });
    expect(check(checks, "contract.task.height").message).toContain("2048×2048");
  });

  it("fail, hard, naming both sizes, when it isn't", () => {
    const checks = outputSizeChecks(scaleByRecipe(2), task(2048, 1536), sized({ "blue_poppies_field.png": POPPIES }));
    expect(check(checks, "contract.task.width").verdict).toBe("pass");
    const h = check(checks, "contract.task.height");
    expect(h).toMatchObject({ verdict: "fail", hard: true });
    expect(h.message).toContain("2048×2048");
    expect(h.message).toContain("2048×1536");
    expect(h.message).toContain("blue_poppies_field.png (1024×1024)");
  });

  it("fail when the graph would round the product down to its multiple, or it isn't whole", () => {
    const odd = sized({ "blue_poppies_field.png": { ok: true, width: 1023, height: 1024, sizeBytes: 1 } });
    const rounded = check(outputSizeChecks(scaleByRecipe(1, { multipleOf: 8 }), task(1023, 1024), odd), "contract.task.width");
    expect(rounded).toMatchObject({ verdict: "fail", hard: true });
    expect(rounded.message).toMatch(/would be 1016: .* rounds down to a multiple of 8/);
    const half = check(outputSizeChecks(scaleByRecipe(0.5), task(512, 512), odd), "contract.task.width");
    expect(half.verdict).toBe("fail");
    expect(half.message).toMatch(/511\.5.*not a whole number/);
  });

  it("is a hard unknown when the input's size wasn't read or couldn't be", () => {
    for (const sizes of [undefined, sized({}), sized({ "blue_poppies_field.png": { ok: false, reason: "ComfyUI /view returned 404" } })]) {
      const w = check(outputSizeChecks(scaleByRecipe(2), task(2048, 2048), sizes), "contract.task.width");
      expect(w).toMatchObject({ verdict: "unknown", hard: true });
    }
    const why = check(outputSizeChecks(scaleByRecipe(2), task(2048, 2048), sized({ "blue_poppies_field.png": { ok: false, reason: "ComfyUI /view returned 404" } })), "contract.task.width");
    expect(why.message).toContain("404");
  });

  it("is a hard unknown when the task gives no such input; the slot check fails it", () => {
    const checks = outputSizeChecks(scaleByRecipe(2), task(2048, 2048, []), sized({}));
    expect(check(checks, "contract.task.width")).toMatchObject({ verdict: "unknown", hard: true });
    expect(compileRecipe(scaleByRecipe(2), task(2048, 2048, []), {}).checks.find((c) => c.id === "contract.slot.source_image")?.verdict).toBe("fail");
  });

  it("make the validator's report fail or stay unknown, never pass, without a matching size", () => {
    const info = desktopObjectInfo();
    const base = { recipe: scaleByRecipe(2), bindings: {}, objectInfo: info, snapshot: fixtureSnapshot() };
    expect(validateGraph({ ...base, task: task(2048, 2048), inputSizes: sized({ "blue_poppies_field.png": POPPIES }) }).report.overall).toBe("pass");
    expect(validateGraph({ ...base, task: task(1024, 1024), inputSizes: sized({ "blue_poppies_field.png": POPPIES }) }).report.overall).toBe("fail");
    expect(validateGraph({ ...base, task: task(2048, 2048) }).report.overall).toBe("unknown");
  });
});

describe("the soft aspect check of a recipe that scales an input to the task's size", () => {
  it("passes within 1%, fails softly beyond, and is a soft unknown without the size", () => {
    const r = fitRecipe();
    const wide = sized({ "blue_poppies_field.png": { ok: true, width: 2912, height: 1632, sizeBytes: 1 } });
    const t = (w: number, h: number) => task(w, h, undefined, "image_edit");
    expect(check(outputSizeChecks(r, t(1456, 816), wide), "contract.input_aspect.inputs.source_image")).toMatchObject({ verdict: "pass", hard: false });
    const stretched = check(outputSizeChecks(r, t(1024, 1024), wide), "contract.input_aspect.inputs.source_image");
    expect(stretched).toMatchObject({ verdict: "fail", hard: false });
    expect(stretched.message).toMatch(/2912×1632.*1024×1024.*stretched/);
    expect(check(outputSizeChecks(r, t(1024, 1024), undefined), "contract.input_aspect.inputs.source_image")).toMatchObject({ verdict: "unknown", hard: false });
    // Width and height come from the task, so the compiler's checks decide them.
    expect(outputSizeChecks(r, t(1024, 1024), wide).map((c) => c.id)).toEqual(["contract.input_aspect.inputs.source_image"]);
  });

  it("doesn't block: the candidate stays feasible and shows the stretch as a soft failure", () => {
    const wide = sized({ "blue_poppies_field.png": { ok: true, width: 2912, height: 1632, sizeBytes: 1 } });
    const out = validateGraph({
      recipe: fitRecipe(),
      task: task(1024, 1024, undefined, "image_edit"),
      bindings: {},
      objectInfo: desktopObjectInfo(),
      snapshot: fixtureSnapshot(),
      inputSizes: wide,
    });
    expect(out.report.overall).toBe("pass");
    const summary = candidateSummary({
      schemaVersion: 1,
      id: "cand-1",
      planId: "plan-1",
      taskId: "task-fixture1",
      taskRevision: 1,
      recipeId: "recipe-fixture.fit",
      recipeRevision: 1,
      environmentId: "env-fixture1",
      bindings: {},
      transforms: [],
      roleMap: {},
      validation: out.report,
      dependencyDelta: out.dependencyDelta,
      resourceEstimate: { status: "unknown", reason: "test" },
      ranking: { tier: "fixture", explanation: "test" },
      status: "feasible",
      createdAt: T,
    });
    expect(summary.softFailures?.[0]).toMatch(/stretched/);
  });
});

describe("reading input sizes through the facade", () => {
  it("reads and decodes each name once", async () => {
    const readInputFile = vi.fn(async () => ({ bytes: pngHeader(1024, 768) }));
    const decodeImage = vi.fn(async () => ({ width: 1024, height: 768 }));
    const sizes = await readInputSizes({ readInputFile, decodeImage }, ["a.png", "a.png", "sub/b.png"]);
    expect(readInputFile.mock.calls.map((c) => c)).toEqual([["a.png"], ["sub/b.png"]]);
    expect(decodeImage).toHaveBeenCalledTimes(2);
    expect(sizes.get("a.png")).toEqual({ ok: true, width: 1024, height: 768, sizeBytes: 33 });
  });

  it("records a failed read, a failed decode and a missing decoder as not known, with the reason", async () => {
    const sizes = await readInputSizes(
      {
        readInputFile: async (name: string) => {
          if (name === "gone.png") throw new Error("ComfyUI /view returned 404");
          return { bytes: Buffer.from(name) };
        },
        decodeImage: async (bytes: Buffer) => {
          if (bytes.toString() === "broken.png") throw new Error("Input buffer contains unsupported image format");
          throw new ImageDecoderUnavailableError("sharp couldn't be loaded");
        },
      },
      ["gone.png", "broken.png", "nodecoder.png"],
    );
    expect(sizes.get("gone.png")).toMatchObject({ ok: false, reason: expect.stringContaining("404") });
    expect(sizes.get("broken.png")).toMatchObject({ ok: false, reason: expect.stringContaining("unsupported image format") });
    expect(sizes.get("nodecoder.png")).toMatchObject({ ok: false, reason: expect.stringContaining("sharp") });
  });

  it("doesn't decode an image whose header gives a side over the bound", async () => {
    const decodeImage = vi.fn(async () => ({ width: 1, height: 1 }));
    const sizes = await readInputSizes({ readInputFile: async () => ({ bytes: pngHeader(MAX_DECODED_SIDE + 1, 10) }), decodeImage }, ["huge.png"]);
    expect(decodeImage).not.toHaveBeenCalled();
    expect(sizes.get("huge.png")).toMatchObject({ ok: false, reason: expect.stringContaining("over the 16384-pixel side bound") });
  });

  it("names only the task inputs a recipe sizes its output from", () => {
    const t = task(1, 1, [
      { assetId: "comfyui-input:src.png", role: "source_image" },
      { assetId: "comfyui-input:m.png", role: "mask" },
      { assetId: "elsewhere:x.png", role: "reference_image" },
    ]);
    expect(inputNamesToSize([scaleByRecipe(2)], t)).toEqual(["src.png"]);
    expect(inputNamesToSize([], t)).toEqual([]);
  });
});

describe("planning reads the sizes before it validates", () => {
  const dirs: string[] = [];
  const stores: ArchitectStore[] = [];
  afterEach(() => {
    for (const s of stores.splice(0)) s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function propose(width: number, reader: boolean, opts: { recipe?: Recipe; operation?: "upscale" | "image_edit"; height?: number; source?: [number, number] } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "architect-output-size-"));
    dirs.push(dataDir);
    const recipeDir = join(dataDir, "recipes");
    mkdirSync(recipeDir);
    writeFileSync(join(recipeDir, "scale.recipe.json"), JSON.stringify(opts.recipe ?? scaleByRecipe(2)));
    const source: RecipeSource = { id: "source-test", kind: "fixture", dir: recipeDir, trust: "test" };
    const store = ArchitectStore.open(dataDir);
    stores.push(store);
    let n = 0;
    const newId = () => `id${++n}`;
    const now = () => new Date(T);
    const upstream = {
      comfyuiBaseUrl: () => "http://127.0.0.1:8188",
      systemStats: async () => ({
        system: { os: "darwin", python_version: "3.12", embedded_python: false, comfyui_version: "0.44.0", ram_total: 1, ram_free: 1 },
        devices: [],
      }),
      objectInfo: async () => desktopObjectInfo(),
      installedModels: async () => fixtureSnapshot().installedModels ?? { folders: {}, unanswered: [], absent: [] },
      isPaidNode: () => false,
    } as Pick<UpstreamFacade, "comfyuiBaseUrl" | "systemStats" | "objectInfo" | "installedModels" | "isPaidNode">;
    const reads: string[] = [];
    const inputFiles = {
      readInputFile: async (name: string) => {
        reads.push(name);
        return { bytes: pngHeader(...(opts.source ?? [1024, 1024])) };
      },
      // Decodes the size the PNG header gives, so the bytes served decide it.
      decodeImage: async (bytes: Buffer) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }),
    };
    const service = new ArchitectService({ upstream: upstream as UpstreamFacade, now, newId });
    const planning = new ArchitectPlanning({ store, service, upstream, dataDir, sources: [source], now, newId, ...(reader ? { inputFiles } : {}) });
    const prepared = await planning.prepare({
      task: {
        intent: "Upscale it.",
        media: { kind: "image", operation: opts.operation ?? "upscale", output: { width, height: opts.height ?? width } },
        inputs: [{ assetId: "comfyui-input:blue_poppies_field.png", role: "source_image" }],
      },
    });
    const proposed = await planning.propose({ planId: prepared.plan.id });
    return { proposed, reads, planning, planId: prepared.plan.id, store, now, newId, dataDir };
  }

  it("makes the candidate feasible when the input times the factor is the task's size", async () => {
    const { proposed, reads, planning, planId } = await propose(2048, true);
    expect(proposed.candidates[0].status).toBe("feasible");
    expect(reads).toEqual(["blue_poppies_field.png"]);
    // validate reads them again: a replaced file is seen.
    await planning.validate({ planId, candidateId: proposed.candidates[0].id });
    expect(reads).toEqual(["blue_poppies_field.png", "blue_poppies_field.png"]);
  });

  it("prepare hashes and size-checks each input from one read, and an input the read shows at another size refuses the plan", async () => {
    const p = await propose(2048, true);
    p.planning.select({ planId: p.planId, candidateId: p.proposed.candidates[0].id });
    p.reads.length = 0;
    let served = pngHeader(1024, 1024);
    const runReads: string[] = [];
    const driver: RunDriver = { advance: vi.fn(), reconcile: vi.fn(), cancel: vi.fn() };
    const execution = new ArchitectExecution({
      store: p.store,
      planning: p.planning,
      baseUrl: () => "http://127.0.0.1:8188",
      now: p.now,
      newId: p.newId,
      driver,
      dataDir: p.dataDir,
      dependencyLock: (candidateId, t) => p.planning.dependencyLock(candidateId, t),
      readInputFile: async (name: string) => {
        runReads.push(name);
        return { bytes: served };
      },
    });
    const prepared = await execution.prepare({ planId: p.planId });
    expect(runReads).toEqual(["blue_poppies_field.png"]);
    // The validation decoded the bytes the plan hashed; planning's own reader wasn't used.
    expect(p.reads).toEqual([]);
    expect(prepared.actionPlan.effects.find((e) => e.kind === "local_render")).toMatchObject({ inputs: [{ sha256: sha256Hex(served) }] });
    served = pngHeader(1000, 1000);
    const decodeFromHeader = await execution.prepare({ planId: p.planId }).then(
      () => "prepared",
      (err: unknown) => (err instanceof ApprovalError ? err.code : String(err)),
    );
    expect(decodeFromHeader).toBe("APPROVAL_INVALIDATED");
  });

  it("shows a recipe's notices and a failed soft check with the candidate and in the approval text", async () => {
    const notice = "Redraws detail with a fixed prompt, so content changes.";
    const recipe = Recipe.parse({ ...fitRecipe(), notices: [notice] });
    const p = await propose(1024, true, { recipe, operation: "image_edit", height: 1024, source: [2912, 1632] });
    const c = p.proposed.candidates[0];
    expect(c.status).toBe("feasible");
    expect(c.ranking).toContain(`note: ${notice}`);
    expect(c.softFailures?.[0]).toMatch(/stretched/);
    p.planning.select({ planId: p.planId, candidateId: c.id });
    const driver: RunDriver = { advance: vi.fn(), reconcile: vi.fn(), cancel: vi.fn() };
    const execution = new ArchitectExecution({
      store: p.store,
      planning: p.planning,
      baseUrl: () => "http://127.0.0.1:8188",
      now: p.now,
      newId: p.newId,
      driver,
      dataDir: p.dataDir,
      dependencyLock: (candidateId, t) => p.planning.dependencyLock(candidateId, t),
      readInputFile: async () => ({ bytes: pngHeader(2912, 1632) }),
    });
    const prepared = await execution.prepare({ planId: p.planId });
    const text = describeActionPlan(p.store, prepared.actionPlan, () => ({ known: false, reason: "test" }));
    expect(text).toContain(`Note: ${notice}`);
    expect(text).toMatch(/Soft check failed: .*stretched/);
  });

  it("blocks it when the sizes differ, and leaves it diagnostic without a reader", async () => {
    const wrong = await propose(1024, true);
    expect(wrong.proposed.candidates[0].status).toBe("blocked");
    expect(wrong.proposed.candidates[0].blocking.join(" ")).toMatch(/2048×2048.*1024×1024/);
    const unread = await propose(2048, false);
    expect(unread.proposed.candidates[0].status).toBe("diagnostic");
    expect(unread.reads).toEqual([]);
  });
});
