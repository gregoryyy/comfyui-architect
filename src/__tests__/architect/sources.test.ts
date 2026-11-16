// The source registry (spec §8.5; GAPS Q32; TODO 5.2): the built-in entries, their refresh
// state, and migration 5 on an existing database.

import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FamilyObserver } from "../../services/architect/families.js";
import { MIGRATIONS, SCHEMA_MIGRATIONS_SQL } from "../../services/architect/migrations.js";
import { ArchitectPlanning, type RecipeSource } from "../../services/architect/planning.js";
import { ModelObservation, SourceRegistryEntry } from "../../services/architect/schemas.js";
import { ArchitectService } from "../../services/architect/service.js";
import {
  COMFYUI_TEMPLATES_SOURCE_ID,
  HUGGINGFACE_SOURCE_ID,
  UPSTREAM_PACKS_DIR,
  UPSTREAM_PACKS_SOURCE_ID,
  builtInSources,
  ensureBuiltInSources,
} from "../../services/architect/sources.js";
import { ArchitectStore } from "../../services/architect/store.js";
import type { UpstreamFacade } from "../../services/architect/upstream.js";
import { fixtureObjectInfo, fixtureSnapshot } from "./fixtures/load.js";

const T = "2026-11-16T09:00:00.000Z";
const T1 = "2026-11-16T09:05:00.000Z";
const BASE = "http://127.0.0.1:8188";

const dirs: string[] = [];
const stores: ArchitectStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function open(dir?: string): { store: ArchitectStore; dir: string } {
  const d = dir ?? mkdtempSync(join(tmpdir(), "architect-sources-"));
  if (!dir) dirs.push(d);
  const store = ArchitectStore.open(d);
  stores.push(store);
  return { store, dir: d };
}

describe("built-in sources", () => {
  it("registers huggingface, comfyui-templates and upstream-packs, unrefreshed", () => {
    const { store } = open();
    const { sources, errors } = ensureBuiltInSources(store, `${BASE}/`);
    expect(errors).toEqual([]);
    expect(sources.map((s) => [s.id, s.adapter, s.allowedOps, s.trust, s.state])).toEqual([
      [HUGGINGFACE_SOURCE_ID, "huggingface_pinned", ["download"], "approved", "unrefreshed"],
      [COMFYUI_TEMPLATES_SOURCE_ID, "comfyui_template_index", ["list", "import"], "vendor", "unrefreshed"],
      [UPSTREAM_PACKS_SOURCE_ID, "upstream_packs", ["list", "import"], "upstream", "unrefreshed"],
    ]);
    expect(store.getSource(COMFYUI_TEMPLATES_SOURCE_ID)?.root).toBe(`${BASE}/templates/index.json`);
    expect(store.getSource(HUGGINGFACE_SOURCE_ID)?.root).toBe("https://huggingface.co");
    expect(store.listSources().map((s) => s.id)).toEqual(["comfyui-templates", "huggingface", "upstream-packs"]);
  });

  it("resolves upstream-packs to the repository's packs/, as upstream's list_packs does", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    expect(UPSTREAM_PACKS_DIR).toBe(join(repoRoot, "packs"));
    expect(existsSync(UPSTREAM_PACKS_DIR)).toBe(true);
  });

  it("keeps the refresh state when ensured again, and starts over when the target changes", () => {
    const { store } = open();
    ensureBuiltInSources(store, BASE);
    store.recordSourceRefresh({ id: COMFYUI_TEMPLATES_SOURCE_ID, at: new Date(T), outcome: { ok: true } });
    ensureBuiltInSources(store, BASE);
    expect(store.getSource(COMFYUI_TEMPLATES_SOURCE_ID)).toMatchObject({ state: "ok", lastRefreshAt: T });
    ensureBuiltInSources(store, "http://127.0.0.1:8190");
    const moved = store.getSource(COMFYUI_TEMPLATES_SOURCE_ID);
    expect(moved).toMatchObject({ state: "unrefreshed", root: "http://127.0.0.1:8190/templates/index.json" });
    expect(moved?.lastRefreshAt).toBeUndefined();
  });

  it("reports a target URL the registry refuses instead of dropping the source silently", () => {
    const { store } = open();
    const { sources, errors } = ensureBuiltInSources(store, "cloud");
    expect(sources.map((s) => s.id)).toEqual([HUGGINGFACE_SOURCE_ID, UPSTREAM_PACKS_SOURCE_ID]);
    expect(errors).toEqual([{ id: COMFYUI_TEMPLATES_SOURCE_ID, message: expect.stringContaining("http(s) URL") }]);
  });
});

