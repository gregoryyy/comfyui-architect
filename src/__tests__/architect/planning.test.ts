import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ObjectInfo, SystemStats } from "../../comfyui/types.js";
import { requireAdmissible, requireFeasible } from "../../services/architect/admission.js";
import { ArchitectPlanning, PlanningError, type RecipeSource } from "../../services/architect/planning.js";
import { ResultEnvelope, type TaskSpecInput } from "../../services/architect/schemas.js";
import { ArchitectService } from "../../services/architect/service.js";
import { ArchitectStore } from "../../services/architect/store.js";
import type { UpstreamFacade } from "../../services/architect/upstream.js";
import { registerArchitectTools } from "../../tools/architect.js";
import { fixtureObjectInfo, fixtureSnapshot } from "./fixtures/load.js";

const FIXTURES: RecipeSource = {
  id: "source-fixtures",
  kind: "fixture",
  dir: join(dirname(fileURLToPath(import.meta.url)), "fixtures"),
  trust: "test",
};

const STATS: SystemStats = {
  system: { os: "darwin", python_version: "3.12", embedded_python: false, comfyui_version: "0.44.0", ram_total: 1, ram_free: 1 },
  devices: [],
};

const TASK: TaskSpecInput = {
  intent: "A red bicycle against a white wall.",
  media: { kind: "image", operation: "text_to_image", output: { width: 1024, height: 768 } },
};

const dirs: string[] = [];

function writeBroken(dir: string): void {
  writeFileSync(join(dir, "broken.recipe.json"), "{ not json");
}
const stores: ArchitectStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(over: { objectInfo?: () => Promise<ObjectInfo>; models?: UpstreamFacade["installedModels"] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "architect-planning-"));
  dirs.push(dataDir);
  const store = ArchitectStore.open(dataDir);
  stores.push(store);
  let n = 0;
  const newId = () => `id${++n}`;
  const now = () => new Date();
  const upstream: UpstreamFacade = {
    comfyuiBaseUrl: () => "http://127.0.0.1:8188",
    systemStats: async () => STATS,
    objectInfo: over.objectInfo ?? (async () => fixtureObjectInfo()),
    installedModels: over.models ?? (async () => fixtureSnapshot().installedModels ?? { folders: {}, unanswered: [], absent: [] }),
    isPaidNode: () => false,
  };
  const service = new ArchitectService({ upstream, now, newId });
  const planning = new ArchitectPlanning({ store, service, upstream, dataDir, sources: [FIXTURES], now, newId });
  return { planning, store, dataDir, upstream, service };
}

