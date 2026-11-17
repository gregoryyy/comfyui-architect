// The reference acceptance suite in CI (spec §19.2; TODO 6.5.2; ARCH 2026-11-16, milestone 6,
// acceptance suite): every fixture in architect/acceptance/ is planned through the planning
// service (prepare, then propose restricted to its recipeIds with its proposals) against a
// fake facade that serves the node schemas of ComfyUI Desktop 0.44.0, the reference target's
// model lists with every shipped recipe's default files installed (what milestone 5 placed),
// and the synthetic inputs of inputs.json at their recorded sizes.
//
// AT-01: a `refused` fixture fails TaskSpecInput, and prepare refuses it; a malformed proposal
// (a binding naming no slot, a value of the wrong type, an invented model file) leaves no
// candidate that would render it. AT-02: a `blocked` fixture has no feasible or acquirable
// candidate, its blockers are the ones it expects and nothing else (`judgeBlockers`), and no
// candidate reports a hard unknown as passing. AT-10: an Apple unified-memory and a
// dedicated-GPU device snapshot, asserting what resources.ts does today: one lease per
// target, and no memory added up. Memory accounting itself isn't measured here.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NodeInputSpec, ObjectInfo, SystemStats } from "../../comfyui/types.js";
import {
  type AcceptanceFixture,
  type AcceptanceInputs,
  COMPILE_KNOCK_ON_LINES,
  at04,
  attemptRepaired,
  egressViolations,
  inputName,
  inputSvg,
  isCompileKnockOn,
  isLocalDestination,
  judgeBlockers,
  loadAcceptanceFixtures,
  parseEgressLog,
  summariseAttempts,
} from "../../services/architect/acceptance.js";
import { SHIPPED_RECIPES_DIR, loadRecipeDir } from "../../services/architect/catalog.js";
import { ArchitectPlanning, PlanningError, type RecipeSource } from "../../services/architect/planning.js";
import { type FetchLike, ResourceCoordinator, memoryPool } from "../../services/architect/resources.js";
import { type PlanBlockers, type PlanCandidate, type Recipe, RunRecord, TaskSpecInput } from "../../services/architect/schemas.js";
import { ArchitectService } from "../../services/architect/service.js";
import { ArchitectStore } from "../../services/architect/store.js";
import type { UpstreamFacade } from "../../services/architect/upstream.js";
import { overallVerdict } from "../../services/architect/validate.js";
import { BASE_URL } from "./fixtures/execution-records.js";
import { FakeOllama, seedRun } from "./fixtures/run-harness.js";

const T = "2026-11-16T10:00:00.000Z";
const REFERENCE_URL = "http://127.0.0.1:8000";
const GiB = 1024 ** 3;

const loaded = loadAcceptanceFixtures();
const inputs: AcceptanceInputs = loaded.inputs ?? { schemaVersion: 1, prefix: "architect-acceptance-", files: [] };
const shipped: Recipe[] = loadRecipeDir(SHIPPED_RECIPES_DIR, { shipped: true }).recipes.map((r) => r.recipe);

// ---------------------------------------------------------------------------------------
// The reference target, as data

/** The reference Mac's device snapshot (EVAL test matrix): one MPS device on 48 GB unified memory. */
const APPLE_UNIFIED: SystemStats = {
  system: { os: "darwin", python_version: "3.13.0", embedded_python: false, comfyui_version: "0.44.0", ram_total: 48 * GiB, ram_free: 30 * GiB },
  devices: [{ name: "mps", type: "mps", index: 0, vram_total: 48 * GiB, vram_free: 30 * GiB, torch_vram_total: 48 * GiB, torch_vram_free: 30 * GiB }],
};

/** A CUDA device with 24 GB of its own VRAM next to 64 GB of system RAM, as data only. */
const DEDICATED_GPU: SystemStats = {
  system: { os: "linux", python_version: "3.12.0", embedded_python: false, comfyui_version: "0.44.0", ram_total: 64 * GiB, ram_free: 50 * GiB },
  devices: [{ name: "cuda:0 NVIDIA GeForce RTX 4090", type: "cuda", index: 0, vram_total: 24 * GiB, vram_free: 23 * GiB, torch_vram_total: 0, torch_vram_free: 0 }],
};

