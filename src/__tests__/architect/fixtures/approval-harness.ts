// A selected plan on the fixture recipe with a fake run driver, for the approval and
// execution tests (TODO 3.3-3.8).
import { afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SystemStats } from "../../../comfyui/types.js";
import type { AdmissionDeps } from "../../../services/architect/admission.js";
import { ArchitectExecution, type RunDriver } from "../../../services/architect/execution.js";
import { ArchitectPlanning, type RecipeSource } from "../../../services/architect/planning.js";
import type { InstalledModels, ReleaseResidencyEffect, TaskSpecInput } from "../../../services/architect/schemas.js";
import { ArchitectService } from "../../../services/architect/service.js";
import { ArchitectStore } from "../../../services/architect/store.js";
import type { UpstreamFacade } from "../../../services/architect/upstream.js";
import { fixtureObjectInfo, fixtureSnapshot } from "./load.js";

const FIXTURES: RecipeSource = {
  id: "source-fixtures",
  kind: "fixture",
  dir: dirname(fileURLToPath(import.meta.url)),
  trust: "test",
};

const STATS: SystemStats = {
  system: { os: "darwin", python_version: "3.12", embedded_python: false, comfyui_version: "0.44.0", ram_total: 1, ram_free: 1 },
  devices: [],
};

/**
 * The fixture task. It allows no preview runs, so its plan has one render and binds what a
 * plan bound before stages existed (TODO 6.2): the tests of milestones 3 to 5 keep checking
 * that path. The stages and repairs have their tests in attempts.test.ts.
 */
export const TASK: TaskSpecInput = {
  intent: "A red bicycle against a white wall.",
  media: { kind: "image", operation: "text_to_image", output: { width: 1024, height: 768 } },
  budgets: { maxPreviewRuns: 0 },
};

const BASE = "http://127.0.0.1:8188";
const dirs: string[] = [];
const stores: ArchitectStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A selected plan on the fixture recipe for `task` (TASK by default), a fake driver, and a clock the test moves. */
export async function setup(task: TaskSpecInput = TASK) {
  const dataDir = mkdtempSync(join(tmpdir(), "architect-execution-"));
  dirs.push(dataDir);
  const store = ArchitectStore.open(dataDir);
  stores.push(store);
  let n = 0;
  const newId = () => `id${++n}`;
  let clock = Date.parse("2026-11-15T12:00:00.000Z");
  const now = () => new Date(clock);
  const advance = (ms: number) => {
    clock += ms;
  };
  let baseUrl = BASE;
  let version: string | undefined = "0.44.0";
  let models: InstalledModels = fixtureSnapshot().installedModels ?? { folders: {}, unanswered: [], absent: [] };
  const upstream = {
    comfyuiBaseUrl: () => baseUrl,
    systemStats: async () => ({ ...STATS, system: { ...STATS.system, comfyui_version: version } }),
    objectInfo: async () => fixtureObjectInfo(),
    installedModels: async () => models,
    isPaidNode: () => false,
  } as Pick<UpstreamFacade, "comfyuiBaseUrl" | "systemStats" | "objectInfo" | "installedModels" | "isPaidNode">;
  const service = new ArchitectService({ upstream: upstream as UpstreamFacade, now, newId });
  const planning = new ArchitectPlanning({ store, service, upstream, dataDir, sources: [FIXTURES], now, newId });
  const prepared = await planning.prepare({ task });
  const proposed = await planning.propose({ planId: prepared.plan.id });
  const best = proposed.candidates.find((c) => c.status === "feasible");
  if (!best) throw new Error("fixture has no feasible candidate");
  planning.select({ planId: prepared.plan.id, candidateId: best.id });

  const driver: RunDriver = {
    advance: vi.fn(async (runId: string) => store.getRun(runId)!),
    reconcile: vi.fn(async (runId: string) => store.getRun(runId)!),
    cancel: vi.fn(async (runId: string) => store.getRun(runId)!),
  };
  let releasable: ReleaseResidencyEffect | undefined;
  const admission: AdmissionDeps = { store, planning, baseUrl: () => baseUrl, now, newId, releasable: async () => releasable };
  const execution = new ArchitectExecution({
    ...admission,
    driver,
    dataDir,
    dependencyLock: (candidateId, task) => planning.dependencyLock(candidateId, task),
  });
  return {
    store,
    planning,
    execution,
    driver,
    dataDir,
    planId: prepared.plan.id,
    now,
    newId,
    advance,
    setBaseUrl: (u: string) => {
      baseUrl = u;
    },
    setModels: (m: InstalledModels) => {
      models = m;
    },
    setVersion: (v: string | undefined) => {
      version = v;
    },
    /** What Ollama holds in the pool, as the resource coordinator would report it (GAPS Q23). */
    setReleasable: (e: ReleaseResidencyEffect | undefined) => {
      releasable = e;
    },
  };
}