describe("refresh outcomes", () => {
  it("an unreachable source is unavailable with its reason and keeps its last successful refresh", () => {
    const { store } = open();
    ensureBuiltInSources(store, BASE);
    store.recordSourceRefresh({ id: COMFYUI_TEMPLATES_SOURCE_ID, at: new Date(T), outcome: { ok: true } });
    const down = store.recordSourceRefresh({ id: COMFYUI_TEMPLATES_SOURCE_ID, at: new Date(T1), outcome: { ok: false, reason: "connection refused" } });
    expect(down).toMatchObject({ state: "unavailable", unavailableReason: "connection refused", lastRefreshAt: T, lastAttemptAt: T1 });
    const up = store.recordSourceRefresh({ id: COMFYUI_TEMPLATES_SOURCE_ID, at: new Date(T1), outcome: { ok: true } });
    expect(up).toMatchObject({ state: "ok", lastRefreshAt: T1 });
    expect(up.unavailableReason).toBeUndefined();
  });

  it("refuses a refresh of a source that isn't registered", () => {
    const { store } = open();
    expect(() => store.recordSourceRefresh({ id: "nope", at: new Date(T), outcome: { ok: true } })).toThrow(/not registered/);
  });
});

describe("SourceRegistryEntry", () => {
  const [hf, templates, packs] = builtInSources(BASE).map((d) => ({ schemaVersion: 1, ...d, state: "unrefreshed" }));

  it("accepts the built-in entries", () => {
    for (const e of [hf, templates, packs]) expect(SourceRegistryEntry.safeParse(e).success).toBe(true);
  });

  it("refuses an operation the adapter can't do, a root of the wrong kind, and an inconsistent state", () => {
    expect(SourceRegistryEntry.safeParse({ ...hf, allowedOps: ["download", "import"] }).success).toBe(false);
    expect(SourceRegistryEntry.safeParse({ ...templates, allowedOps: ["download"] }).success).toBe(false);
    expect(SourceRegistryEntry.safeParse({ ...templates, allowedOps: ["list", "list"] }).success).toBe(false);
    expect(SourceRegistryEntry.safeParse({ ...packs, root: "packs" }).success).toBe(false);
    expect(SourceRegistryEntry.safeParse({ ...templates, root: "/templates/index.json" }).success).toBe(false);
    expect(SourceRegistryEntry.safeParse({ ...templates, state: "unavailable", lastAttemptAt: T }).success).toBe(false);
    expect(SourceRegistryEntry.safeParse({ ...templates, state: "ok", lastAttemptAt: T }).success).toBe(false);
    expect(SourceRegistryEntry.safeParse({ ...templates, state: "ok", lastRefreshAt: T, lastAttemptAt: T }).success).toBe(true);
  });
});

