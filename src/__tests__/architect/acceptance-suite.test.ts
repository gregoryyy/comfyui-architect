// The reference acceptance suite in CI (spec §19.2; TODO 6.5.2; ARCH 2026-11-16, milestone 6,
// acceptance suite): every fixture in architect/acceptance/ is planned through the planning
// service (prepare, then propose restricted to its recipeIds with its proposals) against a
// fake facade that serves the node schemas of ComfyUI Desktop 0.44.0, the reference target's
// model lists with every shipped recipe's default files installed (what milestone 5 placed),
// and the synthetic inputs of inputs.json at their recorded sizes.
//
// AT-01: a `refused` fixture fails TaskSpecInput, and prepare refuses it. AT-02: a `blocked`
// fixture has no feasible or acquirable candidate and a blocker in its category, and no
// candidate reports a hard unknown as passing. AT-10: an Apple unified-memory and a
// dedicated-GPU device snapshot, asserting what resources.ts does today.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NodeInputSpec, ObjectInfo, SystemStats } from "../../comfyui/types.js";
import {
  type AcceptanceFixture,
  type AcceptanceInputs,
  type BlockerCategory,
  at04,
  attemptRepaired,
  egressViolations,
  inputName,
  inputSvg,
  isLocalDestination,
  loadAcceptanceFixtures,
  parseEgressLog,
  summariseAttempts,
} from "../../services/architect/acceptance.js";
import { SHIPPED_RECIPES_DIR, loadRecipeDir } from "../../services/architect/catalog.js";
import { ArchitectPlanning, PlanningError, type RecipeSource } from "../../services/architect/planning.js";
import { type FetchLike, ResourceCoordinator, memoryPool } from "../../services/architect/resources.js";
import { type PlanCandidate, type Recipe, RunRecord, TaskSpecInput } from "../../services/architect/schemas.js";
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
const inputs: AcceptanceInputs = loaded.inputs ?? { schemaVersion: 1, folder: "architect-acceptance", files: [] };
const shipped: Recipe[] = loadRecipeDir(SHIPPED_RECIPES_DIR, { shipped: true }).recipes.map((r) => r.recipe);

/**
 * Fixtures whose expectation planning doesn't meet today, with the reason and what planning
 * does instead. Each runs twice: as `it.fails` against the fixture's expectation, so it flips
 * to a failure once planning meets it, and as `it` against the observed behaviour, so nothing
 * else about it can regress unseen. The fixtures keep their expectations: which side changes
 * is the orchestrator's decision.
 *
 * All five have one cause: planner.ts `addBlockers` files a failing contract check under
 * `unsupported_operation` only for `contract.operation*` and `contract.task.inputs.*`, and
 * every other failing contract check under `missing_dependencies`, though nothing can be
 * installed to resolve these.
 */
