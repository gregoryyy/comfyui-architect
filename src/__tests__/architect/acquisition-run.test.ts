// Milestone 4, part B (TODO 4.5, 4.5.2, 4.5.3, 4.6): the redirect preflight, staging next
// to the destination,
// verification and placement; the controller's downloads in PREPARING, their cancellation
// and restart; the acquire_models effect at prepare and start; and the run's lineage. A fake
// downloader writes into temporary model folders; a fake Hugging Face answers the HEADs.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import {
  type AcquisitionIo,
  type HeadFetch,
  diskShortfall,
  MAX_DOWNLOAD_ATTEMPTS,
  ModelAcquirer,
  NODE_ACQUISITION_FS,
  stagedNameOf,
  pinnedUrl,
  placeStaged,
  preflightRedirects,
  verifyStaged,
} from "../../services/architect/acquisition.js";
import { MIN_FREE_DISK_BYTES, formatBytes } from "../../services/architect/acquisition-policy.js";
import { ApprovalError, DEFAULT_MAX_WALL_TIME_SECONDS, describeActionPlan, issueGrant, requireFeasible } from "../../services/architect/admission.js";
import { RunController, type RunControllerDeps } from "../../services/architect/controller.js";
import { ArchitectExecution } from "../../services/architect/execution.js";
import { ResourceCoordinator } from "../../services/architect/resources.js";
import { AcquisitionRecord, ActionPlan, ResultEnvelope, type RunRecord, actionPlanHash } from "../../services/architect/schemas.js";
import { ARCHITECT_DB_FILE, ArchitectStore } from "../../services/architect/store.js";
import { registerArchitectTools } from "../../tools/architect.js";
import { TASK } from "./fixtures/approval-harness.js";
import {
  BYTES,
  COMMIT,
  FakeDownloads,
  type FakeJob,
  FakeHf,
  MISSING,
  SHA,
  SOURCE,
  acquirable,
  effectFor,
  io,
  modelRoot,
  stores,
  tempDir,
} from "./fixtures/acquisition-harness.js";
import { FakeOllama, RUN_CREATED, seedRun } from "./fixtures/run-harness.js";

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

  it("refuses before any download when Hugging Face's X-Linked-Size or X-Linked-Etag contradict the pin", async () => {
    const hf = new FakeHf();
    hf.routes.set(url, { status: 302, location: "https://us.aws.cdn.hf.co/x", headers: { "x-linked-size": "12", "x-linked-etag": `"${SHA}"` } });
    const bySize = await preflightRedirects(url, hf.fetch, { pinned: SOURCE });
    expect(!bySize.ok && bySize.refused && bySize.message).toMatch(/reports 12 bytes/);
    hf.routes.set(url, { status: 302, location: "https://us.aws.cdn.hf.co/x", headers: { "x-linked-size": String(SOURCE.sizeBytes), "x-linked-etag": `"${"0".repeat(64)}"` } });
    const byHash = await preflightRedirects(url, hf.fetch, { pinned: SOURCE });
    expect(!byHash.ok && byHash.refused && byHash.message).toMatch(/reports sha256 00000000/);
  });

  it("accepts a CDN that refuses HEAD (403, 405) only after Hugging Face named the pinned size and sha256", async () => {
    const hf = new FakeHf();
    for (const status of [403, 405]) {
      hf.routes.set("https://us.aws.cdn.hf.co/xet-bridge-us/abc?sig=1", { status });
      expect(await preflightRedirects(url, hf.fetch, { pinned: SOURCE })).toMatchObject({ ok: true, hops: 1, headRefused: status });
      // Without the pin to compare, or without the linked headers, the refusal stands.
      expect(await preflightRedirects(url, hf.fetch)).toMatchObject({ ok: false, refused: true });
    }
    hf.routes.set(url, { status: 302, location: "https://us.aws.cdn.hf.co/xet-bridge-us/abc?sig=1" });
    expect(await preflightRedirects(url, hf.fetch, { pinned: SOURCE })).toMatchObject({ ok: false, refused: true });
    // A 403 from huggingface.co itself, with no redirect before it, is refused.
    hf.routes.set(url, { status: 403 });
    expect(await preflightRedirects(url, hf.fetch, { pinned: SOURCE })).toMatchObject({ ok: false, refused: true });
  });

  it("refuses when HF_ENDPOINT points elsewhere, before any request; Hugging Face itself is fine", async () => {
    const hf = new FakeHf();
    const r = await preflightRedirects(url, hf.fetch, { env: { HF_ENDPOINT: "https://hf-mirror.com" } });
    expect(r).toMatchObject({ ok: false, refused: true });
    expect(!r.ok && r.message).toContain("hf-mirror.com");
    expect(hf.calls).toHaveLength(0);
    expect(await preflightRedirects(url, hf.fetch, { env: { HF_ENDPOINT: "https://huggingface.co/" } })).toMatchObject({ ok: true });
    expect(await preflightRedirects(url, hf.fetch, { env: { HF_ENDPOINT: "  " } })).toMatchObject({ ok: true });
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
    expect(await preflightRedirects(url, gated, { token: "hf_secret" })).toMatchObject({ ok: true });
    expect(hf.calls.map((c) => c.headers.Authorization)).toEqual([undefined, "Bearer hf_secret", undefined]);
  });
});