function capture(): ObjectInfo {
  const parsed: ObjectInfo = JSON.parse(readFileSync(new URL("./fixtures/object-info-desktop-0.44.0.json", import.meta.url), "utf-8"));
  return parsed;
}

/** Every shipped recipe's default model files by folder: the reference target after milestone 5. */
function installedFolders(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of shipped) {
    for (const s of r.slots.filter((x) => x.valueType === "model_file" && typeof x.default === "string")) {
      const list = (out[s.modelFolder ?? ""] ??= []);
      if (!list.includes(String(s.default))) list.push(String(s.default));
    }
  }
  return out;
}

/** Edit the choices of a COMBO input, in the classic (`[[...choices]]`) or the V3 form (`["COMBO", { options }]`). */
function editChoices(info: ObjectInfo, cls: string, input: string, edit: (choices: readonly string[]) => string[]): void {
  const required = info[cls]?.input?.required;
  const spec: NodeInputSpec | undefined = required?.[input];
  if (!required || !spec) return;
  if (Array.isArray(spec[0])) {
    required[input] = [edit(spec[0].map(String)), ...spec.slice(1)] as NodeInputSpec;
    return;
  }
  const opts = spec[1];
  if (spec[0] === "COMBO" && typeof opts === "object" && opts !== null && "options" in opts && Array.isArray(opts.options)) {
    required[input] = ["COMBO", { ...opts, options: edit(opts.options.map(String)) }] as NodeInputSpec;
  }
}

function addChoice(info: ObjectInfo, cls: string, input: string, file: string): void {
  editChoices(info, cls, input, (c) => (c.includes(file) ? [...c] : [...c, file]));
}

function removeChoice(info: ObjectInfo, cls: string, input: string, file: string): void {
  editChoices(info, cls, input, (c) => c.filter((x) => x !== file));
}

/** The capture with each shipped model slot's loader offering its file and each image loader the synthetic inputs. */
function referenceObjectInfo(removed: ReadonlySet<string>, inputNames: readonly string[] = inputs.files.map((f) => inputName(inputs, f))): ObjectInfo {
  const info = capture();
  for (const r of shipped) {
    for (const s of r.slots.filter((x) => x.valueType === "model_file" && typeof x.default === "string")) {
      const cls = r.graph[s.target.node].class_type;
      const file = String(s.default);
      if (removed.has(`${s.modelFolder}/${file}`)) removeChoice(info, cls, s.target.input, file);
      else addChoice(info, cls, s.target.input, file);
    }
  }
  // Every loader whose `image` input is an upload combo lists the synthetic inputs, as
  // ComfyUI does: only names at the input folder's top level. LoadImage lists that level
  // alone, so a name with a folder in it is never offered, and a fixture naming one is
  // blocked here as it is on the live target (GAPS Q33).
  for (const [cls, def] of Object.entries(info)) {
    const spec = def.input?.required?.image;
    if (!spec || !Array.isArray(spec[0]) || !(typeof spec[1] === "object" && spec[1] !== null && "image_upload" in spec[1])) continue;
    for (const name of inputNames) if (!/[/\\]/.test(name)) addChoice(info, cls, "image", name);
  }
  return info;
}

