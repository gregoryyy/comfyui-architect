// Input images (TODO 5.7; GAPS Q16, Q33): asset ids, input_image slots, the loader-choice
// check, and the action plan's binding of each input's content, read at prepare and again
// at start.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectInfo } from "../../comfyui/types.js";
import { ApprovalError, describeActionPlan, issueGrant } from "../../services/architect/admission.js";
import { compileRecipe } from "../../services/architect/compile.js";
import { ArchitectExecution, type RunDriver } from "../../services/architect/execution.js";
import { deriveAcquisition } from "../../services/architect/acquisition-policy.js";
import { planCandidates } from "../../services/architect/planner.js";
import { ArchitectPlanning, type RecipeSource } from "../../services/architect/planning.js";
import {
  Effect,
  Recipe,
  RecipeSlot,
  type CheckResult,
  type TaskInput,
  parseAssetId,
  taskInputPaths,
} from "../../services/architect/schemas.js";
import { ArchitectService } from "../../services/architect/service.js";
import { ArchitectStore } from "../../services/architect/store.js";
import { splitInputName, type UpstreamFacade } from "../../services/architect/upstream.js";
import { validateGraph } from "../../services/architect/validate.js";
import { fixtureObjectInfo, fixtureSnapshot, fixtureTask } from "./fixtures/load.js";
import { setup as approvalSetup } from "./fixtures/approval-harness.js";

const T = "2026-11-15T12:00:00.000Z";

/** A fixture recipe that scales an input image to the task's size; a mask slot on request. */
function scaleRecipe(opts: { mask?: boolean; references?: number } = {}) {
  const graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
    "1": { class_type: "LoadImage", inputs: { image: "" } },
    "2": { class_type: "ImageScale", inputs: { image: ["1", 0], upscale_method: "lanczos", width: 512, height: 512, crop: "disabled" } },
    "3": { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "architect-scale" } },
  };
  const slots: Record<string, unknown>[] = [
    { id: "source_image", label: "Source image", valueType: "input_image", target: { node: "1", input: "image" }, required: true, fromTask: "inputs.source_image" },
    { id: "width", label: "Width", valueType: "int", target: { node: "2", input: "width" }, required: true, fromTask: "media.output.width" },
    { id: "height", label: "Height", valueType: "int", target: { node: "2", input: "height" }, required: true, fromTask: "media.output.height" },
  ];
  const classes = ["LoadImage", "ImageScale", "SaveImage"];
  if (opts.mask) {
    graph["4"] = { class_type: "LoadImageMask", inputs: { image: "", channel: "alpha" } };
    slots.push({ id: "mask", label: "Mask", valueType: "input_image", target: { node: "4", input: "image" }, required: true, fromTask: "inputs.mask" });
    classes.push("LoadImageMask");
  }
  for (let n = 1; n <= (opts.references ?? 0); n++) {
    const node = String(10 + n);
    graph[node] = { class_type: "LoadImage", inputs: { image: "" } };
    slots.push({ id: `reference_${n}`, label: `Reference ${n}`, valueType: "input_image", target: { node, input: "image" }, required: n === 1, fromTask: `inputs.reference_image.${n}` });
  }
  return Recipe.parse({
    schemaVersion: 1,
    id: "recipe-fixture.scale-input",
    revision: 1,
    title: "Fixture: scale an input image",
    kind: "image",
    operations: ["upscale", "inpaint", "reference_guided"],
    graph,
    slots,
    outputs: [{ role: "image", node: "3", format: "png", count: 1 }],
    dependencies: { nodeClasses: classes },
    certification: "fixture",
    evidence: [],
  });
}

