// Milestone 4, part B (TODO 4.5, 4.5.2, 4.5.3, 4.6): the redirect preflight, staging,
// verification and placement; the controller's downloads in PREPARING, their cancellation
// and restart; the acquire_models effect at prepare and start; and the run's lineage. A fake
// downloader writes into temporary model folders; a fake Hugging Face answers the HEADs.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectInfo, SystemStats } from "../../comfyui/types.js";
import {
  type AcquisitionFacade,
  type AcquisitionFs,
  type AcquisitionIo,
  type HeadFetch,
  MAX_DOWNLOAD_ATTEMPTS,
  ModelAcquirer,
  NODE_ACQUISITION_FS,
  STAGING_DIR,
  pinnedUrl,
  placeStaged,
  preflightRedirects,
  prepareStaging,
  verifyStaged,
} from "../../services/architect/acquisition.js";
import { MIN_FREE_DISK_BYTES } from "../../services/architect/acquisition-policy.js";
import { ApprovalError, describeActionPlan, issueGrant, requireFeasible } from "../../services/architect/admission.js";
import { RunController, type RunControllerDeps } from "../../services/architect/controller.js";
import { ArchitectExecution, type RunDriver } from "../../services/architect/execution.js";
import { ArchitectPlanning, type RecipeSource } from "../../services/architect/planning.js";
import { ResourceCoordinator } from "../../services/architect/resources.js";
import {
  type AcquireModelsEffect,
  ActionPlan,
  type InstalledModels,
  ModelSource,
  ResultEnvelope,
  type RunRecord,
  actionPlanHash,
} from "../../services/architect/schemas.js";
import { ArchitectService } from "../../services/architect/service.js";
import { ArchitectStore } from "../../services/architect/store.js";
import type { DownloadStatus, UpstreamFacade } from "../../services/architect/upstream.js";
import { registerArchitectTools } from "../../tools/architect.js";
import { TASK } from "./fixtures/approval-harness.js";
import { fixtureObjectInfo, fixtureSnapshot } from "./fixtures/load.js";
import { FakeOllama, RUN_CREATED, seedRun } from "./fixtures/run-harness.js";

const BYTES = Buffer.from("pretend these are the weights of an upscale model\n".repeat(64));
const SHA = createHash("sha256").update(BYTES).digest("hex");
const COMMIT = "5fd49b7b278836f48af63ecd314d0f98ab336105";
const MISSING = "missing.safetensors";
const PLENTY = MIN_FREE_DISK_BYTES * 4;

const SOURCE = ModelSource.parse({
  kind: "huggingface",
  repo: "Comfy-Org/Real-ESRGAN",
  revision: COMMIT,
  path: "split files/checkpoints/missing.safetensors",
  sha256: SHA,
  sizeBytes: BYTES.length,
  license: "bsd-3-clause",
});

const dirs: string[] = [];
const stores: ArchitectStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A model root with a `checkpoints` folder, as ComfyUI's models directory. */
function modelRoot(): string {
  const root = tempDir("architect-models-");
  mkdirSync(join(root, "checkpoints"));
  return root;
}

// ---------------------------------------------------------------------------------------
// Fakes

interface FakeJob {
  status: DownloadStatus["status"];
  target: string;
  url: string;
  bytes?: number;
  totalBytes?: number;
  error?: string;
}

/** Upstream's downloader as the facade shows it, writing into a temporary model root. */
class FakeDownloads implements AcquisitionFacade {
  jobs = new Map<string, FakeJob>();
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

  /** The transfer lands: the bytes are written where upstream resolved the file. */
  finish(jobId: string, bytes: Buffer = BYTES): void {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error(`no job ${jobId}`);
    mkdirSync(dirname(j.target), { recursive: true });
    writeFileSync(j.target, bytes);
    j.status = "done";
  }

  /** A job unrelated to any run, as another tool would have started it. */
  unrelated(): string {
    const id = `job-other-${++this.n}`;
    this.jobs.set(id, { status: "downloading", target: join(this.root, "checkpoints", "theirs.safetensors"), url: "https://example.com/x" });
    return id;
  }
}

/** Hugging Face's HEAD answers: a 302 to the CDN, then 200, unless a route is set. */
class FakeHf {
  calls: { url: string; headers: Record<string, string> }[] = [];
  routes = new Map<string, { status: number; location?: string }>();
  fails = false;

  readonly fetch: HeadFetch = async (url, init) => {
    this.calls.push({ url, headers: init.headers });
    if (this.fails) throw new TypeError("fetch failed");
    const r = this.routes.get(url) ?? (url.startsWith("https://huggingface.co/") ? { status: 302, location: "https://us.aws.cdn.hf.co/xet-bridge-us/abc?sig=1" } : { status: 200 });
    return { status: r.status, headers: { get: (name: string) => (name.toLowerCase() === "location" ? (r.location ?? null) : null) } };
  };
}

function io(downloads: FakeDownloads, hf = new FakeHf(), over: { free?: number | (() => Promise<number>); env?: Record<string, string>; fs?: Partial<AcquisitionFs> } = {}): AcquisitionIo {
  const free = over.free ?? PLENTY;
  return {
    facade: downloads,
    fetch: hf.fetch,
    fs: { ...NODE_ACQUISITION_FS, freeDiskBytes: typeof free === "number" ? async () => free : free, ...over.fs },
    env: over.env ?? {},
  };
}

function effectFor(root: string, source = SOURCE): AcquireModelsEffect {
  return {
    kind: "acquire_models",
    files: [{ folder: "checkpoints", file: MISSING, source, destinationRoot: root }],
    totalBytes: source.sizeBytes,
    maxBytes: 40 * 1024 ** 3,
    minFreeBytes: MIN_FREE_DISK_BYTES,
  };
}

// ---------------------------------------------------------------------------------------
// The redirect preflight (TODO 4.4)

describe("pinnedUrl", () => {
  it("builds the commit-pinned resolve URL from the source alone, encoding each path segment", () => {
    expect(pinnedUrl(SOURCE)).toBe(`https://huggingface.co/Comfy-Org/Real-ESRGAN/resolve/${COMMIT}/split%20files/checkpoints/missing.safetensors`);
  });
});