const stores: ArchitectStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The planning service over a fake facade for the reference target, with a fixture's environment changes. */
function setup(env: AcceptanceFixture["environment"] = {}, stats: SystemStats = APPLE_UNIFIED) {
  const dataDir = mkdtempSync(join(tmpdir(), "architect-acceptance-"));
  dirs.push(dataDir);
  const store = ArchitectStore.open(dataDir);
  stores.push(store);
  let n = 0;
  const newId = () => `id${++n}`;
  const now = () => new Date(T);
  const removed = new Set(env?.removeModels ?? []);
  const folders = installedFolders();
  for (const key of removed) {
    const [folder, ...rest] = key.split("/");
    folders[folder] = (folders[folder] ?? []).filter((f) => f !== rest.join("/"));
  }
  const upstream: Pick<UpstreamFacade, "comfyuiBaseUrl" | "systemStats" | "objectInfo" | "installedModels" | "isPaidNode"> = {
    comfyuiBaseUrl: () => env?.targetBaseUrl ?? REFERENCE_URL,
    systemStats: async () => stats,
    objectInfo: async () => referenceObjectInfo(removed),
    installedModels: async () => ({ folders, unanswered: [], absent: [] }),
    isPaidNode: () => false,
  };
  // The bytes of each synthetic input name it, so the decoder can answer with the recorded size.
  const byName = new Map(inputs.files.map((f) => [inputName(inputs, f), f]));
  const inputFiles: Pick<UpstreamFacade, "readInputFile" | "decodeImage"> = {
    readInputFile: async (name) => {
      if (!byName.has(name)) throw new Error(`ComfyUI /view returned 404 for "${name}" (input)`);
      return { bytes: Buffer.from(`acceptance-input:${name}`) };
    },
    decodeImage: async (bytes) => {
      const f = byName.get(bytes.toString("utf-8").replace(/^acceptance-input:/, ""));
      if (!f) throw new Error("not a synthetic input");
      return { width: f.width, height: f.height, channels: f.pattern === "mask-disc" ? 1 : 3 };
    },
  };
  const service = new ArchitectService({ upstream: upstream as UpstreamFacade, now, newId });
  const source: RecipeSource = { id: "source-shipped", kind: "bundled", dir: SHIPPED_RECIPES_DIR, trust: "maintainer" };
  const planning = new ArchitectPlanning({ store, service, upstream, dataDir, sources: [source], now, newId, inputFiles });
  return { planning, store };
}

/** A fixture planned: the plan, its stored candidates (whole, not the summaries), or the refusal. */
async function planFixture(f: Pick<AcceptanceFixture, "task" | "environment" | "recipeIds" | "proposals">, stats?: SystemStats) {
  const { planning, store } = setup(f.environment, stats);
  const prepared = await planning.prepare({ task: f.task });
  const proposed = await planning.propose({
    planId: prepared.plan.id,
    ...(f.recipeIds ? { recipeIds: f.recipeIds } : {}),
    ...(f.proposals ? { proposals: f.proposals } : {}),
  });
  const plan = proposed.plan;
  if (!plan) throw new Error("propose returned no plan");
  const candidates = plan.candidateIds.map((id) => store.getCandidate(id)).filter((c): c is PlanCandidate => c !== undefined);
  return { prepared, plan, candidates };
}

function describeCandidates(candidates: readonly PlanCandidate[]): string {
  return candidates
    .map((c) => `${c.recipeId} ${c.status}: ${c.validation.checks.filter((x) => x.hard && x.verdict !== "pass" && x.verdict !== "not_applicable").map((x) => `${x.id} ${x.verdict}`).join(", ")}`)
    .join(" | ");
}

/** No unknown hard check reads as a pass (AT-02, #796): not in the overall, not in the status. */
function expectUnknownNotPass(candidates: readonly PlanCandidate[]): void {
  for (const c of candidates) {
    const hardUnknown = c.validation.checks.filter((x) => x.hard && x.verdict === "unknown");
    expect(c.validation.overall, c.id).toBe(overallVerdict(c.validation.checks));
    if (hardUnknown.length > 0) {
      expect(c.validation.overall, `${c.recipeId}: ${hardUnknown.map((x) => x.id).join(", ")}`).not.toBe("pass");
      expect(["feasible", "acquirable"], `${c.recipeId} with a hard unknown`).not.toContain(c.status);
    }
    if (c.status === "feasible") expect(c.validation.checks.filter((x) => x.hard && (x.verdict === "unknown" || x.verdict === "fail"))).toEqual([]);
  }
}

/** A plan blocked for the reason `expectation` names and no other, the AT-02 judgement. */
function expectBlockedFor(expectation: Pick<AcceptanceFixture, "expect">, plan: { state: string; blockers: PlanBlockers }, candidates: readonly PlanCandidate[]): void {
  expect(candidates.filter((c) => c.status === "feasible" || c.status === "acquirable").map((c) => c.recipeId)).toEqual([]);
  expect(plan.state).toBe("BLOCKED");
  const judged = judgeBlockers(expectation, plan.blockers);
  expect({ unreadable: judged.unreadable, missing: judged.missing, unexpected: judged.unexpected }, JSON.stringify(plan.blockers)).toEqual({ unreadable: undefined, missing: [], unexpected: [] });
  expect(judged.passed).toBe(true);
}