describe("ArchitectPlanning, prepare to export", () => {
  it("runs one task to a validated export of files", async () => {
    const { planning, dataDir } = setup();
    const prepared = await planning.prepare({ task: TASK });
    expect(prepared.plan.state).toBe("DRAFT");
    expect(prepared.missingFields).toEqual([]);
    expect(prepared.recipes.map((r) => r.id)).toContain("recipe-fixture.t2i-basic");

    const proposed = await planning.propose({ planId: prepared.plan.id });
    expect(proposed.plan?.state).toBe("PROPOSED");
    const best = proposed.candidates[0];
    expect(best.status).toBe("feasible");

    const selected = planning.select({ planId: prepared.plan.id, candidateId: best.id });
    expect(selected.state).toBe("SELECTED");

    const exported = await planning.export({ planId: prepared.plan.id });
    expect(exported.dir).toBe(join(dataDir, "artifacts", prepared.task.id, prepared.plan.id));
    const names = exported.files.map((f) => f.split("/").pop()).sort();
    expect(names).toEqual(["dependencies.lock.json", "plan.json", "task.json", "validation.json", "workflow.api.json", "workflow.ui.json"]);
    expect(exported.uiGraph).toMatchObject({ exported: true, file: join(exported.dir, "workflow.ui.json") });
    const ui = JSON.parse(readFileSync(join(exported.dir, "workflow.ui.json"), "utf-8"));
    expect(Array.isArray(ui.nodes) && Array.isArray(ui.links)).toBe(true);
    const graph = JSON.parse(readFileSync(join(exported.dir, "workflow.api.json"), "utf-8"));
    expect(Object.values(graph).map((n) => (n as { class_type: string }).class_type)).toContain("SaveImage");
    const lock = JSON.parse(readFileSync(join(exported.dir, "dependencies.lock.json"), "utf-8"));
    expect(lock.graphFingerprint).toBe(best.graphFingerprint);
    expect(lock.models).toEqual([expect.objectContaining({ slot: "checkpoint", folder: "checkpoints", file: best.bindings.checkpoint })]);
  });

  it("asks for missing inputs and refuses to propose until they're given", async () => {
    const { planning } = setup();
    const prepared = await planning.prepare({ task: { ...TASK, media: { ...TASK.media, operation: "upscale" } } });
    expect(prepared.plan.state).toBe("NEEDS_INPUT");
    expect(prepared.missingFields).toEqual(["inputs: a source_image asset (operation upscale)"]);
    await expect(planning.propose({ planId: prepared.plan.id })).rejects.toMatchObject({ code: "MISSING_INPUT" });
    const revised = await planning.prepare({
      task: { ...TASK, media: { ...TASK.media, operation: "upscale" }, inputs: [{ assetId: "a1", role: "source_image" }] },
      taskId: prepared.task.id,
    });
    expect(revised.task.revision).toBe(2);
    expect(revised.plan.state).toBe("DRAFT");
  });

  it("refuses an invalid task with the fields named", async () => {
    const { planning } = setup();
    await expect(planning.prepare({ task: { intent: "x", media: { kind: "image", operation: "paint" } } })).rejects.toThrow(PlanningError);
  });

  it("won't select a blocked candidate, and won't export without a selection", async () => {
    const { planning } = setup();
    const prepared = await planning.prepare({ task: TASK });
    const proposed = await planning.propose({
      planId: prepared.plan.id,
      proposals: [{ recipeId: "recipe-fixture.t2i-basic", bindings: { checkpoint: "invented.safetensors" } }],
    });
    const blocked = proposed.candidates.find((c) => c.status === "blocked");
    expect(blocked).toBeDefined();
    expect(() => planning.select({ planId: prepared.plan.id, candidateId: blocked?.id ?? "" })).toThrow(/blocked/);
    await expect(planning.export({ planId: prepared.plan.id })).rejects.toThrow(/no selected candidate/);
  });

  it("keeps candidates diagnostic when the node schemas can't be read, so none can be selected", async () => {
    const { planning } = setup({ objectInfo: async () => Promise.reject(new Error("connect ECONNREFUSED")) });
    const prepared = await planning.prepare({ task: TASK });
    const proposed = await planning.propose({ planId: prepared.plan.id });
    expect(proposed.candidates.every((c) => c.status !== "feasible")).toBe(true);
    const c = proposed.candidates[0];
    expect(() => planning.select({ planId: prepared.plan.id, candidateId: c.id })).toThrow(PlanningError);
  });

  it("refuses to export a candidate whose recipe no longer compiles to the validated graph", async () => {
    const { planning, store } = setup();
    const prepared = await planning.prepare({ task: TASK });
    const proposed = await planning.propose({ planId: prepared.plan.id });
    const id = proposed.candidates[0].id;
    planning.select({ planId: prepared.plan.id, candidateId: id });
    const stored = store.getCandidate(id);
    if (!stored) throw new Error("candidate not stored");
    store.putCandidate({ ...stored, graphFingerprint: "0".repeat(64) });
    await expect(planning.export({ planId: prepared.plan.id })).rejects.toThrow(/no longer compiles/);
  });

  it("withdraws the selection when a recheck finds the candidate no longer feasible, and won't export it", async () => {
    let models = fixtureSnapshot().installedModels ?? { folders: {}, unanswered: [], absent: [] };
    const { planning } = setup({ models: async () => models });
    const prepared = await planning.prepare({ task: TASK });
    const best = (await planning.propose({ planId: prepared.plan.id })).candidates[0];
    planning.select({ planId: prepared.plan.id, candidateId: best.id });
    models = { ...models, folders: { ...models.folders, checkpoints: [] } };
    const rechecked = await planning.validate({ planId: prepared.plan.id, candidateId: best.id });
    expect(rechecked.candidate.status).toBe("blocked");
    expect(rechecked.selectionWithdrawn).toBe(true);
    expect(rechecked.planState).not.toBe("SELECTED");
    await expect(planning.export({ planId: prepared.plan.id })).rejects.toThrow(/no selected candidate/);
    expect(() => planning.select({ planId: prepared.plan.id, candidateId: best.id })).toThrow(/blocked/);
  });

  it("won't select or export a candidate whose stored status contradicts its checks", async () => {
    const { planning, store } = setup();
    const prepared = await planning.prepare({ task: TASK });
    const proposed = await planning.propose({
      planId: prepared.plan.id,
      proposals: [{ recipeId: "recipe-fixture.t2i-basic", bindings: { checkpoint: "invented.safetensors" } }],
    });
    const blocked = store.getCandidate(proposed.candidates[0].id);
    if (!blocked) throw new Error("candidate not stored");
    store.putCandidate({ ...blocked, status: "feasible" });
    expect(() => planning.select({ planId: prepared.plan.id, candidateId: blocked.id })).toThrow(/checks come to fail/);
  });

  it("refuses to export through a symbolic link under artifacts/", async () => {
    const { planning, dataDir } = setup();
    const prepared = await planning.prepare({ task: TASK });
    const best = (await planning.propose({ planId: prepared.plan.id })).candidates[0];
    planning.select({ planId: prepared.plan.id, candidateId: best.id });
    const elsewhere = mkdtempSync(join(tmpdir(), "architect-elsewhere-"));
    dirs.push(elsewhere);
    mkdirSync(join(dataDir, "artifacts"), { recursive: true });
    symlinkSync(elsewhere, join(dataDir, "artifacts", prepared.task.id));
    await expect(planning.export({ planId: prepared.plan.id })).rejects.toThrow(/symbolic link/);
    expect(existsSync(join(elsewhere, prepared.plan.id, "workflow.api.json"))).toBe(false);
  });

  it("exports without workflow.ui.json, and says why, when the node schemas can't be read at export", async () => {
    let fail = false;
    const info = fixtureObjectInfo();
    const { planning } = setup({ objectInfo: async () => (fail ? Promise.reject(new Error("connect ECONNREFUSED")) : info) });
    const prepared = await planning.prepare({ task: TASK });
    const best = (await planning.propose({ planId: prepared.plan.id })).candidates[0];
    planning.select({ planId: prepared.plan.id, candidateId: best.id });
    fail = true;
    const exported = await planning.export({ planId: prepared.plan.id });
    expect(exported.files.map((f) => f.split("/").pop())).not.toContain("workflow.ui.json");
    expect(exported.files).toHaveLength(5);
    expect(exported.uiGraph).toEqual({ exported: false, reason: expect.stringContaining("node schemas couldn't be read") });
    expect(existsSync(join(exported.dir, "workflow.ui.json"))).toBe(false);
  });

  it("exports without workflow.ui.json when the UI graph doesn't load back to the same graph", async () => {
    const info = fixtureObjectInfo();
    const { planning } = setup({ objectInfo: async () => info });
    const prepared = await planning.prepare({ task: TASK });
    const best = (await planning.propose({ planId: prepared.plan.id })).candidates[0];
    planning.select({ planId: prepared.plan.id, candidateId: best.id });
    // A sampler the schema no longer offers comes back substituted by upstream's converter.
    info.KSampler.input.required = { ...info.KSampler.input.required, sampler_name: [["other_sampler"]] };
    const exported = await planning.export({ planId: prepared.plan.id });
    expect(exported.uiGraph).toEqual({ exported: false, reason: expect.stringContaining("sampler_name") });
    expect(existsSync(join(exported.dir, "workflow.ui.json"))).toBe(false);
    expect(existsSync(join(exported.dir, "workflow.api.json"))).toBe(true);
  });

  it("plans only with the recipes the catalog holds now, and warns about files it couldn't load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "architect-recipes-"));
    dirs.push(dir);
    cpSync(join(FIXTURES.dir, "t2i-basic.recipe.json"), join(dir, "t2i-basic.recipe.json"));
    const source: RecipeSource = { ...FIXTURES, id: "source-tmp", dir };
    const first = setup();
    const p1 = new ArchitectPlanning({ store: first.store, service: first.service, upstream: first.upstream, dataDir: first.dataDir, sources: [source], now: () => new Date(), newId: () => `a${Math.random().toString(36).slice(2)}` });
    expect((await p1.prepare({ task: TASK })).recipes.map((r) => r.id)).toEqual(["recipe-fixture.t2i-basic"]);
    unlinkSync(join(dir, "t2i-basic.recipe.json"));
    writeBroken(dir);
    const p2 = new ArchitectPlanning({ store: first.store, service: first.service, upstream: first.upstream, dataDir: first.dataDir, sources: [source], now: () => new Date(), newId: () => `b${Math.random().toString(36).slice(2)}` });
    expect((await p2.prepare({ task: TASK })).recipes).toEqual([]);
    expect(p2.catalogWarnings().join(" ")).toContain("broken.recipe.json");
  });

  it("reads a candidate's graph on request only", async () => {
    const { planning } = setup();
    const prepared = await planning.prepare({ task: TASK });
    const proposed = await planning.propose({ planId: prepared.plan.id });
    expect("graph" in planning.get({ planId: prepared.plan.id })).toBe(false);
    const withGraph = planning.get({ planId: prepared.plan.id, graphOf: proposed.candidates[0].id });
    expect(withGraph.graph).toBeDefined();
  });

  it("lists capabilities with each recipe's fit, and reports recipe files it couldn't load", async () => {
    const { planning } = setup();
    const caps = await planning.capabilities();
    expect(caps.recipes.map((r) => r.id)).toEqual(expect.arrayContaining(["recipe-fixture.t2i-basic", "recipe-fixture.upscale-model"]));
    expect(caps.catalog.missingSources).toEqual([]);
  });
});

