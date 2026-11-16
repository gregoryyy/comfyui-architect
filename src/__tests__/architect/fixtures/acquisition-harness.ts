// Fakes for the acquisition tests (TODO 4.5): upstream's downloader with its download
// cache, Hugging Face's HEAD answers, temporary model roots, and a selected plan whose only
// missing model file has a pinned source. Shared by acquisition-run.test.ts and the route
// tests (AT-05).

import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, vi } from "vitest";
import type { ObjectInfo, SystemStats } from "../../../comfyui/types.js";
import {
  type AcquisitionFacade,
  type AcquisitionFs,
  type AcquisitionIo,
  type HeadFetch,
  NODE_ACQUISITION_FS,
} from "../../../services/architect/acquisition.js";
import { MIN_FREE_DISK_BYTES } from "../../../services/architect/acquisition-policy.js";
import { ArchitectExecution, type RunDriver } from "../../../services/architect/execution.js";
import { ArchitectPlanning, type RecipeSource } from "../../../services/architect/planning.js";
import { type AcquireModelsEffect, type InstalledModels, ModelSource, type RunRecord } from "../../../services/architect/schemas.js";
import { ArchitectService } from "../../../services/architect/service.js";
import { ArchitectStore } from "../../../services/architect/store.js";
import type { DownloadStatus, UpstreamFacade } from "../../../services/architect/upstream.js";
import { TASK } from "./approval-harness.js";
import { fixtureObjectInfo, fixtureSnapshot } from "./load.js";

export const BYTES = Buffer.from("pretend these are the weights of an upscale model\n".repeat(64));
export const SHA = createHash("sha256").update(BYTES).digest("hex");
export const COMMIT = "5fd49b7b278836f48af63ecd314d0f98ab336105";
export const MISSING = "missing.safetensors";
export const PLENTY = MIN_FREE_DISK_BYTES * 4;

export const SOURCE = ModelSource.parse({
  kind: "huggingface",
  repo: "Comfy-Org/Real-ESRGAN",
  revision: COMMIT,
  path: "split files/checkpoints/missing.safetensors",
  sha256: SHA,
  sizeBytes: BYTES.length,
  license: "bsd-3-clause",
});

const dirs: string[] = [];
/** Stores the tests open; closed after each test. */
export const stores: ArchitectStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A model root with a `checkpoints` folder, as ComfyUI's models directory. */
export function modelRoot(): string {
  const root = tempDir("architect-models-");
  mkdirSync(join(root, "checkpoints"));
  return root;
}

// ---------------------------------------------------------------------------------------
// Fakes

export interface FakeJob {
  status: DownloadStatus["status"];
  target: string;
  url: string;
  bytes?: number;
  totalBytes?: number;
  error?: string;
}

/**
 * Upstream's downloader as the facade shows it: like upstream, it writes the file into its
 * download cache first, then hard-links it (or copies it, with `copyFromCache`) to the
 * staging path, and keeps the cache entry and its Content-Type sidecar.
 */
export class FakeDownloads implements AcquisitionFacade {
  jobs = new Map<string, FakeJob>();
  /** Upstream's download cache directory. */
  cacheDir = tempDir("architect-dlcache-");
  copyFromCache = false;
  token: string | undefined;
  started: { url: string; subfolder: string; filename: string }[] = [];
  cancelled: string[] = [];
  forgot = 0;
  manager = false;
  startFails = false;
  /** Where the resolver would put a subfolder; by default under `root`. */
  resolveTo?: (subfolder: string, file: string) => { root: string; path: string };
  private n = 0;

  constructor(public root: string) {}

  resolveModelDestination = async (subfolder: string, file: string) => this.resolveTo?.(subfolder, file) ?? { root: this.root, path: join(this.root, subfolder, file) };
  downloadRoutesToManager = async () => this.manager;
  startDownload = async (args: { url: string; subfolder: string; filename: string }) => {
    if (this.startFails) throw new Error("upstream refused the request");
    this.started.push(args);
    const jobId = `job-${++this.n}`;
    this.jobs.set(jobId, { status: "downloading", target: join(this.root, args.subfolder, args.filename), url: args.url });
    return { jobId };
  };
  downloadStatus = async (jobId: string): Promise<DownloadStatus> => {
    const j = this.jobs.get(jobId);
    if (!j) return { status: "missing" };
    return {
      status: j.status,
      ...(j.status === "done" ? { path: j.target } : {}),
      ...(j.bytes !== undefined ? { bytes: j.bytes } : {}),
      ...(j.totalBytes !== undefined ? { totalBytes: j.totalBytes } : {}),
      ...(j.error ? { error: j.error } : {}),
    };
  };
  cancelDownload = async (jobId: string) => {
    this.cancelled.push(jobId);
    const j = this.jobs.get(jobId);
    if (j?.status === "downloading") j.status = "cancelled";
    return { cancelled: j !== undefined, message: j ? `download ${jobId} aborted` : `no download ${jobId}` };
  };
  forgetNodeSchemas = () => {
    this.forgot += 1;
  };
  downloadCacheEntry = (url: string) => {
    const key = createHash("sha256").update(url).digest("hex").slice(0, 32);
    return {
      dir: this.cacheDir,
      cachePath: join(this.cacheDir, `${key}.safetensors`),
      partialPath: join(this.cacheDir, `.${key}.safetensors.partial`),
      contentTypeSidecar: join(this.cacheDir, `.${key}.safetensors.ct`),
    };
  };
  huggingfaceToken = () => this.token;