async function checkFixture(f: AcceptanceFixture): Promise<void> {
  const parsed = TaskSpecInput.safeParse(f.task);
  if (f.expect.outcome === "refused") {
    // AT-01: malformed before planning, and prepare refuses it with a validation error.
    expect(parsed.success).toBe(false);
    const { planning } = setup(f.environment);
    const err = await planning.prepare({ task: f.task }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PlanningError);
    expect(err).toMatchObject({ code: "MISSING_INPUT", message: expect.stringContaining("isn't a valid TaskSpec") });
    return;
  }
  expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(true);
  const { prepared, plan, candidates } = await planFixture(f);
  expect(prepared.missingFields).toEqual([]);
  expectUnknownNotPass(candidates);
  if (f.expect.outcome === "feasible") {
    const recipes = f.expect.recipes;
    const ok = candidates.filter((c) => c.status === "feasible" && recipes.includes(c.recipeId));
    expect(ok.length, describeCandidates(candidates)).toBeGreaterThan(0);
    expect(plan.state).toBe("PROPOSED");
  } else {
    // AT-02: blocked, for the expected reason only.
    expectBlockedFor(f, plan, candidates);
  }
}

// ---------------------------------------------------------------------------------------

describe("the acceptance fixtures", () => {
  it("parse: 30 task fixtures and inputs.json, without errors", () => {
    expect(loaded.errors).toEqual([]);
    expect(loaded.fixtures.map((f) => f.id)).toEqual(Array.from({ length: 30 }, (_, i) => `at-${String(i + 1).padStart(2, "0")}`));
    expect(loaded.inputs).toBeDefined();
  });

  it("are 20 feasible, live render, and 10 conflicts, as the README lists them", () => {
    const feasible = loaded.fixtures.filter((f) => f.expect.outcome === "feasible");
    expect(feasible.map((f) => f.id)).toEqual(Array.from({ length: 20 }, (_, i) => `at-${String(i + 1).padStart(2, "0")}`));
    expect(feasible.every((f) => f.live === "render")).toBe(true);
    expect(loaded.fixtures.filter((f) => f.expect.outcome !== "feasible").length).toBe(10);
  });

  it("name only shipped recipes, and every shipped recipe is expected by a feasible fixture", () => {
    const ids = new Set(shipped.map((r) => r.id));
    for (const f of loaded.fixtures) {
      for (const id of [...(f.recipeIds ?? []), ...(f.expect.outcome === "feasible" ? f.expect.recipes : [])]) expect(ids.has(id), `${f.id}: ${id}`).toBe(true);
    }
    const expected = new Set(loaded.fixtures.flatMap((f) => (f.expect.outcome === "feasible" ? f.expect.recipes : [])));
    expect([...ids].filter((id) => !expected.has(id))).toEqual([]);
  });

  it("name only inputs that inputs.json lists, apart from the deliberately missing and escaping ones", () => {
    const listed = new Set(inputs.files.map((f) => `comfyui-input:${inputName(inputs, f)}`));
    for (const f of loaded.fixtures) {
      const parsed = TaskSpecInput.safeParse(f.task);
      if (!parsed.success) continue;
      const assets = [...parsed.data.inputs.map((i) => i.assetId), ...parsed.data.acceptance.flatMap((c) => (c.kind === "protected_region_exact" ? [c.sourceAssetId, c.maskAssetId] : []))];
      const unlisted = assets.filter((a) => !listed.has(a));
      expect(unlisted, f.id).toEqual(f.id === "at-25" || f.id === "at-26" ? [assets[0]] : []);
    }
  });

  // ComfyUI's LoadImage lists only the top level of the input folder, so an input in a
  // subfolder is never a file it lists and blocks every candidate on the live target. The
  // capture above can't show that: it lists whatever names inputs.json gives. The first live
  // run of the suite (2026-11-16) failed all twelve input fixtures this way.
  it("name every input at the top level of the input folder, where LoadImage lists it", async () => {
    const { AcceptanceInputs } = await import("../../services/architect/acceptance.js");
    expect(inputs.files.length).toBeGreaterThan(0);
    for (const f of inputs.files) expect(inputName(inputs, f), f.name).not.toMatch(/[/\\]/);
    expect(AcceptanceInputs.safeParse({ ...inputs, prefix: "architect-acceptance/" }).success).toBe(false);
    expect(AcceptanceInputs.safeParse({ schemaVersion: 1, folder: "architect-acceptance", files: inputs.files }).success).toBe(false);
  });

  it("are offered by the capture's LoadImage only at the input folder's top level, as ComfyUI lists them", () => {
    const info = referenceObjectInfo(new Set(), ["architect-acceptance-scene-1024.png", "architect-acceptance/scene-1024.png", "sub\\scene.png"]);
    const spec = info.LoadImage?.input?.required?.image;
    const choices = spec && Array.isArray(spec[0]) ? spec[0].map(String) : [];
    expect(choices).toContain("architect-acceptance-scene-1024.png");
    expect(choices).not.toContain("architect-acceptance/scene-1024.png");
    expect(choices).not.toContain("sub\\scene.png");
  });

  it("reject a fixture with an unknown field, a mismatched expectation or a live environment change", async () => {
    const { AcceptanceFixture } = await import("../../services/architect/acceptance.js");
    const base = loaded.fixtures[0];
    expect(AcceptanceFixture.safeParse(base).success).toBe(true);
    expect(AcceptanceFixture.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(AcceptanceFixture.safeParse({ ...base, expect: { outcome: "blocked" } }).success).toBe(false);
    expect(AcceptanceFixture.safeParse({ ...base, expect: { outcome: "blocked", category: "other", checks: ["x"] } }).success).toBe(false);
    // A conflict names the lines it expects: without them, any reason in the category would do.
    expect(AcceptanceFixture.safeParse({ ...base, expect: { outcome: "blocked", category: "policy_conflicts" } }).success).toBe(false);
    expect(AcceptanceFixture.safeParse({ ...base, expect: { outcome: "blocked", category: "policy_conflicts", checks: [] } }).success).toBe(false);
    expect(AcceptanceFixture.safeParse({ ...base, expect: { outcome: "blocked", category: "policy_conflicts", checks: ["/(unclosed/"] } }).success).toBe(false);
    expect(AcceptanceFixture.safeParse({ ...base, expect: { outcome: "blocked", category: "policy_conflicts", checks: ["x"], related: { other: ["y"] } } }).success).toBe(false);
    expect(AcceptanceFixture.safeParse({ ...base, expect: { outcome: "blocked", category: "policy_conflicts", checks: ["x"], related: { missing_dependencies: ["y"] } } }).success).toBe(true);
    expect(AcceptanceFixture.safeParse({ ...base, expect: { outcome: "feasible", recipes: ["recipe-other"] } }).success).toBe(false);
    expect(AcceptanceFixture.safeParse({ ...base, environment: { removeModels: ["vae/x.safetensors"] } }).success).toBe(false);
    expect(AcceptanceFixture.safeParse({ ...base, live: "fixture_only", environment: { removeModels: ["no-folder"] } }).success).toBe(false);
  });
});

describe("the acceptance suite against the reference target (AT-01, AT-02)", () => {
  for (const f of loaded.fixtures) {
    const label = `${f.id} (${f.expect.outcome}${f.expect.outcome === "blocked" ? `: ${f.expect.category}` : ""}): ${f.title}`;
    it(label, () => checkFixture(f));
  }
});

describe("malformed proposals against the reference target (AT-01)", () => {
  // The agent fills slots (spec §9.2); a proposal it got wrong must end with no candidate that
  // renders it, and with the reason, never with the recipe's defaults quietly standing in.
  const at01 = loaded.fixtures.find((f) => f.id === "at-01");
  const recipeId = "recipe-zimage-turbo.t2i";
  const cases: [string, Record<string, string | number>, AcceptanceFixture["expect"]][] = [
    ["a binding to a slot the recipe doesn't have", { steps: 8 }, { outcome: "blocked", category: "insufficient_evidence", checks: [`binding "steps" names no slot of recipe ${recipeId}`] }],
    ["a binding of the wrong type", { seed: "forty-two" }, { outcome: "blocked", category: "insufficient_evidence", checks: ['slot seed (binding): expected a finite number, got "forty-two"'] }],
    [
      "an invented model file for a model slot",
      { diffusion_model: "z_image_turbo_invented.safetensors" },
      {
        outcome: "blocked",
        category: "missing_dependencies",
        checks: ["diffusion_models/z_image_turbo_invented.safetensors is not installed on the target", '"z_image_turbo_invented.safetensors" is not a file UNETLoader offers on the target'],
        // Nothing has read the file's family, so it isn't taken for the recipe's (GAPS Q14).
        related: { insufficient_evidence: ['slot diffusion_model expects family z-image-turbo; "z_image_turbo_invented.safetensors" isn\'t the recipe\'s file'] },
      },
    ],
  ];

  it.each(cases)("%s blocks every candidate, for that reason", async (_name, bindings, expectation) => {
    if (!at01) throw new Error("at-01 is missing");
    const { plan, candidates } = await planFixture({ ...at01, recipeIds: [recipeId], proposals: [{ recipeId, bindings }] });
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) expect(c.recipeId).toBe(recipeId);
    expectUnknownNotPass(candidates);
    expectBlockedFor({ expect: expectation }, plan, candidates);
  });
});