const KNOWN_DISAGREEMENTS: Record<string, { reason: string; actual: BlockerCategory }> = {
  "at-22": { reason: "contract.task.count fails and is filed under missing_dependencies", actual: "missing_dependencies" },
  "at-23": { reason: "contract.task.format fails and is filed under missing_dependencies", actual: "missing_dependencies" },
  "at-24": { reason: "contract.task.width and .height (the latent's step) fail and are filed under missing_dependencies", actual: "missing_dependencies" },
  "at-27": { reason: "contract.mask_size fails and is filed under missing_dependencies", actual: "missing_dependencies" },
  "at-28": { reason: "contract.protected_region.outside-mask fails and is filed under missing_dependencies", actual: "missing_dependencies" },
};

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
function referenceObjectInfo(removed: ReadonlySet<string>): ObjectInfo {
  const info = capture();
  for (const r of shipped) {
    for (const s of r.slots.filter((x) => x.valueType === "model_file" && typeof x.default === "string")) {
      const cls = r.graph[s.target.node].class_type;
      const file = String(s.default);
      if (removed.has(`${s.modelFolder}/${file}`)) removeChoice(info, cls, s.target.input, file);
      else addChoice(info, cls, s.target.input, file);
    }
  }
  // ComfyUI's image loaders list the input folder, subfolders included (ARCH 2026-11-16,
  // input images): every loader whose `image` input is an upload combo lists the inputs.
  for (const [cls, def] of Object.entries(info)) {
    const spec = def.input?.required?.image;
    if (!spec || !Array.isArray(spec[0]) || !(typeof spec[1] === "object" && spec[1] !== null && "image_upload" in spec[1])) continue;
    for (const f of inputs.files) addChoice(info, cls, "image", inputName(inputs, f));
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
async function planFixture(f: AcceptanceFixture, stats?: SystemStats) {
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

async function checkFixture(f: AcceptanceFixture, category?: BlockerCategory): Promise<void> {
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
    // AT-02: blocked, with a reason in the expected category.
    expect(candidates.filter((c) => c.status === "feasible" || c.status === "acquirable").map((c) => c.recipeId)).toEqual([]);
    expect(plan.state).toBe("BLOCKED");
    expect(plan.blockers[category ?? f.expect.category], JSON.stringify(plan.blockers)).not.toEqual([]);
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

  it("reject a fixture with an unknown field, a mismatched expectation or a live environment change", async () => {
    const { AcceptanceFixture } = await import("../../services/architect/acceptance.js");
    const base = loaded.fixtures[0];
    expect(AcceptanceFixture.safeParse(base).success).toBe(true);
    expect(AcceptanceFixture.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(AcceptanceFixture.safeParse({ ...base, expect: { outcome: "blocked" } }).success).toBe(false);
    expect(AcceptanceFixture.safeParse({ ...base, expect: { outcome: "blocked", category: "other" } }).success).toBe(false);
    expect(AcceptanceFixture.safeParse({ ...base, expect: { outcome: "feasible", recipes: ["recipe-other"] } }).success).toBe(false);
    expect(AcceptanceFixture.safeParse({ ...base, environment: { removeModels: ["vae/x.safetensors"] } }).success).toBe(false);
    expect(AcceptanceFixture.safeParse({ ...base, live: "fixture_only", environment: { removeModels: ["no-folder"] } }).success).toBe(false);
  });
});

describe("the acceptance suite against the reference target (AT-01, AT-02)", () => {
  for (const f of loaded.fixtures) {
    const label = `${f.id} (${f.expect.outcome}${f.expect.outcome === "blocked" ? `: ${f.expect.category}` : ""}): ${f.title}`;
    const known = KNOWN_DISAGREEMENTS[f.id];
    if (known) {
      it.fails(`${label} [known disagreement: ${known.reason}]`, () => checkFixture(f));
      it(`${f.id} as planned today: blocked, with the reason under ${known.actual}`, () => checkFixture(f, known.actual));
    } else {
      it(label, () => checkFixture(f));
    }
  }
});

describe("resource profiles (AT-10)", () => {
  const at01 = loaded.fixtures.find((f) => f.id === "at-01");

  it.each([
    ["Apple unified memory", APPLE_UNIFIED],
    ["a dedicated GPU", DEDICATED_GPU],
  ])("on %s the snapshot keeps devices and RAM as reported, and planning sums no memory", async (_name, stats) => {
    if (!at01) throw new Error("at-01 is missing");
    const { prepared, candidates } = await planFixture(at01, stats);
    expect(candidates.some((c) => c.status === "feasible")).toBe(true);
    // Nothing is added up: no estimate counts the unified pool as both VRAM and RAM.
    for (const c of candidates) expect(c.resourceEstimate.status).toBe("unknown");
    expect(prepared.environment.probeErrors).toEqual([]);
  });

  it("records the unified pool as one device whose memory is the machine's RAM, and the dedicated GPU's VRAM apart from RAM", async () => {
    for (const [stats, expected] of [
      [APPLE_UNIFIED, { ramTotal: 48 * GiB, devices: [{ type: "mps", memoryTotal: 48 * GiB }] }],
      [DEDICATED_GPU, { ramTotal: 64 * GiB, devices: [{ type: "cuda", memoryTotal: 24 * GiB }] }],
    ] as const) {
      const { planning } = setup({}, stats);
      const { snapshot } = await planning.environment();
      expect(snapshot).toMatchObject(expected);
      expect(snapshot.devices?.length).toBe(1);
    }
  });

  it("leases one memory pool per target, whatever the devices: a second run on the same target waits", async () => {
    // resources.ts keys the pool by the target's base URL only (`memoryPool`): a dedicated
    // GPU's VRAM and its RAM aren't two pools today, and unified memory isn't counted twice.
    const dir = mkdtempSync(join(tmpdir(), "architect-acceptance-pool-"));
    dirs.push(dir);
    const store = ArchitectStore.open(dir, { now: () => new Date("2026-11-15T12:02:30.000Z") });
    stores.push(store);
    const run = seedRun(store);
    const refused: FetchLike = async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    };
    const c = new ResourceCoordinator({
      store,
      upstream: new FakeOllama().facade(),
      ownerId: "instance-a",
      now: () => new Date("2026-11-15T12:02:30.000Z"),
      manageResidency: false,
      fetchImpl: refused,
      probeTimeoutMs: 20,
    });
    const first = await c.acquire(run);
    expect(first).toMatchObject({ ok: true, lease: { pool: memoryPool(BASE_URL), runId: run.id } });
    const second = await c.acquire(RunRecord.parse({ ...run, id: "run-second" }));
    expect(second).toMatchObject({ ok: false, code: "RESOURCE_BUSY", retry: true });
    expect(memoryPool(`${BASE_URL}/`)).toBe(memoryPool(BASE_URL));
    expect(memoryPool("http://127.0.0.1:8189")).not.toBe(memoryPool(BASE_URL));
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
    const ids = ["at-01", "at-02", "at-03", "at-04"];
    const r = at04(ids, [
      { id: "at-01", execution: "passed", path: "first_attempt" },
      { id: "at-02", execution: "passed", path: "repaired" },
      { id: "at-03", execution: "failed", path: "repaired" },
    ]);
    expect(r).toMatchObject({ feasible: 4, rendered: 3, complete: false, executable: 2, firstAttempt: 1, repaired: 1, notExecutable: ["at-03"], notRendered: ["at-04"], share: 0.5, passed: false });
  });
});