describe("preflightRedirects", () => {
  const url = pinnedUrl(SOURCE);

  it("follows Hugging Face's redirect to its CDN with HEAD and manual redirects", async () => {
    const hf = new FakeHf();
    const r = await preflightRedirects(url, hf.fetch);
    expect(r).toEqual({ ok: true, finalUrl: "https://us.aws.cdn.hf.co/xet-bridge-us/abc?sig=1", hops: 1 });
    expect(hf.calls.map((c) => c.url)).toEqual([url, "https://us.aws.cdn.hf.co/xet-bridge-us/abc?sig=1"]);
  });

  it("resolves a relative Location against the URL it came from", async () => {
    const hf = new FakeHf();
    hf.routes.set(url, { status: 307, location: "/api/resolve-cache/models/x" });
    hf.routes.set("https://huggingface.co/api/resolve-cache/models/x", { status: 200 });
    expect(await preflightRedirects(url, hf.fetch)).toMatchObject({ ok: true, hops: 1 });
  });

  it("refuses a redirect to another host, and names the host", async () => {
    const hf = new FakeHf();
    hf.routes.set(url, { status: 302, location: "https://mirror.example.com/x.safetensors" });
    const r = await preflightRedirects(url, hf.fetch);
    expect(r).toMatchObject({ ok: false, refused: true });
    expect(!r.ok && r.message).toContain("mirror.example.com");
    expect(hf.calls).toHaveLength(1);
  });

  it("refuses a look-alike host and a redirect to http", async () => {
    const hf = new FakeHf();
    hf.routes.set(url, { status: 302, location: "https://huggingface.co.evil.example/x" });
    expect(await preflightRedirects(url, hf.fetch)).toMatchObject({ ok: false, refused: true });
    hf.routes.set(url, { status: 302, location: "http://cdn-lfs.huggingface.co/x" });
    const r = await preflightRedirects(url, hf.fetch);
    expect(r).toMatchObject({ ok: false, refused: true });
    expect(!r.ok && r.message).toContain("left https");
  });

  it("refuses a sixth hop", async () => {
    const hf = new FakeHf();
    const hop = (i: number) => `https://cdn${i}.hf.co/x`;
    hf.routes.set(url, { status: 302, location: hop(1) });
    for (let i = 1; i <= 5; i++) hf.routes.set(hop(i), { status: 302, location: hop(i + 1) });
    const r = await preflightRedirects(url, hf.fetch);
    expect(r).toMatchObject({ ok: false, refused: true });
    expect(!r.ok && r.message).toMatch(/longer than 5 hops/);
    // Five hops are allowed.
    hf.routes.set(hop(5), { status: 200 });
    expect(await preflightRedirects(url, hf.fetch)).toMatchObject({ ok: true, hops: 5 });
  });

  it("refuses a final answer that isn't 2xx, and reports a failed request as unobserved, not refused", async () => {
    const hf = new FakeHf();
    hf.routes.set(url, { status: 404 });
    expect(await preflightRedirects(url, hf.fetch)).toMatchObject({ ok: false, refused: true });
    hf.fails = true;
    expect(await preflightRedirects(url, hf.fetch)).toMatchObject({ ok: false, refused: false });
  });

  it("refuses when HF_ENDPOINT points elsewhere, before any request; Hugging Face itself is fine", async () => {
    const hf = new FakeHf();
    const r = await preflightRedirects(url, hf.fetch, { HF_ENDPOINT: "https://hf-mirror.com" });
    expect(r).toMatchObject({ ok: false, refused: true });
    expect(!r.ok && r.message).toContain("hf-mirror.com");
    expect(hf.calls).toHaveLength(0);
    expect(await preflightRedirects(url, hf.fetch, { HF_ENDPOINT: "https://huggingface.co/" })).toMatchObject({ ok: true });
    expect(await preflightRedirects(url, hf.fetch, { HF_ENDPOINT: "  " })).toMatchObject({ ok: true });
  });

  it("sends HF_TOKEN only after huggingface.co answered 401, and never to the CDN", async () => {
    const hf = new FakeHf();
    const answers = [401, 302];
    const gated: HeadFetch = async (u, init) => {
      hf.calls.push({ url: u, headers: init.headers });
      if (u === url) {
        const status = answers.shift() ?? 302;
        return { status, headers: { get: () => (status === 302 ? "https://cdn-lfs.huggingface.co/x" : null) } };
      }
      return { status: 200, headers: { get: () => null } };
    };
    expect(await preflightRedirects(url, gated, { HF_TOKEN: "hf_secret" })).toMatchObject({ ok: true });
    expect(hf.calls.map((c) => c.headers.Authorization)).toEqual([undefined, "Bearer hf_secret", undefined]);
  });
});

// ---------------------------------------------------------------------------------------
// Staging, verification and placement (TODO 4.5.2; SEC T4, T9)

