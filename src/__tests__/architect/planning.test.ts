import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ObjectInfo, SystemStats } from "../../comfyui/types.js";
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

    const exported = planning.export({ planId: prepared.plan.id });
    expect(exported.dir).toBe(join(dataDir, "artifacts", prepared.task.id, prepared.plan.id));
    const names = exported.files.map((f) => f.split("/").pop()).sort();
    expect(names).toEqual(["dependencies.lock.json", "plan.json", "task.json", "validation.json", "workflow.api.json"]);
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
    expect(() => planning.export({ planId: prepared.plan.id })).toThrow(/no selected candidate/);
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
    expect(() => planning.export({ planId: prepared.plan.id })).toThrow(/no longer compiles/);
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
    expect(exported.envelope.artifacts).toHaveLength(5);
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