describe("acquirable candidates through select, validate, export and admission (TODO 4.2, 4.3)", () => {
  const MISSING = "missing.safetensors";
  const SOURCE = {
    kind: "huggingface",
    repo: "Comfy-Org/Real-ESRGAN",
    revision: "5fd49b7b278836f48af63ecd314d0f98ab336105",
    path: "split_files/checkpoints/missing.safetensors",
    sha256: "37f9a931c215f040aa6d50f711f2cb115f713c46df1d0d6469a8bd7bfe9a60bb",
    sizeBytes: 66857836,
  };

  /** A planning instance over one recipe: the t2i fixture with a missing, pinned checkpoint. */
  function acquirableSetup(over: Parameters<typeof setup>[0] = {}) {
    const dir = mkdtempSync(join(tmpdir(), "architect-recipes-"));
    dirs.push(dir);
    const recipe = JSON.parse(readFileSync(join(FIXTURES.dir, "t2i-basic.recipe.json"), "utf-8"));
    recipe.id = "recipe-fixture.t2i-acquire";
    recipe.slots = recipe.slots.map((s: { id: string }) => (s.id === "checkpoint" ? { ...s, default: MISSING } : s));
    recipe.modelSources = [{ folder: "checkpoints", file: MISSING, source: SOURCE }];
    writeFileSync(join(dir, "acquire.recipe.json"), JSON.stringify(recipe));
    const base = setup(over);
    const planning = new ArchitectPlanning({
      store: base.store,
      service: base.service,
      upstream: base.upstream,
      dataDir: base.dataDir,
      sources: [{ ...FIXTURES, id: "source-acquire", dir }],
      now: () => new Date(),
      newId: () => `q${Math.random().toString(36).slice(2)}`,
    });
    return { ...base, planning };
  }

  async function proposed(planning: ArchitectPlanning) {
    const prepared = await planning.prepare({ task: TASK });
    const out = await planning.propose({ planId: prepared.plan.id });
    return { planId: prepared.plan.id, candidate: out.candidates[0], plan: out.plan };
  }

  it("proposes it with the files to acquire, and the plan is PROPOSED, not BLOCKED", async () => {
    const { planning } = acquirableSetup();
    const { candidate, plan } = await proposed(planning);
    expect(candidate.status).toBe("acquirable");
    expect(plan?.state).toBe("PROPOSED");
    expect(candidate.acquisition).toEqual({
      files: [{ slot: "checkpoint", folder: "checkpoints", file: MISSING, size: "63.8 MiB", source: `Comfy-Org/Real-ESRGAN@5fd49b7b:${SOURCE.path}` }],
      total: "63.8 MiB",
      totalBytes: SOURCE.sizeBytes,
    });
  });

  it("selects it, keeps it acquirable on validate, and exports a lock that lists the pinned source", async () => {
    const { planning } = acquirableSetup();
    const { planId, candidate } = await proposed(planning);
    expect(planning.select({ planId, candidateId: candidate.id }).state).toBe("SELECTED");
    const rechecked = await planning.validate({ planId, candidateId: candidate.id });
    expect(rechecked.candidate.status).toBe("acquirable");
    expect(rechecked.planState).toBe("SELECTED");
    const exported = await planning.export({ planId });
    const lock = JSON.parse(readFileSync(join(exported.dir, "dependencies.lock.json"), "utf-8"));
    expect(lock.acquire).toEqual({ files: [{ slot: "checkpoint", folder: "checkpoints", file: MISSING, source: SOURCE }], totalBytes: SOURCE.sizeBytes });
    expect(lock.models).toEqual([expect.objectContaining({ slot: "checkpoint", file: MISSING })]);
  });

  it("becomes feasible on validate once the file is installed and offered, and drops its acquisition", async () => {
    let models = fixtureSnapshot().installedModels ?? { folders: {}, unanswered: [], absent: [] };
    const info = fixtureObjectInfo();
    const { planning, store } = acquirableSetup({ models: async () => models, objectInfo: async () => info });
    const { planId, candidate } = await proposed(planning);
    models = { ...models, folders: { ...models.folders, checkpoints: [...(models.folders.checkpoints ?? []), MISSING] } };
    info.CheckpointLoaderSimple.input = { required: { ckpt_name: [[MISSING]] } };
    expect((await planning.validate({ planId, candidateId: candidate.id })).candidate.status).toBe("feasible");
    expect(store.getCandidate(candidate.id)?.acquisition).toBeUndefined();
  });

  it("won't select a stored candidate edited to acquirable without the acquisition its checks give", async () => {
    const { planning, store } = acquirableSetup();
    const { planId, candidate } = await proposed(planning);
    const stored = store.getCandidate(candidate.id);
    if (!stored?.acquisition) throw new Error("candidate not stored as acquirable");
    // The schema refuses acquirable without an acquisition outright.
    const { acquisition: _a, ...bare } = stored;
    expect(() => store.putCandidate({ ...bare, status: "acquirable" })).toThrow();
    // A schema-valid edit: the same file from another commit.
    const edited = {
      ...stored,
      acquisition: { ...stored.acquisition, files: stored.acquisition.files.map((f) => ({ ...f, source: { ...f.source, revision: "0".repeat(40) } })) },
    };
    store.putCandidate(edited);
    expect(() => planning.select({ planId, candidateId: candidate.id })).toThrow(/recorded as acquirable/);
    // A blocked candidate relabelled acquirable is refused the same way.
    const blocked = await planning.propose({
      planId,
      proposals: [{ recipeId: "recipe-fixture.t2i-acquire", bindings: { checkpoint: "invented.safetensors" } }],
    });
    const b = store.getCandidate(blocked.candidates[0].id);
    if (!b) throw new Error("candidate not stored");
    expect(b.status).toBe("blocked");
    store.putCandidate({ ...b, status: "acquirable", acquisition: stored.acquisition });
    expect(() => planning.select({ planId, candidateId: b.id })).toThrow(/recorded as acquirable/);
  });

  it("is refused at admission unless the caller allows acquirable, and then comes back with its acquisition", async () => {
    const { planning } = acquirableSetup();
    const { planId, candidate } = await proposed(planning);
    planning.select({ planId, candidateId: candidate.id });
    await expect(requireFeasible(planning, planId, candidate.id)).rejects.toThrow(/is acquirable/);
    await expect(requireAdmissible(planning, planId, candidate.id)).rejects.toThrow(/is acquirable/);
    const admitted = await requireAdmissible(planning, planId, candidate.id, { allowAcquirable: true });
    expect(admitted.status).toBe("acquirable");
    expect(admitted.acquisition?.files.map((f) => f.source.sha256)).toEqual([SOURCE.sha256]);
    expect(() => planning.selectedForRun(planId)).toThrow(/is acquirable/);
    expect(planning.selectedForRun(planId, { allowAcquirable: true }).candidate.id).toBe(candidate.id);
  });

  it("stays blocked, with the reason, when the task forbids downloads", async () => {
    const { planning } = acquirableSetup();
    const prepared = await planning.prepare({ task: { ...TASK, constraints: { modelDownloads: "forbidden" } } });
    const out = await planning.propose({ planId: prepared.plan.id });
    expect(out.candidates[0].status).toBe("blocked");
    expect(out.plan?.state).toBe("BLOCKED");
    expect(out.plan?.blockers.policy_conflicts.join(" ")).toContain("downloads forbidden by the task");
    expect(() => planning.select({ planId: prepared.plan.id, candidateId: out.candidates[0].id })).toThrow(/blocked/);
  });
});