describe("staging, verification and placement", () => {
  const fs = NODE_ACQUISITION_FS;

  async function staged(root: string, bytes = BYTES): Promise<string> {
    const s = await prepareStaging(fs, root, "run-1");
    if (!s.ok) throw new Error(s.message);
    const p = join(s.dir, MISSING);
    writeFileSync(p, bytes);
    return p;
  }

  it("places a staged file whose sha256 and size are the pinned ones, and the staged file is gone", async () => {
    const root = modelRoot();
    const p = await staged(root);
    expect(await verifyStaged(fs, p, SOURCE)).toEqual({ kind: "match", sha256: SHA, bytes: BYTES.length });
    expect(await placeStaged(fs, { root, folder: "checkpoints", file: MISSING, stagedPath: p, source: SOURCE })).toEqual({
      ok: true,
      path: join(root, "checkpoints", MISSING),
      preexisting: false,
    });
    expect(readFileSync(join(root, "checkpoints", MISSING))).toEqual(BYTES);
    expect(existsSync(p)).toBe(false);
  });

  it("deletes a staged file whose hash differs, naming expected and observed", async () => {
    const root = modelRoot();
    const wrong = Buffer.from(BYTES);
    wrong[0] ^= 0xff;
    const p = await staged(root, wrong);
    const v = await verifyStaged(fs, p, SOURCE);
    expect(v.kind).toBe("mismatch");
    expect(v.kind === "mismatch" && v.message).toContain(`expected ${SHA.slice(0, 8)}`);
    expect(existsSync(p)).toBe(false);
    expect(readdirSync(join(root, "checkpoints"))).toEqual([]);
  });

  it("deletes a staged file over or under the pinned size without hashing it", async () => {
    const root = modelRoot();
    const hashFile = vi.fn(NODE_ACQUISITION_FS.hashFile);
    const counting = { ...fs, hashFile };
    for (const bytes of [Buffer.concat([BYTES, Buffer.from("x")]), BYTES.subarray(0, 10)]) {
      const p = await staged(root, bytes);
      const v = await verifyStaged(counting, p, SOURCE);
      expect(v.kind === "mismatch" && v.message).toMatch(/size mismatch/);
      expect(existsSync(p)).toBe(false);
    }
    expect(hashFile).not.toHaveBeenCalled();
  });

  it("never reads a staged symbolic link as the file", async () => {
    const root = modelRoot();
    const s = await prepareStaging(fs, root, "run-1");
    if (!s.ok) throw new Error(s.message);
    const elsewhere = join(tempDir("architect-elsewhere-"), "real.safetensors");
    writeFileSync(elsewhere, BYTES);
    symlinkSync(elsewhere, join(s.dir, MISSING));
    const v = await verifyStaged(fs, join(s.dir, MISSING), SOURCE);
    expect(v.kind === "mismatch" && v.message).toMatch(/symbolic link/);
    expect(existsSync(elsewhere)).toBe(true);
  });

  it("counts an existing destination with the pinned bytes as placed", async () => {
    const root = modelRoot();
    writeFileSync(join(root, "checkpoints", MISSING), BYTES);
    const p = await staged(root);
    expect(await placeStaged(fs, { root, folder: "checkpoints", file: MISSING, stagedPath: p, source: SOURCE })).toMatchObject({ ok: true, preexisting: true });
    expect(existsSync(p)).toBe(false);
  });

  it("never overwrites an existing destination with other bytes", async () => {
    const root = modelRoot();
    const theirs = Buffer.from("the user's own file");
    writeFileSync(join(root, "checkpoints", MISSING), theirs);
    const p = await staged(root);
    const r = await placeStaged(fs, { root, folder: "checkpoints", file: MISSING, stagedPath: p, source: SOURCE });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/already exists with other content/);
    expect(readFileSync(join(root, "checkpoints", MISSING))).toEqual(theirs);
  });

  it("refuses a model folder that resolves outside the root (path escape)", async () => {
    const root = tempDir("architect-models-");
    const outside = tempDir("architect-outside-");
    symlinkSync(outside, join(root, "checkpoints"));
    const p = await staged(root);
    const r = await placeStaged(fs, { root, folder: "checkpoints", file: MISSING, stagedPath: p, source: SOURCE });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/outside/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses a symlinked staging folder, at either level", async () => {
    const root = modelRoot();
    const outside = tempDir("architect-outside-");
    symlinkSync(outside, join(root, STAGING_DIR));
    const r = await prepareStaging(fs, root, "run-1");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/symbolic link/);
    rmSync(join(root, STAGING_DIR));
    mkdirSync(join(root, STAGING_DIR));
    symlinkSync(outside, join(root, STAGING_DIR, "run-1"));
    expect((await prepareStaging(fs, root, "run-1")).ok).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses to place from a staging folder swapped for a link after verification", async () => {
    const root = modelRoot();
    const p = await staged(root);
    const outside = tempDir("architect-outside-");
    writeFileSync(join(outside, MISSING), BYTES);
    rmSync(dirname(p), { recursive: true });
    symlinkSync(outside, dirname(p));
    const r = await placeStaged(fs, { root, folder: "checkpoints", file: MISSING, stagedPath: p, source: SOURCE });
    expect(r.ok).toBe(false);
    expect(readdirSync(join(root, "checkpoints"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// The controller's downloads in PREPARING (TODO 4.5, 4.5.3, 4.6)

describe("a run that acquires model files", () => {
  let dataDir: string;
  let clock: Date;

  beforeEach(() => {
    dataDir = tempDir("architect-acq-run-");
    clock = new Date(RUN_CREATED);
  });

  function openStore(): ArchitectStore {
    const s = ArchitectStore.open(dataDir, { now: () => clock });
    stores.push(s);
    return s;
  }

  function harness(
    opts: {
      root?: string;
      store?: ArchitectStore;
      seed?: boolean;
      io?: AcquisitionIo;
      downloads?: FakeDownloads;
      hf?: FakeHf;
      revalidate?: RunControllerDeps["revalidate"];
      acquirer?: boolean;
      maxWallTimeSeconds?: number;
      free?: number;
    } = {},
  ) {
    const root = opts.root ?? modelRoot();
    const store = opts.store ?? openStore();
    const effect = effectFor(root);
    const run = opts.seed === false ? store.listRuns()[0] : seedRun(store, { acquire: effect, maxWallTimeSeconds: opts.maxWallTimeSeconds });
    const downloads = opts.downloads ?? new FakeDownloads(root);
    const hf = opts.hf ?? new FakeHf();
    const now = () => new Date(clock);
    let n = 0;
    const submitted: string[] = [];
    const ollama = new FakeOllama();
    const resources = new ResourceCoordinator({
      store,
      upstream: ollama.facade(),
      ownerId: "instance-a",
      now,
      manageResidency: false,
      fetchImpl: ollama.fetch,
      probeTimeoutMs: 20,
    });
    const revalidate = vi.fn(opts.revalidate ?? (async () => undefined));
    const acquirer = new ModelAcquirer({ store, io: opts.io ?? io(downloads, hf, { free: opts.free }), now, newId: () => `a${++n}` });
    const upstream: RunControllerDeps["upstream"] = {
      submitPrompt: async (_g, promptId) => {
        submitted.push(promptId);
        return { kind: "accepted", promptId };
      },
      queue: async () => ({ running: [], pending: submitted }),
      history: async () => undefined,
      dequeue: async () => ({ removed: true, state: "removed", verified: true }),
      interruptPrompt: async () => undefined,
      outputFile: async () => {
        throw new Error("no outputs");
      },
      decodeImage: async () => ({ width: 1, height: 1 }),
    };
    const controller = new RunController({
      store,
      upstream,
      resources,
      now,
      newUuid: () => "11111111-2222-4333-8444-555555555555",
      graphFor: async () => (await import("./fixtures/run-harness.js")).GRAPH,
      taskFor: () => {
        throw new Error("no task needed");
      },
      revalidate,
      ...(opts.acquirer === false ? {} : { acquirer }),
      onError: (err) => {
        throw err;
      },
    });
    return { store, run, root, downloads, hf, controller, revalidate, submitted, effect, acquirer };
  }

  const acq = (store: ArchitectStore, run: RunRecord) => store.listAcquisitions(run.id);
  const stagingOf = (root: string, run: RunRecord) => join(root, STAGING_DIR, run.id);

  it("downloads into the staging folder, verifies, places, revalidates on a fresh snapshot, then submits", async () => {
    const h = harness();
    let r = await h.controller.advance(h.run.id);
    expect(r.state).toBe("PREPARING");
    expect(h.downloads.started).toEqual([{ url: pinnedUrl(SOURCE), subfolder: `${STAGING_DIR}/${h.run.id}`, filename: MISSING }]);
    expect(h.hf.calls.map((c) => c.url)[0]).toBe(pinnedUrl(SOURCE));
    expect(acq(h.store, h.run)[0]).toMatchObject({ state: "downloading", jobId: "job-1", stagedPath: join(stagingOf(h.root, h.run), MISSING) });
    expect(h.revalidate).not.toHaveBeenCalled();

    // Still downloading: the poll changes nothing and holds no lock while it waits.
    r = await h.controller.reconcile(h.run.id);
    expect(r.state).toBe("PREPARING");

    h.downloads.finish("job-1");
    r = await h.controller.reconcile(h.run.id);
    expect(r.state).toBe("QUEUED");
    const [placed] = acq(h.store, h.run);
    expect(placed).toMatchObject({ state: "placed", placedPath: join(h.root, "checkpoints", MISSING), observedSha256: SHA, observedBytes: BYTES.length });
    expect(readFileSync(join(h.root, "checkpoints", MISSING))).toEqual(BYTES);
    expect(existsSync(join(h.root, STAGING_DIR))).toBe(false);
    expect(h.downloads.forgot).toBe(1);
    expect(h.revalidate).toHaveBeenCalledTimes(1);
    const notes = h.store.listRunEvents(h.run.id).filter((e) => e.kind === "note").map((e) => e.data?.acquisitionTo);
    expect(notes.filter((x) => x !== undefined)).toEqual(["downloading", "verifying", "placed"]);
  });

  it("a hash mismatch fails the run and leaves nothing in the model folder or the staging folder", async () => {
    const h = harness();
    await h.controller.advance(h.run.id);
    const wrong = Buffer.from(BYTES);
    wrong[3] ^= 0x01;
    h.downloads.finish("job-1", wrong);
    const r = await h.controller.reconcile(h.run.id);
    expect(r.state).toBe("FAILED");
    expect(r.error?.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(r.error?.message).toMatch(/sha256 mismatch: expected/);
    expect(readdirSync(join(h.root, "checkpoints"))).toEqual([]);
    expect(existsSync(join(h.root, STAGING_DIR))).toBe(false);
    expect(acq(h.store, h.run)[0]).toMatchObject({ state: "failed", observedSha256: expect.any(String) });
    expect(h.submitted).toEqual([]);
  });

  it("stops a transfer that grows past the pinned size, or announces another size", async () => {
    for (const over of [{ bytes: BYTES.length + 1 }, { totalBytes: BYTES.length * 2 }]) {
      const h = harness();
      await h.controller.advance(h.run.id);
      Object.assign(h.downloads.jobs.get("job-1") ?? {}, over);
      const r = await h.controller.reconcile(h.run.id);
      expect(r.state).toBe("FAILED");
      expect(r.error?.message).toMatch(/size over the pin/);
      expect(h.downloads.cancelled).toEqual(["job-1"]);
      expect(readdirSync(join(h.root, "checkpoints"))).toEqual([]);
      for (const s of stores.splice(0)) s.close();
      dataDir = tempDir("architect-acq-run-");
    }
  });

  it("refuses a redirect to another host before upstream downloads anything", async () => {
    const hf = new FakeHf();
    hf.routes.set(pinnedUrl(SOURCE), { status: 302, location: "https://mirror.example.com/x" });
    const h = harness({ hf });
    const r = await h.controller.advance(h.run.id);
    expect(r.state).toBe("FAILED");
    expect(r.error?.message).toContain("mirror.example.com");
    expect(h.downloads.started).toEqual([]);
  });

  it("refuses to start a file when the free disk after it would be below the reserve", async () => {
    const h = harness({ free: MIN_FREE_DISK_BYTES + BYTES.length - 1 });
    const r = await h.controller.advance(h.run.id);
    expect(r.state).toBe("FAILED");
    expect(r.error?.message).toMatch(/less than 50\.0 GiB would remain/);
    expect(h.downloads.started).toEqual([]);
    expect(h.hf.calls).toEqual([]);
  });

  it("refuses when the free disk can't be read: unknown blocks, it doesn't pass", async () => {
    const root = modelRoot();
    const downloads = new FakeDownloads(root);
    const h = harness({ root, downloads, io: io(downloads, new FakeHf(), { free: async () => Promise.reject(new Error("statfs EIO")) }) });
    const r = await h.controller.advance(h.run.id);
    expect(r.state).toBe("FAILED");
    expect(r.error?.message).toMatch(/couldn't be read/);
    expect(downloads.started).toEqual([]);
  });

  it("counts a destination that already holds the pinned file as placed", async () => {
    const h = harness();
    await h.controller.advance(h.run.id);
    writeFileSync(join(h.root, "checkpoints", MISSING), BYTES);
    h.downloads.finish("job-1");
    expect((await h.controller.reconcile(h.run.id)).state).toBe("QUEUED");
    expect(acq(h.store, h.run)[0].state).toBe("placed");
  });

  it("fails, and leaves the file untouched, when the destination appeared with other content", async () => {
    const h = harness();
    await h.controller.advance(h.run.id);
    const theirs = Buffer.from("someone else's checkpoint");
    writeFileSync(join(h.root, "checkpoints", MISSING), theirs);
    h.downloads.finish("job-1");
    const r = await h.controller.reconcile(h.run.id);
    expect(r.state).toBe("FAILED");
    expect(r.error?.message).toMatch(/already exists with other content/);
    expect(readFileSync(join(h.root, "checkpoints", MISSING))).toEqual(theirs);
  });

  it("refuses when upstream would stage the file somewhere other than the run's staging folder", async () => {
    const root = modelRoot();
    const downloads = new FakeDownloads(root);
    downloads.resolveTo = (_sub, file) => ({ root, path: join(root, "elsewhere", file) });
    const h = harness({ root, downloads });
    const r = await h.controller.advance(h.run.id);
    expect(r.state).toBe("FAILED");
    expect(r.error?.message).toMatch(/would stage/);
    expect(downloads.started).toEqual([]);
  });

  it("refuses the ComfyUI-Manager route and an HF_ENDPOINT elsewhere at download time too", async () => {
    const root = modelRoot();
    const downloads = new FakeDownloads(root);
    downloads.manager = true;
    const h = harness({ root, downloads });
    expect((await h.controller.advance(h.run.id)).error?.message).toMatch(/ComfyUI-Manager/);
    expect(downloads.started).toEqual([]);

    for (const s of stores.splice(0)) s.close();
    dataDir = tempDir("architect-acq-run-");
    const d2 = new FakeDownloads(root);
    const h2 = harness({ root, downloads: d2, io: io(d2, new FakeHf(), { env: { HF_ENDPOINT: "https://hf-mirror.com" } }) });
    expect((await h2.controller.advance(h2.run.id)).error?.message).toMatch(/HF_ENDPOINT/);
    expect(d2.started).toEqual([]);
  });

  it("cancel during a download cancels the run's own job only, deletes its staged files and cancels the run", async () => {
    const h = harness();
    const theirs = h.downloads.unrelated();
    await h.controller.advance(h.run.id);
    const ours = acq(h.store, h.run)[0].jobId;
    expect(ours).toBeDefined();
    writeFileSync(join(stagingOf(h.root, h.run), MISSING), BYTES.subarray(0, 5));
    const r = await h.controller.cancel(h.run.id, "agent");
    expect(r.state).toBe("CANCELLED");
    expect(h.downloads.cancelled).toEqual([ours]);
    expect(h.downloads.jobs.get(theirs)?.status).toBe("downloading");
    expect(acq(h.store, h.run)[0].state).toBe("cancelled");
    expect(existsSync(join(h.root, STAGING_DIR))).toBe(false);
    expect(readdirSync(join(h.root, "checkpoints"))).toEqual([]);
  });

  it("after a restart, verifies a complete staged file whose job is gone, then places it", async () => {
    const root = modelRoot();
    const store = openStore();
    const first = harness({ root, store });
    await first.controller.advance(first.run.id);
    // The process stops; the file had landed, but the job's record is lost with it.
    writeFileSync(join(stagingOf(root, first.run), MISSING), BYTES);
    const downloads = new FakeDownloads(root);
    const second = harness({ root, store, seed: false, downloads });
    const [r] = await second.controller.resumeAll();
    expect(r.state).toBe("QUEUED");
    expect(downloads.started).toEqual([]);
    const tos = store.listRunEvents(first.run.id).map((e) => e.data?.acquisitionTo).filter((x) => x !== undefined);
    expect(tos).toEqual(["downloading", "verifying", "placed"]);
    expect(readFileSync(join(root, "checkpoints", MISSING))).toEqual(BYTES);
  });

  it("after a restart, a truncated staged file is deleted and the file downloaded again, never placed", async () => {
    const root = modelRoot();
    const store = openStore();
    const first = harness({ root, store });
    await first.controller.advance(first.run.id);
    writeFileSync(join(stagingOf(root, first.run), MISSING), BYTES.subarray(0, 100));
    const downloads = new FakeDownloads(root);
    const second = harness({ root, store, seed: false, downloads });
    await second.controller.resumeAll();
    expect(readdirSync(join(root, "checkpoints"))).toEqual([]);
    // Back to planned, and the next step starts a fresh download.
    const after = await second.controller.reconcile(first.run.id);
    expect(after.state).toBe("PREPARING");
    expect(downloads.started).toHaveLength(1);
    expect(acq(store, first.run)[0]).toMatchObject({ state: "downloading", jobId: "job-1" });
  });

  it("after a restart, a file left verifying is checked again before it is placed", async () => {
    const root = modelRoot();
    const store = openStore();
    const first = harness({ root, store });
    await first.controller.advance(first.run.id);
    first.downloads.finish("job-1");
    const [rec] = acq(store, first.run);
    store.transitionAcquisition({ id: rec.id, from: "downloading", to: "verifying", at: clock });
    const second = harness({ root, store, seed: false, downloads: new FakeDownloads(root) });
    const r = await second.controller.reconcile(first.run.id);
    expect(r.state).toBe("QUEUED");
    expect(acq(store, first.run)[0].state).toBe("placed");
  });

  it("a placed file that changed before a restart fails the run instead of counting", async () => {
    const root = modelRoot();
    const store = openStore();
    const first = harness({ root, store, revalidate: async () => Promise.reject(Object.assign(new Error("hold"), { code: "RESOURCE_BUSY" })) });
    await first.controller.advance(first.run.id);
    first.downloads.finish("job-1");
    // The first process placed the file, but its revalidation failed the run; seed another
    // state: put the acquisitions back on a PREPARING run by reading them as a new process.
    expect((await first.controller.reconcile(first.run.id)).state).toBe("FAILED");
    // Directly: a new acquirer sees a placed record whose file changed.
    writeFileSync(join(root, "checkpoints", MISSING), Buffer.from("tampered"));
    const second = harness({ root, store, seed: false });
    const progress = await second.acquirer.step({ ...first.run, state: "PREPARING" }, first.effect);
    expect(progress.kind).toBe("failed");
    expect(progress.kind === "failed" && progress.error.message).toMatch(/changed since it was placed/);
  });

  it("retries a lost download up to the attempt limit, then fails", async () => {
    const h = harness();
    for (let i = 1; i <= MAX_DOWNLOAD_ATTEMPTS; i++) {
      const r = await h.controller.reconcile(h.run.id);
      expect(r.state).toBe("PREPARING");
      h.downloads.jobs.set(`job-${i}`, { ...(h.downloads.jobs.get(`job-${i}`) as FakeJob), status: "error", error: "HTTP 503" });
      await h.controller.reconcile(h.run.id); // error, nothing staged: back to planned
    }
    const r = await h.controller.reconcile(h.run.id);
    expect(r.state).toBe("FAILED");
    expect(r.error?.message).toMatch(/gave up after 3 download attempts/);
    expect(h.downloads.started).toHaveLength(MAX_DOWNLOAD_ATTEMPTS);
  });

  it("fails the run when the candidate isn't feasible on a fresh snapshot after placement", async () => {
    const h = harness({
      revalidate: async () => Promise.reject(Object.assign(new Error("candidate cand-1 is acquirable against the current environment"), { code: "APPROVAL_INVALIDATED" })),
    });
    await h.controller.advance(h.run.id);
    h.downloads.finish("job-1");
    const r = await h.controller.reconcile(h.run.id);
    expect(r.state).toBe("FAILED");
    expect(r.error).toMatchObject({ code: "APPROVAL_INVALIDATED" });
    expect(r.error?.message).toMatch(/isn't feasible on a fresh snapshot/);
    expect(h.submitted).toEqual([]);
  });

  it("fails a run that acquires files on a controller without an acquirer; nothing is downloaded", async () => {
    const h = harness({ acquirer: false });
    const r = await h.controller.advance(h.run.id);
    expect(r.state).toBe("FAILED");
    expect(r.error?.code).toBe("INTERNAL_ERROR");
    expect(h.downloads.started).toEqual([]);
  });

  it("the wall time covers the download: past it, the run's job is cancelled and the run fails", async () => {
    // The run was created at T1, a minute before RUN_CREATED; its deadline is 12:03:00.
    const h = harness({ maxWallTimeSeconds: 120 });
    await h.controller.advance(h.run.id);
    clock = new Date(RUN_CREATED.getTime() + 61_000);
    const r = await h.controller.reconcile(h.run.id);
    expect(r.state).toBe("FAILED");
    expect(r.error?.code).toBe("BUDGET_EXCEEDED");
    expect(h.downloads.cancelled).toEqual(["job-1"]);
    expect(acq(h.store, h.run)[0].state).toBe("failed");
  });

  it("is driven by the polling loop while it downloads", async () => {
    const h = harness();
    await h.controller.pollOnce();
    expect(h.downloads.started).toHaveLength(1);
    h.downloads.finish("job-1");
    await h.controller.pollOnce();
    expect(h.store.getRun(h.run.id)?.state).toBe("QUEUED");
  });
});

// ---------------------------------------------------------------------------------------
// The acquire_models effect at prepare and start, end to end (TODO 4.5, 4.6; AT-05)

const FIXTURES_DIR = dirname(fileURLToPath(new URL("./fixtures/load.ts", import.meta.url)));
const STATS: SystemStats = {
  system: { os: "darwin", python_version: "3.12", embedded_python: false, comfyui_version: "0.44.0", ram_total: 1, ram_free: 1 },
  devices: [],
};

/** A selected plan on the t2i fixture whose checkpoint is missing and pinned. */
async function acquirable(opts: { withIo?: boolean; free?: number; env?: Record<string, string>; selectFeasible?: boolean } = {}) {
  const recipeDir = tempDir("architect-acq-recipes-");
  const recipe = JSON.parse(readFileSync(join(FIXTURES_DIR, "t2i-basic.recipe.json"), "utf-8"));
  recipe.id = "recipe-fixture.t2i-acquire";
  recipe.slots = recipe.slots.map((s: { id: string }) => (s.id === "checkpoint" ? { ...s, default: MISSING } : s));
  recipe.modelSources = [{ folder: "checkpoints", file: MISSING, source: SOURCE }];
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
  const prepared = await planning.prepare({ task: TASK });
  const proposed = await planning.propose({ planId: prepared.plan.id });
  const candidate = proposed.candidates[0];
  planning.select({ planId: prepared.plan.id, candidateId: candidate.id });

  const root = modelRoot();
  const downloads = new FakeDownloads(root);
  const hf = new FakeHf();
  const acquisitionIo = io(downloads, hf, { free: opts.free, env: opts.env });
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

async function approvalError(p: Promise<unknown>): Promise<ApprovalError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApprovalError);
  return err as ApprovalError;
}

describe("prepare and start with downloads", () => {
  it("puts the downloads before the render, equal to the candidate's acquisition, and describes them", async () => {
    const s = await acquirable();
    expect(s.candidate.status).toBe("acquirable");
    const r = await s.execution.prepare({ planId: s.planId });
    expect(r.actionPlan.effects.map((e) => e.kind)).toEqual(["acquire_models", "local_render"]);
    const effect = r.actionPlan.effects[0];
    expect(effect).toEqual({
      kind: "acquire_models",
      files: [{ folder: "checkpoints", file: MISSING, source: SOURCE, destinationRoot: s.root }],
      totalBytes: BYTES.length,
      maxBytes: 40 * 1024 ** 3,
      minFreeBytes: MIN_FREE_DISK_BYTES,
    });
    expect(s.downloads.started).toEqual([]);
    const text = describeActionPlan(s.store, r.actionPlan, () => ({ known: true, bytes: 100 * 1024 ** 3 }));
    expect(text).toContain(`checkpoints/${MISSING}: Comfy-Org/Real-ESRGAN@${COMMIT.slice(0, 12)} ${SOURCE.path}`);
    expect(text).toContain(`Destination: ${s.root} (100.0 GiB of disk will remain free`);
    expect(describeActionPlan(s.store, r.actionPlan, () => ({ known: false, reason: "EIO" }))).toContain("free disk unknown (EIO)");
  });

  it("a feasible candidate's plan has no download effect", async () => {
    const { setup } = await import("./fixtures/approval-harness.js");
    const s = await setup();
    const r = await s.execution.prepare({ planId: s.planId });
    expect(r.actionPlan.effects.map((e) => e.kind)).toEqual(["local_render"]);
  });

  it("refuses the ComfyUI-Manager route, an existing destination, too little disk and unreadable disk", async () => {
    let s = await acquirable();
    s.downloads.manager = true;
    expect((await approvalError(s.execution.prepare({ planId: s.planId }))).message).toMatch(/ComfyUI-Manager/);

    s = await acquirable();
    writeFileSync(join(s.root, "checkpoints", MISSING), Buffer.from("x"));
    expect((await approvalError(s.execution.prepare({ planId: s.planId }))).code).toBe("STALE_ENVIRONMENT");

    s = await acquirable({ free: MIN_FREE_DISK_BYTES + BYTES.length - 1 });
    expect((await approvalError(s.execution.prepare({ planId: s.planId }))).message).toMatch(/would remain/);

    s = await acquirable();
    s.acquisitionIo.fs.freeDiskBytes = async () => Promise.reject(new Error("statfs EIO"));
    expect((await approvalError(s.execution.prepare({ planId: s.planId }))).message).toMatch(/couldn't be read/);
    expect(s.store.listRuns()).toEqual([]);
  });

  it("refuses HF_ENDPOINT elsewhere, a server without the downloader, and a destination outside a model folder", async () => {
    let s = await acquirable({ env: { HF_ENDPOINT: "https://hf-mirror.com" } });
    expect((await approvalError(s.execution.prepare({ planId: s.planId }))).message).toMatch(/HF_ENDPOINT/);
    s = await acquirable({ withIo: false });
    expect((await approvalError(s.execution.prepare({ planId: s.planId }))).code).toBe("DEPENDENCY_UNAVAILABLE");
    s = await acquirable();
    s.downloads.resolveTo = (_sub, file) => ({ root: s.root, path: join(s.root, "somewhere", file) });
    expect((await approvalError(s.execution.prepare({ planId: s.planId }))).message).toMatch(/not into a checkpoints folder/);
  });

  it("refuses a remote target at prepare and at start", async () => {
    const s = await acquirable();
    const r = await s.execution.prepare({ planId: s.planId });
    issueGrant(s.deps, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "t", confirmHash: r.shortHash });
    s.setBaseUrl("http://192.0.2.10:8188");
    expect((await approvalError(s.execution.start({ actionPlanId: r.actionPlan.id }))).code).toBe("APPROVAL_INVALIDATED");
    // At prepare the validator already refuses a target that isn't loopback.
    const refused = await approvalError(s.execution.prepare({ planId: s.planId }));
    expect(refused.code).toBe("APPROVAL_INVALIDATED");
    expect(refused.message).toMatch(/not a loopback address/);
    expect(s.downloads.started).toEqual([]);
  });

  it("start without a grant is APPROVAL_REQUIRED and starts no run and no download (AT-05)", async () => {
    const s = await acquirable();
    const r = await s.execution.prepare({ planId: s.planId });
    const err = await approvalError(s.execution.start({ actionPlanId: r.actionPlan.id }));
    expect(err.code).toBe("APPROVAL_REQUIRED");
    expect(s.store.listRuns()).toEqual([]);
    expect(s.driver.advance).not.toHaveBeenCalled();
    expect(s.downloads.started).toEqual([]);
  });

  it("an edited download effect doesn't parse against the plan's hash", async () => {
    const s = await acquirable();
    const r = await s.execution.prepare({ planId: s.planId });
    const effect = r.actionPlan.effects[0];
    if (effect.kind !== "acquire_models") throw new Error("expected the download first");
    const edits = [
      { ...effect, files: effect.files.map((f) => ({ ...f, destinationRoot: "/tmp/elsewhere" })) },
      { ...effect, files: effect.files.map((f) => ({ ...f, source: { ...f.source, revision: "0".repeat(40) } })) },
      { ...effect, maxBytes: effect.maxBytes * 2 },
    ];
    for (const e of edits) {
      expect(ActionPlan.safeParse({ ...r.actionPlan, effects: [e, ...r.actionPlan.effects.slice(1)] }).success).toBe(false);
    }
  });

  it("refuses an approved plan whose download files differ from the candidate's, even with a matching hash", async () => {
    const s = await acquirable();
    const r = await s.execution.prepare({ planId: s.planId });
    const effect = r.actionPlan.effects[0];
    if (effect.kind !== "acquire_models") throw new Error("expected the download first");
    const other = { ...effect, files: effect.files.map((f) => ({ ...f, source: { ...f.source, revision: "1".repeat(40) } })) };
    const effects = [other, ...r.actionPlan.effects.slice(1)];
    const forged = s.store.putActionPlan({ ...r.actionPlan, id: "actions-forged", effects, hash: actionPlanHash({ ...r.actionPlan, effects }) });
    const request = s.store.putApprovalRequest({ ...r.approvalRequest, id: "approval-forged", actionPlanId: forged.id, actionPlanHash: forged.hash });
    issueGrant(s.deps, { requestId: request.id, channel: "terminal", issuer: "t", confirmHash: forged.hash.slice(0, 8) });
    const err = await approvalError(s.execution.start({ actionPlanId: forged.id }));
    expect(err.code).toBe("APPROVAL_INVALIDATED");
    expect(err.message).toMatch(/aren't the ones/);
    expect(s.store.listRuns()).toEqual([]);
  });

  it("an approved plan starts once the user approved; a candidate that became feasible meanwhile needs a new approval", async () => {
    const s = await acquirable();
    const r = await s.execution.prepare({ planId: s.planId });
    issueGrant(s.deps, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "t", confirmHash: r.shortHash });
    s.install();
    expect((await approvalError(s.execution.start({ actionPlanId: r.actionPlan.id }))).code).toBe("APPROVAL_INVALIDATED");

    const t = await acquirable();
    const p = await t.execution.prepare({ planId: t.planId });
    issueGrant(t.deps, { requestId: p.approvalRequest.id, channel: "terminal", issuer: "t", confirmHash: p.shortHash });
    const started = await t.execution.start({ actionPlanId: p.actionPlan.id });
    expect(started.run.state).toBe("PREPARING");
  });

  it("downloads, places, renders and records the acquired file with its commit and sha256 in the lock (FR-11)", async () => {
    const s = await acquirable();
    const ollama = new FakeOllama();
    let n = 0;
    const resources = new ResourceCoordinator({ store: s.store, upstream: ollama.facade(), ownerId: "a", now: s.now, manageResidency: false, fetchImpl: ollama.fetch, probeTimeoutMs: 20 });
    const finished = new Set<string>();
    const controller = new RunController({
      store: s.store,
      upstream: {
        submitPrompt: async (_g, promptId) => ({ kind: "accepted", promptId }),
        queue: async () => ({ running: [], pending: [] }),
        history: async (promptId) => {
          finished.add(promptId);
          return { prompt: {}, outputs: {}, status: { status_str: "success", completed: true, messages: [] } };
        },
        dequeue: async () => ({ removed: false, state: "absent", verified: true }),
        interruptPrompt: async () => undefined,
        outputFile: async () => {
          throw new Error("none");
        },
        decodeImage: async () => ({ width: 1, height: 1 }),
      },
      resources,
      now: s.now,
      newUuid: () => `11111111-2222-4333-8444-${String(++n).padStart(12, "0")}`,
      graphFor: async (run) => {
        const task = s.store.getTask(run.taskId, run.taskRevision);
        if (!task) throw new Error("no task");
        return s.planning.graphOfCandidate(run.candidateId, task).graph;
      },
      taskFor: (run) => {
        const task = s.store.getTask(run.taskId, run.taskRevision);
        if (!task) throw new Error("no task");
        return task;
      },
      revalidate: (run) => requireFeasible(s.planning, run.planId, run.candidateId),
      acquirer: new ModelAcquirer({ store: s.store, io: s.acquisitionIo, now: s.now, newId: s.newId }),
    });
    const execution = new ArchitectExecution({ ...s.deps, driver: controller, dataDir: s.dataDir, dependencyLock: (id, task) => s.planning.dependencyLock(id, task) });
    const r = await execution.prepare({ planId: s.planId });
    issueGrant(s.deps, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "t", confirmHash: r.shortHash });
    const { run } = await execution.start({ actionPlanId: r.actionPlan.id });
    expect(run.state).toBe("PREPARING");
    const status = await execution.status({ runId: run.id });
    expect(status.acquisitions).toEqual([expect.objectContaining({ file: `checkpoints/${MISSING}`, state: "downloading", sizeBytes: BYTES.length })]);

    // Upstream lands the file in staging; ComfyUI lists it once it is placed.
    s.downloads.finish("job-1");
    s.install();
    expect((await controller.reconcile(run.id)).state).toBe("QUEUED");
    const after = await controller.reconcile(run.id);
    expect(["AWAITING_REVIEW", "COMPLETED"]).toContain(after.state);
    expect(s.store.getCandidate(run.candidateId)?.status).toBe("feasible");

    const written = execution.finalize({ runId: run.id });
    const lock = JSON.parse(readFileSync(join(written.dir, "dependencies.lock.json"), "utf-8"));
    expect(lock.acquired).toEqual([
      {
        folder: "checkpoints",
        file: MISSING,
        repo: SOURCE.repo,
        commit: COMMIT,
        path: SOURCE.path,
        sha256: SHA,
        sizeBytes: BYTES.length,
        placedPath: join(s.root, "checkpoints", MISSING),
        license: "bsd-3-clause",
      },
    ]);
    const record = JSON.parse(readFileSync(join(written.dir, "run.json"), "utf-8"));
    expect(record.lineage.acquisitions).toEqual([expect.objectContaining({ state: "placed", sha256: SHA, pinnedSha256: SHA })]);
  });

  it("fails the run when ComfyUI doesn't offer the placed file on the fresh snapshot", async () => {
    const s = await acquirable();
    const ollama = new FakeOllama();
    const resources = new ResourceCoordinator({ store: s.store, upstream: ollama.facade(), ownerId: "a", now: s.now, manageResidency: false, fetchImpl: ollama.fetch, probeTimeoutMs: 20 });
    const controller = new RunController({
      store: s.store,
      upstream: {
        submitPrompt: async (_g, promptId) => ({ kind: "accepted", promptId }),
        queue: async () => ({ running: [], pending: [] }),
        history: async () => undefined,
        dequeue: async () => ({ removed: false, state: "absent", verified: true }),
        interruptPrompt: async () => undefined,
        outputFile: async () => {
          throw new Error("none");
        },
        decodeImage: async () => ({ width: 1, height: 1 }),
      },
      resources,
      now: s.now,
      newUuid: () => "11111111-2222-4333-8444-555555555555",
      graphFor: async () => {
        throw new Error("not reached");
      },
      taskFor: () => {
        throw new Error("not reached");
      },
      revalidate: (run) => requireFeasible(s.planning, run.planId, run.candidateId),
      acquirer: new ModelAcquirer({ store: s.store, io: s.acquisitionIo, now: s.now, newId: s.newId }),
    });
    const execution = new ArchitectExecution({ ...s.deps, driver: controller, dataDir: s.dataDir, dependencyLock: (id, task) => s.planning.dependencyLock(id, task) });
    const r = await execution.prepare({ planId: s.planId });
    issueGrant(s.deps, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "t", confirmHash: r.shortHash });
    const { run } = await execution.start({ actionPlanId: r.actionPlan.id });
    s.downloads.finish("job-1");
    // Placed on disk, but the target's listing never shows it.
    const after = await controller.reconcile(run.id);
    expect(after.state).toBe("FAILED");
    expect(after.error?.message).toMatch(/isn't feasible on a fresh snapshot/);
    expect(after.promptId).toBeUndefined();
  });
});

describe("the architect_plan propose envelope", () => {
  it("names what is acquirable and the total download instead of calling the candidates blocked", async () => {
    const s = await acquirable();
    const server = new McpServer({ name: "t", version: "0" });
    registerArchitectTools(server, s.service, () => s.planning, () => {
      throw new Error("no runs in this test");
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(b), c.connect(a)]);
    const prepared = await s.planning.prepare({ task: TASK });
    const res = await c.callTool({ name: "architect_plan", arguments: { action: "propose", planId: prepared.plan.id } });
    const content = res.content as { type: string; text: string }[];
    const envelope = ResultEnvelope.parse(JSON.parse(content[0].text));
    expect(envelope.status).toBe("partial");
    expect(envelope.summary).toContain("acquirable after downloading pinned model files");
    expect(envelope.summary).toContain(`checkpoints/${MISSING}`);
    expect(envelope.summary).not.toContain("blocked or diagnostic");
    await c.close();
  });
});