  /** Bytes so far in upstream's cache `.partial`, as the writer leaves them while it streams. */
  partial(jobId: string, bytes: number): void {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error(`no job ${jobId}`);
    writeFileSync(this.downloadCacheEntry(j.url).partialPath, Buffer.alloc(bytes));
  }

  /** The transfer lands: into the cache, then linked or copied to where upstream resolved the file. */
  finish(jobId: string, bytes: Buffer = BYTES): void {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error(`no job ${jobId}`);
    const entry = this.downloadCacheEntry(j.url);
    rmSync(entry.partialPath, { force: true });
    writeFileSync(entry.cachePath, bytes);
    writeFileSync(entry.contentTypeSidecar, "application/octet-stream");
    mkdirSync(dirname(j.target), { recursive: true });
    if (this.copyFromCache) writeFileSync(j.target, readFileSync(entry.cachePath));
    else linkSync(entry.cachePath, j.target);
    j.status = "done";
  }

  /** A job unrelated to any run, as another tool would have started it. */
  unrelated(): string {
    const id = `job-other-${++this.n}`;
    this.jobs.set(id, { status: "downloading", target: join(this.root, "checkpoints", "theirs.safetensors"), url: "https://example.com/x" });
    return id;
  }
}

/** One HEAD answer: status and headers (lower-case names). */
export interface FakeAnswer {
  status: number;
  location?: string;
  headers?: Record<string, string>;
}

/**
 * Hugging Face's HEAD answers: a 302 to the CDN with X-Linked-Size and X-Linked-Etag of
 * SOURCE, then 200, unless a route is set.
 */
export class FakeHf {
  calls: { url: string; headers: Record<string, string> }[] = [];
  routes = new Map<string, FakeAnswer>();
  fails = false;

  readonly fetch: HeadFetch = async (url, init) => {
    this.calls.push({ url, headers: init.headers });
    if (this.fails) throw new TypeError("fetch failed");
    const r: FakeAnswer =
      this.routes.get(url) ??
      (url.startsWith("https://huggingface.co/")
        ? { status: 302, location: "https://us.aws.cdn.hf.co/xet-bridge-us/abc?sig=1", headers: { "x-linked-size": String(SOURCE.sizeBytes), "x-linked-etag": `"${SOURCE.sha256}"` } }
        : { status: 200 });
    const headers: Record<string, string> = { ...(r.headers ?? {}), ...(r.location ? { location: r.location } : {}) };
    return { status: r.status, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } };
  };
}

/**
 * The acquisition I/O over the fakes and the real filesystem. `free` is the free disk of
 * every device, or a function of the path asked about; `device` maps a path to a device id
 * (by default the cache's own device, 2, apart from everything else, 1, when `cacheDevice`
 * is set, and the real one otherwise).
 */
export function io(
  downloads: FakeDownloads,
  hf = new FakeHf(),
  over: {
    free?: number | ((path: string) => Promise<number>);
    env?: Record<string, string>;
    fs?: Partial<AcquisitionFs>;
    cacheOnOtherDevice?: boolean;
  } = {},
): AcquisitionIo {
  const free = over.free ?? PLENTY;
  return {
    facade: downloads,
    fetch: hf.fetch,
    fs: {
      ...NODE_ACQUISITION_FS,
      freeDiskBytes: typeof free === "number" ? async () => free : free,
      deviceOf: async (p: string) => (over.cacheOnOtherDevice ? (p.startsWith(downloads.cacheDir) ? 2 : 1) : NODE_ACQUISITION_FS.deviceOf(p)),
      ...over.fs,
    },
    env: over.env ?? {},
  };
}