describe("the architect_plan tool", () => {
  async function client(planning: ArchitectPlanning, service: ArchitectService) {
    const server = new McpServer({ name: "t", version: "0" });
    registerArchitectTools(server, service, () => planning);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(b), c.connect(a)]);
    return c;
  }

  async function call(c: Client, args: Record<string, unknown>) {
    const res = await c.callTool({ name: "architect_plan", arguments: args });
    const content = res.content as { type: string; text: string }[];
    return { envelope: ResultEnvelope.parse(JSON.parse(content[0].text)), isError: res.isError === true };
  }

  it("returns schema-valid envelopes through prepare, propose, select and export", async () => {
    const { planning, service } = setup();
    const c = await client(planning, service);
    const prepared = await call(c, { action: "prepare", task: TASK });
    expect(prepared.envelope.status).toBe("ok");
    const planId = (prepared.envelope.data.plan as { id: string }).id;
    const proposed = await call(c, { action: "propose", planId });
    const best = (proposed.envelope.data.candidates as { id: string; status: string }[])[0];
    expect(best.status).toBe("feasible");
    expect((await call(c, { action: "select", planId, candidateId: best.id })).envelope.summary).toContain("Nothing was run");
    const exported = await call(c, { action: "export", planId });
    expect(exported.envelope.artifacts).toHaveLength(6);
    expect(exported.envelope.status).toBe("ok");
    for (const f of exported.envelope.artifacts) expect(existsSync(f)).toBe(true);
  });

  it("answers a missing field with MISSING_INPUT and a next step, as an error envelope", async () => {
    const { planning, service } = setup();
    const c = await client(planning, service);
    const res = await call(c, { action: "propose" });
    expect(res.isError).toBe(true);
    expect(res.envelope.error).toMatchObject({ code: "MISSING_INPUT", retryable: false });
  });
});