/** The fixture /object_info with ImageScale and LoadImageMask, and these files in the input folder. */
function objectInfoListing(listed: readonly string[]): ObjectInfo {
  const info = fixtureObjectInfo();
  info.LoadImage = { ...info.LoadImage, input: { required: { image: [[...listed], { image_upload: true }] } } };
  info.LoadImageMask = {
    input: { required: { image: [[...listed], { image_upload: true }], channel: [["alpha", "red", "green", "blue"]] } },
    output: ["MASK"],
    output_node: false,
    name: "LoadImageMask",
    display_name: "Load Image (as Mask)",
    category: "mask",
  };
  info.ImageScale = {
    input: {
      required: {
        image: ["IMAGE"],
        upscale_method: [["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]],
        width: ["INT", { default: 512, min: 0, max: 16384 }],
        height: ["INT", { default: 512, min: 0, max: 16384 }],
        crop: [["disabled", "center"]],
      },
    },
    output: ["IMAGE"],
    output_node: false,
    name: "ImageScale",
    display_name: "Upscale Image",
    category: "image/upscaling",
  };
  return info;
}

function task(inputs: TaskInput[], operation: "upscale" | "inpaint" | "reference_guided" = "upscale") {
  return fixtureTask({ media: { kind: "image", operation, output: { width: 1024, height: 768 } }, inputs });
}

const byId = (checks: readonly CheckResult[], id: string) => {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}: ${checks.map((x) => x.id).join(", ")}`);
  return c;
};

describe("asset ids (GAPS Q33)", () => {
  it("accepts comfyui-input:<name> with subfolders", () => {
    expect(parseAssetId("comfyui-input:cat.png")).toEqual({ ok: true, kind: "comfyui_input", name: "cat.png" });
    expect(parseAssetId("comfyui-input:pets/2026/cat.png")).toMatchObject({ ok: true, name: "pets/2026/cat.png" });
  });

  it.each([
    ["comfyui-input:../secret.png", "'..'"],
    ["comfyui-input:pets/../../etc/passwd", "'..'"],
    ["comfyui-input:/etc/passwd", "absolute"],
    ["comfyui-input:pets\\cat.png", "backslash"],
    ["comfyui-input:cat\u0000.png", "control character"],
    ["comfyui-input:C:/x.png", "drive letter"],
    ["comfyui-input:pets//cat.png", "empty"],
    ["comfyui-input:./cat.png", "'.'"],
    ["comfyui-input:", "empty"],
  ])("refuses %j as a path escape or malformed name", (id, why) => {
    const parsed = parseAssetId(id);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).toContain(why);
  });

  it("refuses other asset forms as unsupported", () => {
    for (const id of ["a1", "file:///tmp/cat.png", "https://example.com/cat.png", "comfyui-output:cat.png"]) {
      const parsed = parseAssetId(id);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.problem).toContain("isn't supported");
    }
  });

  it("names each task input by its fromTask path, in task order", () => {
    const paths = taskInputPaths([
      { assetId: "comfyui-input:a.png", role: "reference_image" },
      { assetId: "comfyui-input:b.png", role: "source_image" },
      { assetId: "comfyui-input:c.png", role: "reference_image" },
      { assetId: "comfyui-input:d.png", role: "source_image" },
      { assetId: "comfyui-input:m.png", role: "mask" },
      { assetId: "comfyui-input:p.png", role: "protected_region" },
    ]).map((p) => p.path);
    expect(paths).toEqual([
      "inputs.reference_image.1",
      "inputs.source_image",
      "inputs.reference_image.2",
      "inputs.source_image.2",
      "inputs.mask",
      "inputs.protected_region.1",
    ]);
  });
});

describe("input_image slots", () => {
  const base = { id: "img", label: "Image", valueType: "input_image", target: { node: "1", input: "image" }, required: true };

  it("take only the input paths, without a default", () => {
    expect(RecipeSlot.safeParse({ ...base, fromTask: "inputs.source_image" }).success).toBe(true);
    expect(RecipeSlot.safeParse({ ...base, fromTask: "inputs.reference_image.3" }).success).toBe(true);
    expect(RecipeSlot.safeParse({ ...base, fromTask: "inputs.mask" }).success).toBe(true);
    expect(RecipeSlot.safeParse(base).success).toBe(false);
    expect(RecipeSlot.safeParse({ ...base, fromTask: "inputs.reference_image.0" }).success).toBe(false);
    expect(RecipeSlot.safeParse({ ...base, fromTask: "inputs.protected_region.1" }).success).toBe(false);
    expect(RecipeSlot.safeParse({ ...base, fromTask: "intent" }).success).toBe(false);
    expect(RecipeSlot.safeParse({ ...base, fromTask: "inputs.source_image", default: "cat.png" }).success).toBe(false);
    // Another slot type can't read a task input.
    expect(RecipeSlot.safeParse({ ...base, valueType: "string", fromTask: "inputs.source_image" }).success).toBe(false);
  });
});

describe("compile: binding input images", () => {
  it("writes the asset's name into the loader input and passes the input's contract check", () => {
    const out = compileRecipe(scaleRecipe(), task([{ assetId: "comfyui-input:pets/cat.png", role: "source_image" }]), {});
    expect(out.graph?.["1"].inputs.image).toBe("pets/cat.png");
    expect(out.values.source_image).toBe("pets/cat.png");
    expect(byId(out.checks, "contract.slot.source_image")).toMatchObject({ verdict: "pass", hard: true });
    expect(byId(out.checks, "contract.task.inputs.source_image")).toMatchObject({ verdict: "pass", hard: true });
  });

  it("binds a mask and numbered reference images to their slots", () => {
    const out = compileRecipe(
      scaleRecipe({ mask: true, references: 2 }),
      task([
        { assetId: "comfyui-input:src.png", role: "source_image" },
        { assetId: "comfyui-input:mask.png", role: "mask" },
        { assetId: "comfyui-input:r1.png", role: "reference_image" },
        { assetId: "comfyui-input:r2.png", role: "reference_image" },
      ]),
      {},
    );
    expect(out.graph?.["4"].inputs.image).toBe("mask.png");
    expect(out.graph?.["11"].inputs.image).toBe("r1.png");
    expect(out.graph?.["12"].inputs.image).toBe("r2.png");
    expect(out.checks.filter((c) => c.hard && c.verdict !== "pass")).toEqual([]);
  });

  it("fails a mask the recipe has no slot for, as unsupported, and returns no graph", () => {
    const out = compileRecipe(
      scaleRecipe(),
      task([
        { assetId: "comfyui-input:src.png", role: "source_image" },
        { assetId: "comfyui-input:mask.png", role: "mask" },
      ], "inpaint"),
      {},
    );
    const c = byId(out.checks, "contract.task.inputs.mask");
    expect(c).toMatchObject({ verdict: "fail", hard: true });
    expect(c.message).toContain("unsupported");
    expect(out.graph).toBeUndefined();
  });

  it("fails any input no slot consumes: a third reference image, a second source image, a protected region", () => {
    const out = compileRecipe(
      scaleRecipe({ references: 2 }),
      task([
        { assetId: "comfyui-input:src.png", role: "source_image" },
        { assetId: "comfyui-input:src2.png", role: "source_image" },
        { assetId: "comfyui-input:r1.png", role: "reference_image" },
        { assetId: "comfyui-input:r2.png", role: "reference_image" },
        { assetId: "comfyui-input:r3.png", role: "reference_image" },
        { assetId: "comfyui-input:p.png", role: "protected_region" },
      ]),
      {},
    );
    for (const id of ["contract.task.inputs.source_image.2", "contract.task.inputs.reference_image.3", "contract.task.inputs.protected_region.1"]) {
      expect(byId(out.checks, id)).toMatchObject({ verdict: "fail", hard: true });
    }
    expect(byId(out.checks, "contract.task.inputs.reference_image.2").verdict).toBe("pass");
  });

  it("fails a required input slot the task gives no input for, as a missing input", () => {
    const out = compileRecipe(scaleRecipe(), task([]), {});
    const c = byId(out.checks, "contract.slot.source_image");
    expect(c).toMatchObject({ verdict: "fail", hard: true });
    expect(c.message).toContain("missing input");
    // An optional one keeps the recipe's value.
    const opt = compileRecipe(scaleRecipe({ references: 2 }), task([{ assetId: "comfyui-input:s.png", role: "source_image" }, { assetId: "comfyui-input:r.png", role: "reference_image" }], "reference_guided"), {});
    expect(byId(opt.checks, "contract.slot.reference_2")).toMatchObject({ verdict: "not_applicable", hard: false });
  });

  it("fails an asset id of another form or with '..', and a binding for an input slot", () => {
    for (const assetId of ["a1", "comfyui-input:../x.png", "comfyui-input:/abs/x.png"]) {
      const out = compileRecipe(scaleRecipe(), task([{ assetId, role: "source_image" }]), {});
      expect(byId(out.checks, "contract.task.inputs.source_image")).toMatchObject({ verdict: "fail", hard: true });
      expect(byId(out.checks, "contract.slot.source_image")).toMatchObject({ verdict: "fail", hard: true });
      expect(out.graph).toBeUndefined();
    }
    const bound = compileRecipe(scaleRecipe(), task([{ assetId: "comfyui-input:a.png", role: "source_image" }]), { source_image: "other.png" });
    expect(byId(bound.checks, "contract.slot.source_image")).toMatchObject({ verdict: "fail", hard: true });
  });
});

describe("validation: the loader must list the input", () => {
  const snapshot = fixtureSnapshot();
  const run = (listed: string[] | undefined, assetId = "comfyui-input:cat.png") => {
    const recipe = scaleRecipe();
    const t = task([{ assetId, role: "source_image" }]);
    const objectInfo = objectInfoListing(listed ?? []);
    if (listed === undefined) objectInfo.LoadImage = { ...objectInfo.LoadImage, input: { required: { image: ["COMBO", {}] } } };
    return { recipe, t, ...validateGraph({ recipe, task: t, bindings: {}, objectInfo, snapshot }) };
  };

  it("passes when LoadImage lists the name", () => {
    const { report } = run(["cat.png", "dog.png"]);
    expect(byId(report.checks, "native_types.combo.1.image")).toMatchObject({ verdict: "pass", hard: true });
    expect(report.overall).toBe("pass");
  });

  it("fails, hard and not acquirable, when the name isn't listed", () => {
    const { report, recipe, t } = run(["dog.png"]);
    expect(byId(report.checks, "native_types.combo.1.image")).toMatchObject({ verdict: "fail", hard: true });
    expect(report.overall).toBe("fail");
    const acq = deriveAcquisition({ recipe, task: t, candidate: { validation: report, bindings: {} }, snapshot });
    expect(acq.acquirable).toBe(false);
  });

  it("is a hard unknown when the loader's schema lists no files", () => {
    const { report } = run(undefined);
    expect(byId(report.checks, "native_types.combo.1.image")).toMatchObject({ verdict: "unknown", hard: true });
    expect(report.overall).toBe("unknown");
  });

  it("groups an unconsumed input under unsupported_operation when planning", () => {
    const out = planCandidates({
      task: task([{ assetId: "comfyui-input:cat.png", role: "source_image" }, { assetId: "comfyui-input:m.png", role: "mask" }], "upscale"),
      snapshot,
      objectInfo: objectInfoListing(["cat.png", "m.png"]),
      recipes: [scaleRecipe()],
      planId: "plan-1",
      now: () => new Date(T),
      newId: () => "1",
    });
    expect(out.presented[0].status).toBe("blocked");
    expect(out.blockers.unsupported_operation.join(" ")).toContain("inputs.mask");
  });
});

// ---------------------------------------------------------------------------------------
// The action plan binds the inputs' content (TODO 5.7.2)

const dirs: string[] = [];
const stores: ArchitectStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CAT = Buffer.from("cat image bytes");
const MASK = Buffer.from("mask image bytes");

/** A selected plan for the scale recipe over a fake target whose input folder the test edits. */
async function inputSetup(inputs: TaskInput[], opts: { mask?: boolean; reader?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "architect-inputs-"));
  dirs.push(dataDir);
  const recipeDir = join(dataDir, "recipes");
  mkdirSync(recipeDir);
  writeFileSync(join(recipeDir, "scale.recipe.json"), JSON.stringify(scaleRecipe({ mask: opts.mask })));
  const source: RecipeSource = { id: "source-test", kind: "fixture", dir: recipeDir, trust: "test" };
  const store = ArchitectStore.open(dataDir);
  stores.push(store);
  let n = 0;
  const newId = () => `id${++n}`;
  const now = () => new Date(T);
  const files = new Map<string, Buffer>([["pets/cat.png", CAT], ["mask.png", MASK]]);
  const reads: string[] = [];
  const upstream = {
    comfyuiBaseUrl: () => "http://127.0.0.1:8188",
    systemStats: async () => ({
      system: { os: "darwin", python_version: "3.12", embedded_python: false, comfyui_version: "0.44.0", ram_total: 1, ram_free: 1 },
      devices: [],
    }),
    objectInfo: async () => objectInfoListing([...files.keys()]),
    installedModels: async () => fixtureSnapshot().installedModels ?? { folders: {}, unanswered: [], absent: [] },
    isPaidNode: () => false,
  } as Pick<UpstreamFacade, "comfyuiBaseUrl" | "systemStats" | "objectInfo" | "installedModels" | "isPaidNode">;
  const service = new ArchitectService({ upstream: upstream as UpstreamFacade, now, newId });
  const planning = new ArchitectPlanning({ store, service, upstream, dataDir, sources: [source], now, newId });
  const prepared = await planning.prepare({
    task: { intent: "Scale it.", media: { kind: "image", operation: opts.mask ? "inpaint" : "upscale", output: { width: 1024, height: 768 } }, inputs },
  });
  const proposed = await planning.propose({ planId: prepared.plan.id });
  const best = proposed.candidates.find((c) => c.status === "feasible");
  if (!best) throw new Error(`no feasible candidate: ${JSON.stringify(proposed.candidates.map((c) => c.blocking))}`);
  planning.select({ planId: prepared.plan.id, candidateId: best.id });
  const driver: RunDriver = {
    advance: vi.fn(async (runId: string) => store.getRun(runId)!),
    reconcile: vi.fn(async (runId: string) => store.getRun(runId)!),
    cancel: vi.fn(async (runId: string) => store.getRun(runId)!),
  };
  const execution = new ArchitectExecution({
    store,
    planning,
    baseUrl: () => "http://127.0.0.1:8188",
    now,
    newId,
    driver,
    dataDir,
    dependencyLock: (candidateId, t) => planning.dependencyLock(candidateId, t),
    ...(opts.reader === false
      ? {}
      : {
          readInputFile: async (name: string) => {
            reads.push(name);
            const bytes = files.get(name);
            if (!bytes) throw new Error(`ComfyUI /view returned 404 for "${name}" (input)`);
            return { bytes };
          },
        }),
  });
  return { store, planning, execution, driver, files, reads, now, newId, planId: prepared.plan.id, dataDir };
}

async function approvalError(p: Promise<unknown>): Promise<ApprovalError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApprovalError);
  return err as ApprovalError;
}

describe("action plans bind each input's content", () => {
  it("prepare reads each input and records its asset id, sha256 and size in the render effect", async () => {
    const s = await inputSetup([{ assetId: "comfyui-input:pets/cat.png", role: "source_image" }]);
    const r = await s.execution.prepare({ planId: s.planId });
    const render = r.actionPlan.effects.find((e) => e.kind === "local_render");
    expect(render).toMatchObject({
      inputs: [{ assetId: "comfyui-input:pets/cat.png", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), sizeBytes: CAT.length }],
    });
    expect(s.reads).toEqual(["pets/cat.png"]);
    const text = describeActionPlan(s.store, r.actionPlan, () => ({ known: false, reason: "test" }));
    expect(text).toMatch(/Input: comfyui-input:pets\/cat\.png, sha256 [0-9a-f]{8}, \d+ B, read from the target's input folder/);
  });

  it("start with unchanged inputs reaches the grant check; with a grant it starts the run", async () => {
    const s = await inputSetup([{ assetId: "comfyui-input:pets/cat.png", role: "source_image" }]);
    const r = await s.execution.prepare({ planId: s.planId });
    expect((await approvalError(s.execution.start({ actionPlanId: r.actionPlan.id }))).code).toBe("APPROVAL_REQUIRED");
    issueGrant(s, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "terminal", confirmHash: r.shortHash });
    const started = await s.execution.start({ actionPlanId: r.actionPlan.id });
    expect(started.run.state).toBe("PREPARING");
    expect(s.reads).toEqual(["pets/cat.png", "pets/cat.png", "pets/cat.png"]);
  });

  it("a file changed between prepare and start invalidates the approval", async () => {
    const s = await inputSetup([{ assetId: "comfyui-input:pets/cat.png", role: "source_image" }]);
    const r = await s.execution.prepare({ planId: s.planId });
    issueGrant(s, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "terminal", confirmHash: r.shortHash });
    s.files.set("pets/cat.png", Buffer.from("another cat"));
    const err = await approvalError(s.execution.start({ actionPlanId: r.actionPlan.id }));
    expect(err.code).toBe("APPROVAL_INVALIDATED");
    expect(s.store.listRuns()).toEqual([]);
  });

  it("a file that vanished before start refuses the start", async () => {
    const s = await inputSetup([{ assetId: "comfyui-input:pets/cat.png", role: "source_image" }]);
    const r = await s.execution.prepare({ planId: s.planId });
    issueGrant(s, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "terminal", confirmHash: r.shortHash });
    // Validation at start sees the loader's list without it, and the read fails too; either
    // refuses, and no run is created.
    s.files.delete("pets/cat.png");
    const err = await approvalError(s.execution.start({ actionPlanId: r.actionPlan.id }));
    expect(["APPROVAL_INVALIDATED", "MISSING_INPUT"]).toContain(err.code);
    expect(s.store.listRuns()).toEqual([]);
  });

  it("a file the loader still lists but the target can't serve refuses the start as a missing input", async () => {
    const s = await inputSetup([{ assetId: "comfyui-input:pets/cat.png", role: "source_image" }]);
    const r = await s.execution.prepare({ planId: s.planId });
    issueGrant(s, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "terminal", confirmHash: r.shortHash });
    // Swap the reader for one that fails while the listing is unchanged.
    const failing = new ArchitectExecution({
      store: s.store,
      planning: s.planning,
      baseUrl: () => "http://127.0.0.1:8188",
      now: s.now,
      newId: s.newId,
      driver: s.driver,
      dataDir: s.dataDir,
      dependencyLock: (candidateId, t) => s.planning.dependencyLock(candidateId, t),
      readInputFile: async () => {
        throw new Error("ComfyUI /view returned 404");
      },
    });
    const err = await approvalError(failing.start({ actionPlanId: r.actionPlan.id }));
    expect(err.code).toBe("MISSING_INPUT");
    expect(err.message).toContain("comfyui-input:pets/cat.png");
    expect(s.store.listRuns()).toEqual([]);
  });

  it("prepare refuses a task with inputs when the server can't read them", async () => {
    const s = await inputSetup([{ assetId: "comfyui-input:pets/cat.png", role: "source_image" }], { reader: false });
    expect((await approvalError(s.execution.prepare({ planId: s.planId }))).code).toBe("MISSING_INPUT");
  });

  it("the run record and its lock name each input by asset id, hash and size, without machine paths", async () => {
    const s = await inputSetup(
      [
        { assetId: "comfyui-input:pets/cat.png", role: "source_image" },
        { assetId: "comfyui-input:mask.png", role: "mask" },
      ],
      { mask: true },
    );
    const r = await s.execution.prepare({ planId: s.planId });
    issueGrant(s, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "terminal", confirmHash: r.shortHash });
    const { run } = await s.execution.start({ actionPlanId: r.actionPlan.id });
    s.store.transitionRun({ runId: run.id, from: "PREPARING", to: "FAILED", principal: "controller", reason: "test", patch: { error: { code: "INTERNAL_ERROR", message: "test" } }, at: s.now() });
    const out = s.execution.finalize({ runId: run.id });
    const written = JSON.parse(readFileSync(out.files[0], "utf-8"));
    const lock = JSON.parse(readFileSync(out.files.find((f) => f.endsWith("dependencies.lock.json")) ?? "", "utf-8"));
    const expected = [
      { assetId: "comfyui-input:pets/cat.png", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), sizeBytes: CAT.length },
      { assetId: "comfyui-input:mask.png", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), sizeBytes: MASK.length },
    ];
    expect(written.lineage.inputs).toEqual(expected);
    expect(lock.inputs).toEqual(expected);
    expect(JSON.stringify(written.lineage.inputs)).not.toContain("/Users");
    expect(JSON.stringify(lock.inputs)).not.toContain(s.dataDir);
  });
});

describe("plans without inputs keep their hash", () => {
  it("the fixture text-to-image plan has the hash it had before inputs existed", async () => {
    const s = await approvalSetup();
    const r = await s.execution.prepare({ planId: s.planId });
    const render = r.actionPlan.effects.find((e) => e.kind === "local_render");
    expect(render).not.toHaveProperty("inputs");
    // Recorded on the milestone 4 code, before `inputs` was added to the effect.
    expect(r.actionPlan.hash).toBe("161cbf17276861fa59b0921dd52fe82a0755939085c22a900886241ce85cd592");
  });

  it("an effect refuses a listed input twice or of an unsupported form", () => {
    const sha = "a".repeat(64);
    const base = { kind: "local_render", graphFingerprint: sha, outputNodes: ["3"] };
    expect(Effect.safeParse({ ...base, inputs: [{ assetId: "comfyui-input:a.png", sha256: sha, sizeBytes: 1 }] }).success).toBe(true);
    expect(Effect.safeParse({ ...base, inputs: [] }).success).toBe(false);
    expect(Effect.safeParse({ ...base, inputs: [{ assetId: "a1", sha256: sha, sizeBytes: 1 }] }).success).toBe(false);
    expect(
      Effect.safeParse({
        ...base,
        inputs: [
          { assetId: "comfyui-input:a.png", sha256: sha, sizeBytes: 1 },
          { assetId: "comfyui-input:a.png", sha256: sha, sizeBytes: 1 },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("the facade's input-file name split", () => {
  it("splits at the last slash into subfolder and file name", () => {
    expect(splitInputName("cat.png")).toEqual({ subfolder: "", filename: "cat.png" });
    expect(splitInputName("pets/2026/cat.png")).toEqual({ subfolder: "pets/2026", filename: "cat.png" });
  });
});