export function effectFor(root: string, source = SOURCE): AcquireModelsEffect {
  return {
    kind: "acquire_models",
    files: [{ folder: "checkpoints", file: MISSING, source, destinationRoot: root }],
    totalBytes: source.sizeBytes,
    maxBytes: 40 * 1024 ** 3,
    minFreeBytes: MIN_FREE_DISK_BYTES,
  };
}


const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));
const STATS: SystemStats = {
  system: { os: "darwin", python_version: "3.12", embedded_python: false, comfyui_version: "0.44.0", ram_total: 1, ram_free: 1 },
  devices: [],
};

/** A selected plan on the t2i fixture whose checkpoint is missing and pinned. */
export async function acquirable(
  opts: { withIo?: boolean; free?: number; env?: Record<string, string>; cacheOnOtherDevice?: boolean; task?: Record<string, unknown>; certification?: string } = {},
) {
  const recipeDir = tempDir("architect-acq-recipes-");
  const recipe = JSON.parse(readFileSync(join(FIXTURES_DIR, "t2i-basic.recipe.json"), "utf-8"));
  recipe.id = "recipe-fixture.t2i-acquire";
  recipe.slots = recipe.slots.map((s: { id: string }) => (s.id === "checkpoint" ? { ...s, default: MISSING } : s));
  recipe.modelSources = [{ folder: "checkpoints", file: MISSING, source: SOURCE }];
  if (opts.certification) recipe.certification = opts.certification;
  writeFileSync(join(recipeDir, "acquire.recipe.json"), JSON.stringify(recipe));
  const source: RecipeSource = { id: "source-acquire", kind: "fixture", dir: recipeDir, trust: "test" };

  const dataDir = tempDir("architect-acq-exec-");
  const store = ArchitectStore.open(dataDir);
  stores.push(store);
  let n = 0;
  const newId = () => `id${++n}`;
  let clock = Date.parse("2026-11-15T12:00:00.000Z");
  const now = () => new Date(clock);
  let baseUrl = "http://127.0.0.1:8188";
  let models: InstalledModels = fixtureSnapshot().installedModels ?? { folders: {}, unanswered: [], absent: [] };
  let info: ObjectInfo = fixtureObjectInfo();
  const upstream = {
    comfyuiBaseUrl: () => baseUrl,
    systemStats: async () => STATS,
    objectInfo: async () => info,
    installedModels: async () => models,
    isPaidNode: () => false,
  } as Pick<UpstreamFacade, "comfyuiBaseUrl" | "systemStats" | "objectInfo" | "installedModels" | "isPaidNode">;
  const service = new ArchitectService({ upstream: upstream as UpstreamFacade, now, newId });
  const planning = new ArchitectPlanning({ store, service, upstream, dataDir, sources: [source], now, newId });
  const prepared = await planning.prepare({ task: { ...TASK, ...opts.task } });
  const proposed = await planning.propose({ planId: prepared.plan.id });
  const candidate = proposed.candidates[0];
  planning.select({ planId: prepared.plan.id, candidateId: candidate.id });

  const root = modelRoot();
  const downloads = new FakeDownloads(root);
  const hf = new FakeHf();
  const acquisitionIo = io(downloads, hf, { free: opts.free, env: opts.env, cacheOnOtherDevice: opts.cacheOnOtherDevice });
  const driver: RunDriver = {
    advance: vi.fn(async (runId: string) => store.getRun(runId) as RunRecord),
    reconcile: vi.fn(async (runId: string) => store.getRun(runId) as RunRecord),
    cancel: vi.fn(async (runId: string) => store.getRun(runId) as RunRecord),
  };
  const deps = { store, planning, baseUrl: () => baseUrl, now, newId, ...(opts.withIo === false ? {} : { acquisitionIo }) };
  const execution = new ArchitectExecution({ ...deps, driver, dataDir, dependencyLock: (id, task) => planning.dependencyLock(id, task) });
  /** ComfyUI now lists the file and offers it in the loader. */
  const install = () => {
    models = { ...models, folders: { ...models.folders, checkpoints: [...(models.folders.checkpoints ?? []), MISSING] } };
    info = fixtureObjectInfo();
    info.CheckpointLoaderSimple.input = { required: { ckpt_name: [[MISSING]] } };
  };
  return {
    store,
    planning,
    execution,
    driver,
    deps,
    dataDir,
    planId: prepared.plan.id,
    candidate,
    proposed,
    root,
    downloads,
    hf,
    acquisitionIo,
    now,
    newId,
    install,
    tick: (ms: number) => {
      clock += ms;
    },
    setBaseUrl: (u: string) => {
      baseUrl = u;
    },
    service,
  };
}