// ---------------------------------------------------------------------------------------
// Staging, verification and placement (TODO 4.5.2; SEC T4, T9)

describe("staging, verification and placement", () => {
  const fs = NODE_ACQUISITION_FS;

  /** The device and inode verification would have read from the hashed handle. */
  async function identity(p: string) {
    const st = await fs.lstat(p);
    return { dev: st.dev, ino: st.ino };
  }

  /** A file staged next to its destination, as upstream's download leaves it for run-1. */
  async function staged(root: string, bytes = BYTES): Promise<string> {
    const p = join(root, "checkpoints", stagedNameOf(MISSING, "run-1"));
    writeFileSync(p, bytes);
    return p;
  }

  it("stages under a name no loader lists, next to the destination", () => {
    expect(stagedNameOf(MISSING, "run-1")).toBe(`${MISSING}.architect-run-1`);
    expect(() => stagedNameOf("x", "run-a.safetensors")).toThrow(/would look like a model file/);
    expect(() => stagedNameOf("x", "run-a.PT")).toThrow(/would look like a model file/);
  });

  it("places a staged file whose sha256 and size are the pinned ones, and the staged file is gone", async () => {
    const root = modelRoot();
    const p = await staged(root);
    expect(await verifyStaged(fs, p, SOURCE)).toMatchObject({ kind: "match", sha256: SHA, bytes: BYTES.length });
    expect(await placeStaged(fs, { root, folder: "checkpoints", file: MISSING, stagedPath: p, source: SOURCE, verified: await identity(p) })).toEqual({
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
    const p = join(root, "checkpoints", stagedNameOf(MISSING, "run-1"));
    const elsewhere = join(tempDir("architect-elsewhere-"), "real.safetensors");
    writeFileSync(elsewhere, BYTES);
    symlinkSync(elsewhere, p);
    const v = await verifyStaged(fs, p, SOURCE);
    expect(v.kind === "mismatch" && v.message).toMatch(/symbolic link/);
    expect(existsSync(elsewhere)).toBe(true);
  });

  it("counts an existing destination with the pinned bytes as placed", async () => {
    const root = modelRoot();
    writeFileSync(join(root, "checkpoints", MISSING), BYTES);
    const p = await staged(root);
    expect(await placeStaged(fs, { root, folder: "checkpoints", file: MISSING, stagedPath: p, source: SOURCE, verified: await identity(p) })).toMatchObject({ ok: true, preexisting: true });
    expect(existsSync(p)).toBe(false);
  });

  it("never overwrites an existing destination with other bytes", async () => {
    const root = modelRoot();
    const theirs = Buffer.from("the user's own file");
    writeFileSync(join(root, "checkpoints", MISSING), theirs);
    const p = await staged(root);
    const r = await placeStaged(fs, { root, folder: "checkpoints", file: MISSING, stagedPath: p, source: SOURCE, verified: await identity(p) });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/already exists with other content/);
    expect(readFileSync(join(root, "checkpoints", MISSING))).toEqual(theirs);
  });

  it("refuses a model folder that resolves outside the root (path escape), and removes only its staged file", async () => {
    const root = tempDir("architect-models-");
    const outside = tempDir("architect-outside-");
    writeFileSync(join(outside, "theirs.safetensors"), Buffer.from("someone's"));
    symlinkSync(outside, join(root, "checkpoints"));
    const p = await staged(root);
    const r = await placeStaged(fs, { root, folder: "checkpoints", file: MISSING, stagedPath: p, source: SOURCE, verified: await identity(p) });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/outside/);
    expect(readdirSync(outside)).toEqual(["theirs.safetensors"]);
  });

  it("refuses a staged path that isn't in the destination folder", async () => {
    const root = modelRoot();
    mkdirSync(join(root, "vae"));
    const p = join(root, "vae", stagedNameOf(MISSING, "run-1"));
    writeFileSync(p, BYTES);
    const r = await placeStaged(fs, { root, folder: "checkpoints", file: MISSING, stagedPath: p, source: SOURCE, verified: await identity(p) });
    expect(!r.ok && r.message).toMatch(/isn't in the destination folder/);
    expect(readdirSync(join(root, "checkpoints"))).toEqual([]);
  });

  it("refuses a staged file replaced after it was hashed, and places nothing", async () => {
    const root = modelRoot();
    const p = await staged(root);
    const v = await verifyStaged(fs, p, SOURCE);
    if (v.kind !== "match") throw new Error("expected a match");
    const other = join(dirname(p), "other");
    writeFileSync(other, Buffer.from("swapped in after hashing"));
    renameSync(other, p);
    const r = await placeStaged(fs, { root, folder: "checkpoints", file: MISSING, stagedPath: p, source: SOURCE, verified: { dev: v.dev, ino: v.ino } });
    expect(!r.ok && r.message).toMatch(/replaced after it was verified/);
    expect(readdirSync(join(root, "checkpoints"))).toEqual([]);
  });

  it("removes only its own new link when the staged file is swapped between the check and the link", async () => {
    const root = modelRoot();
    const p = await staged(root);
    const v = await verifyStaged(fs, p, SOURCE);
    if (v.kind !== "match") throw new Error("expected a match");
    const racing = {
      ...fs,
      link: async (a: string, b: string) => {
        const other = join(dirname(a), "other");
        writeFileSync(other, Buffer.from("swapped in during the link"));
        renameSync(other, a);
        await fs.link(a, b);
      },
    };
    const r = await placeStaged(racing, { root, folder: "checkpoints", file: MISSING, stagedPath: p, source: SOURCE, verified: { dev: v.dev, ino: v.ino } });
    expect(!r.ok && r.message).toMatch(/changed between verification and placement/);
    expect(readdirSync(join(root, "checkpoints"))).toEqual([]);
  });

  it("refuses to place into a model folder swapped for a link after verification", async () => {
    const root = modelRoot();
    const p = await staged(root);
    const verified = await identity(p);
    const outside = tempDir("architect-outside-");
    writeFileSync(join(outside, stagedNameOf(MISSING, "run-1")), BYTES);
    renameSync(join(root, "checkpoints"), join(root, "checkpoints-moved"));
    symlinkSync(outside, join(root, "checkpoints"));
    const r = await placeStaged(fs, { root, folder: "checkpoints", file: MISSING, stagedPath: p, source: SOURCE, verified });
    expect(r.ok).toBe(false);
    expect(existsSync(join(outside, MISSING))).toBe(false);
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
  /** Where a run stages its one file: next to the destination, under the run's staged name. */
  const stagedOf = (root: string, run: RunRecord) => join(root, "checkpoints", stagedNameOf(MISSING, run.id));

  it("downloads next to the destination under the staged name, verifies, places, revalidates on a fresh snapshot, then submits", async () => {
    const h = harness();
    let r = await h.controller.advance(h.run.id);
    expect(r.state).toBe("PREPARING");
    expect(h.downloads.started).toEqual([{ url: pinnedUrl(SOURCE), subfolder: "checkpoints", filename: stagedNameOf(MISSING, h.run.id) }]);
    expect(h.hf.calls.map((c) => c.url)[0]).toBe(pinnedUrl(SOURCE));
    expect(acq(h.store, h.run)[0]).toMatchObject({ state: "downloading", jobId: "job-1", stagedPath: stagedOf(h.root, h.run) });
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
    expect(readdirSync(join(h.root, "checkpoints")).filter((f) => f.includes(".architect-"))).toEqual([]);
    expect(h.downloads.forgot).toBe(1);
    expect(h.revalidate).toHaveBeenCalledTimes(1);
    const notes = h.store.listRunEvents(h.run.id).filter((e) => e.kind === "note").map((e) => e.data?.acquisitionTo);
    expect(notes.filter((x) => x !== undefined)).toEqual(["downloading", "verifying", "placed"]);
  });

  it("a hash mismatch fails the run and leaves nothing in the model folder, staged file included", async () => {
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
    expect(readdirSync(join(h.root, "checkpoints")).filter((f) => f.includes(".architect-"))).toEqual([]);
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
    expect(r.error?.message).toMatch(/would leave less than 50\.0 GiB/);
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

  it("stages next to a destination an extra model path moves to another root (the reference target's layout)", async () => {
    // Upstream redirects a model category to the directory the server's
    // --extra-model-paths-config names for it, and leaves any other subfolder under the
    // primary root (model-resolver.ts, resolveModelSubfolderWithLiveRoot).
    const primary = modelRoot();
    const shared = modelRoot();
    const downloads = new FakeDownloads(shared);
    downloads.resolveTo = (sub, file) =>
      sub === "checkpoints" ? { root: shared, path: join(shared, "checkpoints", file) } : { root: primary, path: join(primary, sub, file) };
    const h = harness({ root: shared, downloads });
    await h.controller.advance(h.run.id);
    expect(acq(h.store, h.run)[0]).toMatchObject({ state: "downloading", stagedPath: join(shared, "checkpoints", stagedNameOf(MISSING, h.run.id)) });
    downloads.finish("job-1");
    expect((await h.controller.reconcile(h.run.id)).state).toBe("QUEUED");
    expect(readFileSync(join(shared, "checkpoints", MISSING))).toEqual(BYTES);
    expect(readdirSync(join(shared, "checkpoints"))).toEqual([MISSING]);
    expect(readdirSync(primary)).toEqual(["checkpoints"]);
    expect(readdirSync(join(primary, "checkpoints"))).toEqual([]);
  });

  it("refuses when upstream would stage the file somewhere other than next to its destination", async () => {
    const root = modelRoot();
    const downloads = new FakeDownloads(root);
    downloads.resolveTo = (sub, file) => ({ root, path: file === MISSING ? join(root, sub, file) : join(root, "elsewhere", file) });
    const h = harness({ root, downloads });
    const r = await h.controller.advance(h.run.id);
    expect(r.state).toBe("FAILED");
    expect(r.error?.message).toMatch(/would stage/);
    // Known only from the job upstream started: that job, the run's own, is stopped.
    expect(downloads.cancelled).toEqual(["job-1"]);
    expect(readdirSync(join(root, "checkpoints"))).toEqual([]);
  });

  it("resolves once per step: a step holds the run's turn for one resolve and one upstream start", async () => {
    const h = harness();
    await h.controller.advance(h.run.id);
    expect(h.downloads.resolves).toBe(1);
    expect(h.downloads.started).toHaveLength(1);
    // A poll while a step runs doesn't stack a second one for the run.
    h.downloads.resolveDelayMs = 50;
    (h.downloads.jobs.get("job-1") as FakeJob).status = "error";
    const first = h.controller.reconcile(h.run.id); // back to planned, no resolve
    await first;
    const stepping = h.controller.reconcile(h.run.id); // planned: starts a resolve
    await new Promise((r) => setTimeout(r, 5));
    expect(h.controller.busy(h.run.id)).toBe(true);
    await h.controller.pollOnce();
    await stepping;
    expect(h.downloads.started).toHaveLength(2);
    expect(h.downloads.resolves).toBe(2);
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
    writeFileSync(stagedOf(h.root, h.run), BYTES.subarray(0, 5));
    const r = await h.controller.cancel(h.run.id, "agent");
    expect(r.state).toBe("CANCELLED");
    expect(h.downloads.cancelled).toEqual([ours]);
    expect(h.downloads.jobs.get(theirs)?.status).toBe("downloading");
    expect(acq(h.store, h.run)[0].state).toBe("cancelled");
    expect(readdirSync(join(h.root, "checkpoints")).filter((f) => f.includes(".architect-"))).toEqual([]);
    expect(readdirSync(join(h.root, "checkpoints"))).toEqual([]);
  });

  it("after a restart, verifies a complete staged file whose job is gone, then places it", async () => {
    const root = modelRoot();
    const store = openStore();
    const first = harness({ root, store });
    await first.controller.advance(first.run.id);
    // The process stops; the file had landed, but the job's record is lost with it.
    writeFileSync(stagedOf(root, first.run), BYTES);
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
    writeFileSync(stagedOf(root, first.run), BYTES.subarray(0, 100));
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

  it("removes upstream's cache copy of the placed file, its hard link, and its sidecar; nothing else in the cache", async () => {
    const h = harness();
    await h.controller.advance(h.run.id);
    const entry = h.downloads.downloadCacheEntry(pinnedUrl(SOURCE));
    const unrelated = join(h.downloads.cacheDir, "someone-elses.safetensors");
    writeFileSync(unrelated, Buffer.from("another download"));
    h.downloads.finish("job-1");
    expect((await h.controller.reconcile(h.run.id)).state).toBe("QUEUED");
    expect(existsSync(entry.cachePath)).toBe(false);
    expect(existsSync(entry.contentTypeSidecar)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(readFileSync(join(h.root, "checkpoints", MISSING))).toEqual(BYTES);
    const note = h.store.listRunEvents(h.run.id).find((e) => Array.isArray(e.data?.cacheRemoved));
    expect(note?.data?.cacheRemoved).toEqual([`<download cache>/${entry.cachePath.split("/").pop()}`, `<download cache>/${entry.contentTypeSidecar.split("/").pop()}`]);
  });

  it("removes a copied cache entry only when it holds the pinned bytes", async () => {
    const root = modelRoot();
    const downloads = new FakeDownloads(root);
    downloads.copyFromCache = true;
    const h = harness({ root, downloads });
    await h.controller.advance(h.run.id);
    downloads.finish("job-1");
    expect((await h.controller.reconcile(h.run.id)).state).toBe("QUEUED");
    expect(existsSync(downloads.downloadCacheEntry(pinnedUrl(SOURCE)).cachePath)).toBe(false);

    // Another case: the cache entry was replaced by other bytes before placement; it stays.
    for (const st of stores.splice(0)) st.close();
    dataDir = tempDir("architect-acq-run-");
    const root2 = modelRoot();
    const d2 = new FakeDownloads(root2);
    d2.copyFromCache = true;
    const h2 = harness({ root: root2, downloads: d2 });
    await h2.controller.advance(h2.run.id);
    d2.finish("job-1");
    const entry = d2.downloadCacheEntry(pinnedUrl(SOURCE));
    rmSync(entry.cachePath);
    writeFileSync(entry.cachePath, Buffer.from("not the pinned bytes"));
    expect((await h2.controller.reconcile(h2.run.id)).state).toBe("QUEUED");
    expect(readFileSync(entry.cachePath).toString()).toBe("not the pinned bytes");
  });

  it("stops the run's job when upstream's cache .partial grows past the pinned size (no progress channel)", async () => {
    const h = harness();
    await h.controller.advance(h.run.id);
    h.downloads.partial("job-1", BYTES.length - 1);
    expect((await h.controller.reconcile(h.run.id)).state).toBe("PREPARING");
    const view = await h.acquirer.view(h.run.id);
    expect(view[0].bytesSoFar).toBe(BYTES.length - 1);
    h.downloads.partial("job-1", BYTES.length + 1);
    const r = await h.controller.reconcile(h.run.id);
    expect(r.state).toBe("FAILED");
    expect(r.error?.message).toMatch(/more than the pinned/);
    expect(h.downloads.cancelled).toEqual(["job-1"]);
  });

  it("doesn't restart a job cancelled outside the run; the run fails with the reason", async () => {
    const h = harness();
    await h.controller.advance(h.run.id);
    (h.downloads.jobs.get("job-1") as FakeJob).status = "cancelled";
    const r = await h.controller.reconcile(h.run.id);
    expect(r.state).toBe("FAILED");
    expect(r.error).toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    expect(r.error?.message).toMatch(/the download was cancelled outside the run/);
    expect(acq(h.store, h.run)[0].state).toBe("cancelled");
    expect(h.downloads.started).toHaveLength(1);
  });

  it("fails with APPROVAL_INVALIDATED when the consumed grant doesn't bind the stored action plan; nothing downloads", async () => {
    const store = openStore();
    const run = seedRun(store, { acquire: effectFor(modelRoot()) });
    const db = new BetterSqlite3(join(dataDir, ARCHITECT_DB_FILE));
    db.prepare("UPDATE approval_grants SET payload = json_set(payload, '$.actionPlanHash', ?) WHERE id = ?").run("f".repeat(64), run.grantId);
    db.close();
    const h = harness({ store, seed: false });
    const r = await h.controller.advance(run.id);
    expect(r.state).toBe("FAILED");
    expect(r.error?.code).toBe("APPROVAL_INVALIDATED");
    expect(h.downloads.started).toEqual([]);
    expect(() => store.createAcquisitions({ runId: run.id, now: clock, newId: () => "x" })).toThrow(/doesn't bind action plan/);
  });

  it("counts other runs' unfinished downloads as reserved, and the cache's disk when it is another device", async () => {
    const root = modelRoot();
    const downloads = new FakeDownloads(root);
    const files = [{ destinationRoot: root, source: SOURCE }];
    const other = AcquisitionRecord.parse({
      schemaVersion: 1,
      id: "acq-other",
      runId: "run-other",
      actionPlanId: "actions-other",
      folder: "checkpoints",
      file: "other.safetensors",
      source: SOURCE,
      destinationRoot: root,
      state: "planned",
      createdAt: RUN_CREATED.toISOString(),
      updatedAt: RUN_CREATED.toISOString(),
    });
    const none = { listOpenAcquisitions: () => [] };
    const busy = { listOpenAcquisitions: () => [other] };
    const free = MIN_FREE_DISK_BYTES + BYTES.length + 10;
    const same = io(downloads, new FakeHf(), { free });
    expect(await diskShortfall(same, none, files, MIN_FREE_DISK_BYTES)).toBeUndefined();
    expect(await diskShortfall(same, busy, files, MIN_FREE_DISK_BYTES)).toMatch(/still to come for other runs' downloads/);
    expect(await diskShortfall(same, busy, files, MIN_FREE_DISK_BYTES, { exceptRunId: "run-other" })).toBeUndefined();
    // The cache on another device with too little room: refused, naming the cache's disk.
    const split = io(downloads, new FakeHf(), { cacheOnOtherDevice: true, free: async (p) => (p.startsWith(downloads.cacheDir) ? MIN_FREE_DISK_BYTES : 10 * MIN_FREE_DISK_BYTES) });
    expect(await diskShortfall(split, none, files, MIN_FREE_DISK_BYTES)).toContain(downloads.cacheDir);
  });

  it("sends upstream's Hugging Face token in the preflight only after a 401 from huggingface.co", async () => {
    const root = modelRoot();
    const downloads = new FakeDownloads(root);
    downloads.token = "hf_from_upstream_config";
    const hf = new FakeHf();
    let first = true;
    const gated: HeadFetch = async (u, init) => {
      if (u.startsWith("https://huggingface.co/") && first) {
        first = false;
        hf.calls.push({ url: u, headers: init.headers });
        return { status: 401, headers: { get: () => null } };
      }
      return hf.fetch(u, init);
    };
    const h = harness({ root, downloads, io: { ...io(downloads, hf), fetch: gated } });
    expect((await h.controller.advance(h.run.id)).state).toBe("PREPARING");
    expect(hf.calls.map((c) => c.headers.Authorization)).toEqual([undefined, "Bearer hf_from_upstream_config", undefined]);
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

async function approvalError(p: Promise<unknown>): Promise<ApprovalError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApprovalError);
  return err as ApprovalError;
}

describe("prepare and start with downloads", () => {
  it("adds a download allowance at 10 MB/s to the default wall time, and keeps a task's own wall time", async () => {
    const big = await acquirable();
    const r = await big.execution.prepare({ planId: big.planId });
    expect(r.actionPlan.budgets.maxWallTimeSeconds).toBe(DEFAULT_MAX_WALL_TIME_SECONDS + Math.ceil(BYTES.length / 10_000_000));
    const text = describeActionPlan(big.store, r.actionPlan, () => ({ known: true, bytes: 100 * 1024 ** 3 }));
    expect(text).toMatch(/at most 1801 s from the start, downloads included \(1800 s plus 1 s for .* at 10 MB\/s\)/);
    const own = await acquirable({ task: { budgets: { maxWallTimeSeconds: 900 } } });
    const p = await own.execution.prepare({ planId: own.planId });
    expect(p.actionPlan.budgets.maxWallTimeSeconds).toBe(900);
    expect(describeActionPlan(own.store, p.actionPlan, () => ({ known: true, bytes: 1 }))).not.toContain("downloads included");
  });

  it("refuses at prepare when the download cache's disk, another device, lacks the reserve", async () => {
    const s = await acquirable({ cacheOnOtherDevice: true });
    s.acquisitionIo.fs.freeDiskBytes = async (p) => (p.startsWith(s.downloads.cacheDir) ? MIN_FREE_DISK_BYTES : 10 * MIN_FREE_DISK_BYTES);
    const err = await approvalError(s.execution.prepare({ planId: s.planId }));
    expect(err.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(err.message).toContain(s.downloads.cacheDir);
  });

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
    expect(text).toContain("(fixture recipe)");
    // Each file is a line of its own, not folded into the effect's line.
    expect(text.split("\n")).toContain(`  checkpoints/${MISSING}: Comfy-Org/Real-ESRGAN@${COMMIT.slice(0, 12)} ${SOURCE.path}, ${formatBytes(BYTES.length)}, licence bsd-3-clause`);
    expect(text).not.toContain("no maintainer has reviewed it");
  });

  it("names a proposed recipe's tier in the download approval (GAPS Q30)", async () => {
    const s = await acquirable({ certification: "proposed" });
    expect(s.candidate.status).toBe("acquirable");
    const r = await s.execution.prepare({ planId: s.planId });
    const text = describeActionPlan(s.store, r.actionPlan, () => ({ known: true, bytes: 100 * 1024 ** 3 }));
    expect(text).toContain("(proposed recipe)");
    expect(text).toContain("an agent wrote it and pinned its download sources, and no maintainer has reviewed it yet");
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
    expect((await approvalError(s.execution.prepare({ planId: s.planId }))).message).toMatch(/would leave less than/);

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

  it("refuses at prepare when upstream wouldn't stage a file next to its destination", async () => {
    const s = await acquirable();
    s.downloads.resolveTo = (sub, file) => ({ root: s.root, path: file === MISSING ? join(s.root, sub, file) : join(s.root, "other", file) });
    const err = await approvalError(s.execution.prepare({ planId: s.planId }));
    expect(err.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(err.message).toMatch(/not next to its destination/);
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
    // start returns before the download step; a reconcile waits its turn behind it.
    await controller.reconcile(run.id);
    expect(run.state).toBe("PREPARING");
    const status = await execution.status({ runId: run.id });
    expect(status.acquisitions).toEqual([expect.objectContaining({ file: `checkpoints/${MISSING}`, state: "downloading", sizeBytes: BYTES.length })]);

    // Upstream lands the file under its staged name; ComfyUI lists it once it is placed.
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
        license: "bsd-3-clause",
      },
    ]);
    const recordText = readFileSync(join(written.dir, "run.json"), "utf-8");
    const record = JSON.parse(recordText);
    expect(record.lineage.acquisitions).toEqual([expect.objectContaining({ state: "placed", placed: `checkpoints/${MISSING}`, sha256: SHA, pinnedSha256: SHA })]);
    // spec §15.5: no machine-specific path in the exported record or the lock.
    expect(recordText).not.toContain(s.root);
    expect(readFileSync(join(written.dir, "dependencies.lock.json"), "utf-8")).not.toContain(s.root);
  });

  it("start returns before a slow download step finishes; the poller then continues the run", async () => {
    const s = await acquirable();
    s.downloads.resolveDelayMs = 200; // upstream's resolver waiting on a hanging lsof
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
      graphFor: async (run) => {
        const task = s.store.getTask(run.taskId, run.taskRevision);
        if (!task) throw new Error("no task");
        return s.planning.graphOfCandidate(run.candidateId, task).graph;
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
    s.downloads.resolves = 0;
    const t0 = Date.now();
    const started = await execution.start({ actionPlanId: r.actionPlan.id });
    const startMs = Date.now() - t0;
    expect(started.run.state).toBe("PREPARING");
    expect(s.downloads.started).toEqual([]); // the step is still in its resolve
    expect(controller.busy(started.run.id)).toBe(true);
    // status doesn't wait behind the step either.
    const quick = await execution.status({ runId: started.run.id });
    expect(quick.run.state).toBe("PREPARING");
    // start's own rebuild resolved once (200 ms here); the step, scheduled, hadn't finished its resolve.
    expect(s.downloads.resolves).toBeLessThanOrEqual(2);
    expect(startMs).toBeLessThan(400);
    await controller.reconcile(started.run.id); // waits for the scheduled step's turn
    expect(s.downloads.started).toHaveLength(1);
    s.downloads.finish("job-1");
    s.install();
    s.downloads.resolveDelayMs = 0;
    await new Promise((r) => setTimeout(r, 0)); // the finished call's turn is released
    await controller.pollOnce();
    expect(s.store.getRun(started.run.id)?.state).toBe("QUEUED");
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
    // start returns before the download step; a reconcile waits its turn behind it.
    await controller.reconcile(run.id);
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