describe("migration 5", () => {
  it("applies on a database at version 4 and adds the observation and source tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "architect-m5-"));
    dirs.push(dir);
    const db = new BetterSqlite3(join(dir, "architect.db"));
    db.exec(SCHEMA_MIGRATIONS_SQL);
    for (const m of MIGRATIONS.filter((x) => x.version <= 4)) {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, T);
    }
    db.close();
    const { store } = open(dir);
    ensureBuiltInSources(store, BASE);
    expect(store.listSources()).toHaveLength(3);
    const obs = ModelObservation.parse({
      schemaVersion: 1,
      folder: "vae",
      file: "ae.safetensors",
      sizeBytes: 335304388,
      mtimeMs: 1,
      path: "/m/vae/ae.safetensors",
      rulesDigest: "a".repeat(64),
      outcome: "matched",
      family: "flux-ae",
      matches: ["flux-ae"],
      reason: "244 tensors",
      observedAt: T,
    });
    store.putModelObservation(obs);
    store.putModelObservation({ ...obs, mtimeMs: 2 });
    expect(store.getModelObservation("vae", "ae.safetensors")?.mtimeMs).toBe(2);
    const check = new BetterSqlite3(join(dir, "architect.db"));
    expect(check.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: 5 });
    expect(check.prepare("SELECT COUNT(*) AS n FROM model_observations").get()).toEqual({ n: 1 });
    // A payload moved to another row is refused on read.
    check.prepare("UPDATE model_observations SET file = 'other.safetensors'").run();
    check.close();
    expect(() => store.getModelObservation("vae", "other.safetensors")).toThrow(/carries/);
  });
});

describe("planning shows the sources and uses family observations", () => {
  const FIXTURES: RecipeSource = { id: "source-fixtures", kind: "fixture", dir: join(dirname(fileURLToPath(import.meta.url)), "fixtures"), trust: "test" };

  function planningWith(families?: Pick<FamilyObserver, "observeAll">) {
    const { store, dir } = open();
    let n = 0;
    const newId = () => `id${++n}`;
    const now = () => new Date(T);
    const upstream = {
      comfyuiBaseUrl: () => BASE,
      systemStats: async () => ({
        system: { os: "darwin", python_version: "3.12", embedded_python: false, comfyui_version: "0.44.0", ram_total: 1, ram_free: 1 },
        devices: [],
      }),
      objectInfo: async () => fixtureObjectInfo(),
      installedModels: async () => fixtureSnapshot().installedModels ?? { folders: {}, unanswered: [], absent: [] },
      isPaidNode: () => false,
    } as Pick<UpstreamFacade, "comfyuiBaseUrl" | "systemStats" | "objectInfo" | "installedModels" | "isPaidNode">;
    const service = new ArchitectService({ upstream: upstream as UpstreamFacade, now, newId });
    return new ArchitectPlanning({ store, service, upstream, dataDir: dir, sources: [FIXTURES], now, newId, ...(families ? { families } : {}) });
  }

  it("capabilities lists the registry with each source's state", async () => {
    const caps = await planningWith().capabilities();
    expect(caps.sources.map((s) => [s.id, s.state])).toEqual([
      ["comfyui-templates", "unrefreshed"],
      ["huggingface", "unrefreshed"],
      ["upstream-packs", "unrefreshed"],
    ]);
    expect(caps.sourceErrors).toEqual([]);
  });

  it("propose observes the files candidates bind and reports the ones it couldn't read", async () => {
    const asked: { folder: string; file: string }[][] = [];
    const planning = planningWith({
      observeAll: async (files) => {
        asked.push([...files]);
        return {
          evidence: { rules: [], observations: new Map() },
          unobserved: files.map((f) => ({ ...f, reason: "no local ComfyUI path is configured" })),
        };
      },
    });
    const prepared = await planning.prepare({
      task: { intent: "A red bicycle.", media: { kind: "image", operation: "text_to_image", output: { width: 1024, height: 768 } } },
    });
    const proposed = await planning.propose({ planId: prepared.plan.id });
    expect(asked).toEqual([[{ folder: "checkpoints", file: "sd_xl_base_1.0.safetensors" }]]);
    expect(proposed.familiesUnobserved).toEqual([{ folder: "checkpoints", file: "sd_xl_base_1.0.safetensors", reason: "no local ComfyUI path is configured" }]);
    // Unobserved stays as before: the default's family is a soft unknown, so the candidate is feasible.
    expect(proposed.candidates[0].status).toBe("feasible");
  });
});