describe("resource profiles (AT-10)", () => {
  const at01 = loaded.fixtures.find((f) => f.id === "at-01");

  // What resources.ts does today (ARCH 2026-11-16, milestone 6, acceptance suite): one lease per
  // target and no memory arithmetic. Memory accounting itself (a unified pool not counted as
  // both VRAM and RAM, a demand against a device's free memory) isn't measured until recipes
  // carry resource estimates: every candidate's estimate is unknown, so there is nothing to add.
  it.each([
    ["Apple unified memory", APPLE_UNIFIED, { ramTotal: 48 * GiB, devices: [{ type: "mps", memoryTotal: 48 * GiB }] }],
    ["a dedicated GPU", DEDICATED_GPU, { ramTotal: 64 * GiB, devices: [{ type: "cuda", memoryTotal: 24 * GiB }] }],
  ] as const)("on %s two runs on one target never hold its pool at once, and no device memory is added to RAM", async (_name, stats, recorded) => {
    if (!at01) throw new Error("at-01 is missing");
    // The snapshot keeps the device and RAM as reported; neither the snapshot nor a candidate
    // holds their sum anywhere.
    const { prepared, candidates } = await planFixture(at01, stats);
    expect(prepared.environment.probeErrors).toEqual([]);
    const { planning } = setup({}, stats);
    const { snapshot } = await planning.environment();
    expect(snapshot).toMatchObject(recorded);
    expect(snapshot.devices?.length).toBe(1);
    const sum = stats.system.ram_total + stats.devices[0].vram_total;
    const numbers: number[] = [];
    JSON.stringify([snapshot, candidates], (_k, v: unknown) => {
      if (typeof v === "number") numbers.push(v);
      return v;
    });
    expect(numbers).not.toContain(sum);
    expect(candidates.some((c) => c.status === "feasible")).toBe(true);

    // Two runs on the target: the second waits while the first holds the pool, from this
    // instance and from another (two Architect processes), until the first releases it.
    const dir = mkdtempSync(join(tmpdir(), "architect-acceptance-pool-"));
    dirs.push(dir);
    const clock = () => new Date("2026-11-15T12:02:30.000Z");
    const store = ArchitectStore.open(dir, { now: clock });
    stores.push(store);
    const refused: FetchLike = async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    };
    const coordinator = (ownerId: string) =>
      new ResourceCoordinator({ store, upstream: new FakeOllama().facade(), ownerId, now: clock, manageResidency: false, fetchImpl: refused, probeTimeoutMs: 20 });
    const a = coordinator("instance-a");
    const b = coordinator("instance-b");
    const run = seedRun(store);
    const second = RunRecord.parse({ ...run, id: "run-second" });
    expect(await a.acquire(run)).toMatchObject({ ok: true, lease: { pool: memoryPool(BASE_URL), runId: run.id } });
    expect(await a.acquire(second)).toMatchObject({ ok: false, code: "RESOURCE_BUSY", retry: true });
    expect(await b.acquire(second)).toMatchObject({ ok: false, code: "RESOURCE_BUSY", retry: true });
    expect(store.getLease(memoryPool(BASE_URL))).toMatchObject({ ownerId: "instance-a", runId: run.id });
    // Another instance can't release the first run's lease; its own instance can.
    expect(b.release(run)).toBe(false);
    expect(a.release(run)).toBe(true);
    expect(store.getLease(memoryPool(BASE_URL))).toBeUndefined();
  });

  it("keys the pool by the target, whatever its devices", () => {
    expect(memoryPool(`${BASE_URL}/`)).toBe(memoryPool(BASE_URL));
    expect(memoryPool("http://127.0.0.1:8189")).not.toBe(memoryPool(BASE_URL));
  });
});

describe("judging a conflict's blockers (AT-02)", () => {
  const fixture = {
    expect: {
      outcome: "blocked" as const,
      category: "unsupported_operation" as const,
      checks: ["the recipe writes count 1, the task asks for 4", "/multiple of (16|32)$/"],
      related: { missing_dependencies: ["is not installed on the target"] },
    },
  };
  const none = (): PlanBlockers => ({ missing_dependencies: [], unsupported_operation: [], insufficient_evidence: [], resource_limits: [], policy_conflicts: [] });
  const matching = (): PlanBlockers => ({
    ...none(),
    unsupported_operation: ["recipe-a: the recipe writes count 1, the task asks for 4", "recipe-b: the recipe writes count 1, the task asks for 4", "recipe-a: width 1000 isn't a multiple of 16"],
    missing_dependencies: ["recipe-a: vae/x.safetensors is not installed on the target"],
  });
  const knockOns = COMPILE_KNOCK_ON_LINES.map((k) => `recipe-a: ${k}`);

  it("passes when every expected check matches and only knock-ons are left over", () => {
    expect(judgeBlockers(fixture, matching())).toEqual({ passed: true, missing: [], unexpected: [] });
    expect(judgeBlockers(fixture, { ...matching(), insufficient_evidence: knockOns })).toEqual({ passed: true, missing: [], unexpected: [] });
    expect(knockOns.every(isCompileKnockOn)).toBe(true);
  });

  it("fails when an expected check matches no line of its category", () => {
    const b = { ...matching(), unsupported_operation: ["recipe-a: the recipe writes count 1, the task asks for 4"] };
    expect(judgeBlockers(fixture, b)).toEqual({ passed: false, missing: ["unsupported_operation: /multiple of (16|32)$/"], unexpected: [] });
    // A line in another category doesn't stand in for the expected one.
    const moved = { ...none(), missing_dependencies: matching().missing_dependencies, policy_conflicts: matching().unsupported_operation };
    const judged = judgeBlockers(fixture, moved);
    expect(judged.passed).toBe(false);
    expect(judged.missing).toHaveLength(2);
    expect(judged.unexpected).toHaveLength(3);
    // Nor does a related line missing pass.
    expect(judgeBlockers(fixture, { ...matching(), missing_dependencies: [] }).missing).toEqual(["missing_dependencies: is not installed on the target"]);
  });

  it("fails on a failure the fixture didn't name, in its category or another", () => {
    const extra = "recipe-a: required slot denoise has no binding, task value or default";
    expect(judgeBlockers(fixture, { ...matching(), insufficient_evidence: [extra] })).toEqual({ passed: false, missing: [], unexpected: [`insufficient_evidence: ${extra}`] });
    const sameCategory = { ...matching(), unsupported_operation: [...matching().unsupported_operation, "recipe-a: recipe supports text_to_image, not inpaint"] };
    expect(judgeBlockers(fixture, sameCategory).unexpected).toEqual(["unsupported_operation: recipe-a: recipe supports text_to_image, not inpaint"]);
  });

  it("fails on knock-on lines alone: they follow a failure and are never its reason", () => {
    const judged = judgeBlockers(fixture, { ...none(), insufficient_evidence: knockOns });
    expect(judged.passed).toBe(false);
    expect(judged.unexpected).toEqual([]);
    expect(judged.missing).toHaveLength(3);
    expect(isCompileKnockOn("recipe-a: no graph")).toBe(false);
  });

  it("fails for a fixture that doesn't expect a block", () => {
    expect(judgeBlockers({ expect: { outcome: "feasible", recipes: ["recipe-a"] } }, none()).passed).toBe(false);
  });

  it("says the blockers were unreadable, never that there were none, when they don't parse (#796)", () => {
    for (const raw of [undefined, {}, { ...none(), policy_conflicts: undefined }, { ...matching(), extra: [] }]) {
      const judged = judgeBlockers(fixture, raw);
      expect(judged.passed).toBe(false);
      expect(judged.unreadable).toMatch(/don't parse/);
    }
    expect(judgeBlockers(fixture, matching()).unreadable).toBeUndefined();
  });
});

describe("the runner's pure parts (AT-04, AT-09)", () => {
  it("draws each synthetic input the same way every time, at its recorded size", () => {
    for (const f of inputs.files) {
      const svg = inputSvg(f);
      expect(svg).toBe(inputSvg({ ...f }));
      expect(svg).toContain(`width="${f.width}" height="${f.height}"`);
      expect(svg).not.toMatch(/NaN|undefined/);
    }
    const mask = inputs.files.find((f) => f.pattern === "mask-disc");
    if (mask) expect(inputSvg(mask)).toContain(`r="${Math.round(mask.width / 8)}"`);
  });

  it("finds non-loopback destinations inside a fixture's window only", () => {
    const { records, unreadable } = parseEgressLog(
      [
        JSON.stringify({ at: 100, via: "net.connect", host: "127.0.0.1", port: 8000 }),
        JSON.stringify({ at: 150, via: "fetch", host: "huggingface.co", port: 443 }),
        JSON.stringify({ at: 160, via: "net.connect", path: "/tmp/sock" }),
        JSON.stringify({ at: 170, via: "net.connect", host: "localhost", port: 11434 }),
        JSON.stringify({ at: 400, via: "tls.connect", host: "example.org", port: 443 }),
        "not json",
        JSON.stringify({ at: "x" }),
      ].join("\n"),
    );
    expect(unreadable).toBe(2);
    expect(egressViolations(records, 100, 300)).toEqual(["huggingface.co:443"]);
    expect(egressViolations(records, 0, 1000)).toEqual(["example.org:443", "huggingface.co:443"]);
    expect(egressViolations(records, 160, 170)).toEqual([]);
    // A record that names no destination isn't counted as local.
    expect(isLocalDestination({})).toBe(false);
    expect(isLocalDestination({ host: "::1" })).toBe(true);
    expect(isLocalDestination({ host: "192.168.1.20" })).toBe(false);
  });

  it("counts first-attempt and repaired results apart, smoke attempts apart from finals", () => {
    expect(summariseAttempts(undefined)).toEqual({ path: "first_attempt", smokeAttempts: 0, finalAttempts: 1, chainReported: false });
    const smoke = { runId: "run-1", stage: "smoke" as const, repairRound: 0, state: "COMPLETED", graph: { transformations: [{ id: "preview.min_steps" }] } };
    const final = { runId: "run-2", stage: "final" as const, repairRound: 0, state: "COMPLETED", graph: { approved: "x" } };
    expect(summariseAttempts([smoke, final])).toMatchObject({ path: "first_attempt", smokeAttempts: 1, finalAttempts: 1 });
    const tiled = { ...final, runId: "run-3", graph: { transformations: [{ id: "preview.min_steps" }, { id: "vae.tiled_decode" }] } };
    expect(attemptRepaired(tiled)).toBe(true);
    expect(summariseAttempts([smoke, tiled]).path).toBe("repaired");
    expect(summariseAttempts([{ ...final, repairRound: 1 }]).path).toBe("repaired");
    // The path is the first executable final's: a quality repair after it doesn't count.
    const executable = { ...final, execution: "passed" };
    const reseeded = { ...final, runId: "run-4", repairRound: 1, execution: "passed", graph: { transformations: [{ id: "seed.next" }] } };
    expect(summariseAttempts([smoke, executable, reseeded])).toMatchObject({ path: "first_attempt", smokeAttempts: 1, finalAttempts: 2 });
    // A first final that failed and a repaired one that passed: repaired.
    const failed = { ...final, execution: "failed" };
    const tiledPassed = { ...tiled, repairRound: 1, execution: "passed" };
    expect(summariseAttempts([smoke, failed, tiledPassed, reseeded]).path).toBe("repaired");
    // A smoke attempt that passed isn't the result.
    expect(summariseAttempts([{ ...smoke, execution: "passed" }, failed, tiledPassed]).path).toBe("repaired");
    const ids = ["at-01", "at-02", "at-03", "at-04"];
    const r = at04(ids, [
      { id: "at-01", execution: "passed", path: "first_attempt" },
      { id: "at-02", execution: "passed", path: "repaired" },
      { id: "at-03", execution: "failed", path: "repaired" },
    ]);
    expect(r).toMatchObject({ feasible: 4, rendered: 3, complete: false, executable: 2, firstAttempt: 1, repaired: 1, notExecutable: ["at-03"], notRendered: ["at-04"], share: 0.5, passed: false });
  });
});

