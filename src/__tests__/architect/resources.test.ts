import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type FetchLike,
  ResourceCoordinator,
  keepAliveToRestore,
  memoryPool,
  probeOllamaResidency,
} from "../../services/architect/resources.js";
import { Effect, RunRecord } from "../../services/architect/schemas.js";
import { ArchitectStore } from "../../services/architect/store.js";
import { BASE_URL, T } from "./fixtures/execution-records.js";
import { FakeOllama, releaseOf, seedRun } from "./fixtures/run-harness.js";

const OLLAMA = "http://127.0.0.1:11434";

/** A fetch that answers with a JSON body. */
function answering(body: unknown, status = 200): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(body), { status });
  };
  return Object.assign(f, { calls });
}

/** A fetch that fails the way Node's does when nothing listens on the port. */
const refused: FetchLike = async () => {
  throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" }) });
};

/** A fetch that waits for its abort signal, as a hung Ollama makes it. */
const hanging: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  });

describe("memoryPool", () => {
  it("normalises the target's base URL", () => {
    expect(memoryPool("http://LOCALHOST:8188/")).toBe("http://localhost:8188");
    expect(memoryPool("http://127.0.0.1:8188")).toBe(memoryPool("http://127.0.0.1:8188/"));
    expect(memoryPool("https://example.org:443/comfy/")).toBe("https://example.org/comfy");
    expect(memoryPool("http://127.0.0.1:8188")).not.toBe(memoryPool("http://127.0.0.1:8189"));
  });
});

describe("probeOllamaResidency", () => {
  it("counts models with memory on the device as resident", async () => {
    const f = answering({
      models: [
        { name: "llama3:8b", model: "llama3:8b", size_vram: 5_000_000_000 },
        { name: "tiny:1b", model: "tiny:1b", size_vram: 0 },
      ],
    });
    expect(await probeOllamaResidency(OLLAMA, f, 1000)).toEqual({
      state: "resident",
      models: ["llama3:8b"],
      detail: [{ name: "llama3:8b", sizeBytes: 5_000_000_000 }],
    });
    expect(f.calls).toEqual([`${OLLAMA}/api/ps`]);
  });

  it("keeps each resident model's size and expiry in the detail", async () => {
    const f = answering({ models: [{ model: "qwen3:32b", size_vram: 2e10, expires_at: "2026-11-15T12:10:00Z" }] });
    expect(await probeOllamaResidency(OLLAMA, f, 1000)).toMatchObject({
      detail: [{ name: "qwen3:32b", sizeBytes: 2e10, expiresAt: "2026-11-15T12:10:00Z" }],
    });
  });

  it("reports idle for an empty list", async () => {
    expect(await probeOllamaResidency(OLLAMA, answering({ models: [] }), 1000)).toEqual({ state: "idle" });
  });

  it("reports absent when the connection is refused, also for every address of localhost", async () => {
    expect((await probeOllamaResidency(OLLAMA, refused, 1000)).state).toBe("absent");
    const both: FetchLike = async () => {
      const e = (addr: string) => Object.assign(new Error(`connect ECONNREFUSED ${addr}`), { code: "ECONNREFUSED" });
      throw new TypeError("fetch failed", { cause: new AggregateError([e("::1"), e("127.0.0.1")]) });
    };
    expect((await probeOllamaResidency("http://localhost:11434", both, 1000)).state).toBe("absent");
  });

  it("reports unknown, never idle, for a timeout, an error status, a bad body or another network error", async () => {
    const timeout = await probeOllamaResidency(OLLAMA, hanging, 20);
    expect(timeout).toMatchObject({ state: "unknown" });
    expect(timeout.state === "unknown" && timeout.reason).toMatch(/within 20 ms/);
    expect((await probeOllamaResidency(OLLAMA, answering({}, 500), 1000)).state).toBe("unknown");
    expect((await probeOllamaResidency(OLLAMA, answering({ models: "none" }), 1000)).state).toBe("unknown");
    const html: FetchLike = async () => new Response("<html>proxy</html>", { status: 200 });
    expect((await probeOllamaResidency(OLLAMA, html, 1000)).state).toBe("unknown");
    const reset: FetchLike = async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    };
    expect((await probeOllamaResidency(OLLAMA, reset, 1000)).state).toBe("unknown");
  });

  it("doesn't probe an Ollama at another machine's IP address: it doesn't share this machine's pool", async () => {
    const f = answering({ models: [{ name: "big", size_vram: 1 }] });
    const r = await probeOllamaResidency("http://10.0.0.5:11434", f, 1000, () => false);
    expect(r.state).toBe("absent");
    expect(f.calls).toEqual([]);
    expect((await probeOllamaResidency("http://[2001:db8::5]:11434", f, 1000, () => false)).state).toBe("absent");
  });

  it("probes an Ollama at one of this machine's own LAN addresses: it shares the pool", async () => {
    const f = answering({ models: [{ model: "qwen3:32b", size_vram: 2e10 }] });
    const own = (h: string) => h === "192.168.1.20";
    expect(await probeOllamaResidency("http://192.168.1.20:11434", f, 1000, own)).toMatchObject({ state: "resident", models: ["qwen3:32b"] });
    expect(f.calls).toEqual(["http://192.168.1.20:11434/api/ps"]);
  });

  it("calls an Ollama host name unknown, naming OLLAMA_HOST: it isn't resolved and may be this machine", async () => {
    const f = answering({ models: [] });
    const r = await probeOllamaResidency("http://studio.local:11434", f, 1000, () => false);
    expect(r).toMatchObject({ state: "unknown" });
    expect(r.state === "unknown" ? r.reason : "").toMatch(/OLLAMA_HOST.*studio\.local/);
    expect(f.calls).toEqual([]);
  });
});

describe("keepAliveToRestore", () => {
  const now = new Date("2026-11-15T12:00:00.000Z");

  it("falls back to Ollama's default of five minutes without a readable expiry", () => {
    expect(keepAliveToRestore(undefined, now)).toBe("5m");
    expect(keepAliveToRestore("soon", now)).toBe("5m");
  });

  it("keeps a model Ollama holds forever (keep_alive -1, reported as a date in 2318) forever", () => {
    expect(keepAliveToRestore("2318-02-23T22:47:16.854775807Z", now)).toBe("-1m");
  });

  it("gives back the remaining whole seconds, at least 60", () => {
    expect(keepAliveToRestore("2026-11-15T12:10:00.900Z", now)).toBe("600s");
    expect(keepAliveToRestore("2026-11-15T12:00:30.000Z", now)).toBe("60s");
    expect(keepAliveToRestore("2026-11-15T11:59:00.000Z", now)).toBe("60s");
  });
});

describe("ResourceCoordinator", () => {
  let dir: string;
  let store: ArchitectStore;
  let run: RunRecord;
  const now = () => new Date(T);
  const pool = memoryPool(BASE_URL);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "architect-resources-"));
    store = ArchitectStore.open(dir, { now });
    run = seedRun(store);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A store whose run was approved with a release of these models. */
  function reseed(release: ReturnType<typeof releaseOf>): RunRecord {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "architect-resources-"));
    store = ArchitectStore.open(dir, { now });
    return (run = seedRun(store, { release }));
  }

  function coordinator(opts: {
    fetchImpl?: FetchLike;
    ollama?: FakeOllama;
    manageResidency?: boolean;
    ownerId?: string;
    ollamaHost?: string;
    ownHosts?: string[];
  }) {
    const ollama = opts.ollama ?? new FakeOllama();
    const c = new ResourceCoordinator({
      store,
      upstream: {
        ...ollama.facade(opts.ollamaHost ?? OLLAMA),
        isOwnHostAddress: (h) => (opts.ownHosts ?? []).includes(h),
      },
      ownerId: opts.ownerId ?? "instance-a",
      now,
      manageResidency: opts.manageResidency ?? false,
      fetchImpl: opts.fetchImpl ?? ollama.fetch,
      probeTimeoutMs: 20,
    });
    return { c, ollama };
  }

  /** The run as the controller leaves it after an acquisition that unloaded models. */
  function validating(models: { name: string; keepAlive: string }[]): RunRecord {
    return store.transitionRun({
      runId: run.id,
      from: "PREPARING",
      to: "VALIDATING",
      principal: "controller",
      reason: "leased",
      data: { pool, unloadedOllamaModels: models, ollamaHost: OLLAMA },
      at: now(),
    }).run;
  }

  const notes = () => store.listRunEvents(run.id).filter((e) => e.kind === "note");

  it("leases the pool when no Ollama is there, and releases only its own run's lease", async () => {
    const { c } = coordinator({ fetchImpl: refused });
    const r = await c.acquire(run);
    expect(r).toMatchObject({ ok: true, lease: { pool, ownerId: "instance-a", runId: run.id } });
    expect(c.release(RunRecord.parse({ ...run, id: "run-2" }))).toBe(false);
    expect(store.getLease(pool)).toBeDefined();
    expect(c.release(run)).toBe(true);
    expect(store.getLease(pool)).toBeUndefined();
  });

  it("is busy, with a retry, while another instance holds the pool", async () => {
    store.acquireLease({ pool, ownerId: "instance-b", now: now(), ttlMs: 60_000 });
    const { c } = coordinator({ fetchImpl: refused });
    expect(await c.acquire(run)).toMatchObject({ ok: false, code: "RESOURCE_BUSY", retry: true });
    expect(store.getLease(pool)?.ownerId).toBe("instance-b");
  });

  it("blocks on a resident model without permission, naming it and the variable, sends nothing and gives the lease back", async () => {
    reseed(releaseOf(["qwen3:32b"]));
    const { c, ollama } = coordinator({ ollama: new FakeOllama().hold("qwen3:32b") });
    const r = await c.acquire(run);
    expect(r).toMatchObject({ ok: false, code: "RESOURCE_BUSY", retry: true });
    expect(!r.ok && r.reason).toMatch(/qwen3:32b.*ARCHITECT_MANAGE_RESIDENCY=1 and prepare the run again/);
    expect(ollama.posts).toEqual([]);
    expect(ollama.models.has("qwen3:32b")).toBe(true);
    expect(store.getLease(pool)).toBeUndefined();
  });

  it("blocks with permission but without an approved release: the approval must list the models", async () => {
    const { c, ollama } = coordinator({ ollama: new FakeOllama().hold("qwen3:32b"), manageResidency: true });
    const r = await c.acquire(run);
    expect(r).toMatchObject({ ok: false, code: "RESOURCE_BUSY", retry: true });
    expect(!r.ok && r.reason).toMatch(/prepare the run again so the approval lists them/);
    expect(ollama.posts).toEqual([]);
    expect(store.getLease(pool)).toBeUndefined();
  });

  it("unloads nothing when Ollama holds a model the approval doesn't list", async () => {
    reseed(releaseOf(["A"]));
    const { c, ollama } = coordinator({ ollama: new FakeOllama().hold("A").hold("B"), manageResidency: true });
    const r = await c.acquire(run);
    expect(r).toMatchObject({ ok: false, code: "RESOURCE_BUSY", retry: true });
    expect(!r.ok && r.reason).toMatch(/^B was loaded after the approval; unload it or prepare the run again/);
    expect(ollama.posts).toEqual([]);
    expect([...ollama.models.keys()]).toEqual(["A", "B"]);
    expect(store.getLease(pool)).toBeUndefined();
  });

  it("unloads nothing when the approval names another Ollama host than the current one", async () => {
    reseed(releaseOf(["A"], "http://127.0.0.1:11500"));
    const { c, ollama } = coordinator({ ollama: new FakeOllama().hold("A"), manageResidency: true });
    const r = await c.acquire(run);
    expect(r).toMatchObject({ ok: false, code: "RESOURCE_BUSY", retry: true });
    expect(!r.ok && r.reason).toMatch(/127\.0\.0\.1:11500.*prepare the run again/);
    expect(ollama.posts).toEqual([]);
  });

  it("matches the approved host after normalisation", async () => {
    reseed(releaseOf(["A"], "http://127.0.0.1:11434/"));
    const { c } = coordinator({ ollama: new FakeOllama().hold("A"), manageResidency: true });
    expect(await c.acquire(run)).toMatchObject({ ok: true });
  });

  it("unloads each approved model by itself, keeps its keep-alive, and proceeds once the re-probe shows it gone", async () => {
    reseed(releaseOf(["A", "B"]));
    const ollama = new FakeOllama().hold("A", "2026-11-15T12:10:00.000Z").hold("B");
    const { c } = coordinator({ ollama, manageResidency: true });
    expect(await c.acquire(run)).toMatchObject({
      ok: true,
      unloaded: [
        { name: "A", keepAlive: "600s" },
        { name: "B", keepAlive: "5m" },
      ],
      ollamaHost: OLLAMA,
    });
    expect(ollama.posts).toEqual([
      { url: `${OLLAMA}/api/generate`, body: { model: "A", keep_alive: 0 } },
      { url: `${OLLAMA}/api/generate`, body: { model: "B", keep_alive: 0 } },
    ]);
    expect(ollama.models.size).toBe(0);
    expect(ollama.loads).toEqual([]);
  });

  it("stays busy when a model is still resident after the unload, and loads back the ones that went", async () => {
    reseed(releaseOf(["A", "B"]));
    const ollama = new FakeOllama().hold("A").hold("B");
    ollama.sticky.add("B");
    const { c } = coordinator({ ollama, manageResidency: true });
    const r = await c.acquire(run);
    expect(r).toMatchObject({ ok: false, code: "RESOURCE_BUSY", retry: true });
    expect(!r.ok && r.reason).toMatch(/still holds B.*loaded A back/);
    expect(ollama.loads).toEqual([{ host: OLLAMA, model: "A", keepAlive: "5m" }]);
    expect(store.getLease(pool)).toBeUndefined();
  });

  it("fails without a retry when the unload can't be verified, and loads the models back", async () => {
    reseed(releaseOf(["A"]));
    const ollama = new FakeOllama().hold("A");
    ollama.psAnswers = 1;
    const { c } = coordinator({ ollama, manageResidency: true });
    const r = await c.acquire(run);
    expect(r).toMatchObject({ ok: false, code: "RESOURCE_ESTIMATE_UNKNOWN", retry: false });
    expect(!r.ok && r.reason).toMatch(/can't verify it.*couldn't verify that A is loaded back/);
    expect(ollama.loads.map((l) => l.model)).toEqual(["A"]);
    expect(store.getLease(pool)).toBeUndefined();
  });

  it("blocks without a retry when Ollama's residency is unknown", async () => {
    const { c } = coordinator({ fetchImpl: hanging });
    expect(await c.acquire(run)).toMatchObject({ ok: false, code: "RESOURCE_ESTIMATE_UNKNOWN", retry: false });
    expect(store.getLease(pool)).toBeUndefined();
  });

  it("blocks a loopback target's render while an Ollama at this machine's LAN address holds a model", async () => {
    const f = answering({ models: [{ model: "qwen3:32b", size_vram: 2e10 }] });
    const { c } = coordinator({ fetchImpl: f, ollamaHost: "http://192.168.1.20:11434", ownHosts: ["192.168.1.20"] });
    expect(await c.acquire(run)).toMatchObject({ ok: false, code: "RESOURCE_BUSY", retry: true });
    expect(store.getLease(pool)).toBeUndefined();
  });

  it("refuses a loopback target's render when OLLAMA_HOST is a name it can't place: a hard unknown", async () => {
    const f = answering({ models: [] });
    const { c } = coordinator({ fetchImpl: f, ollamaHost: "http://studio.local:11434" });
    const r = await c.acquire(run);
    expect(r).toMatchObject({ ok: false, code: "RESOURCE_ESTIMATE_UNKNOWN", retry: false });
    expect(r.ok ? "" : r.reason).toMatch(/OLLAMA_HOST/);
    expect(store.getLease(pool)).toBeUndefined();
  });

  it("doesn't probe Ollama for a remote target", async () => {
    const f = answering({ models: [{ model: "big", size_vram: 1 }] });
    const { c } = coordinator({ fetchImpl: f });
    // The same stored run pointed elsewhere: only the target decides whether Ollama is probed.
    const remote = RunRecord.parse({ ...run, target: { baseUrl: "http://10.0.0.7:8188" } });
    expect(await c.acquire(remote)).toMatchObject({ ok: true });
    expect(f.calls).toEqual([]);
  });

  it("heartbeats its lease, and takes an expired one back after a restart", async () => {
    const { c } = coordinator({ fetchImpl: refused });
    await c.acquire(run);
    expect(c.heartbeat(run)).toMatchObject({ held: true });
    // A new process has a new owner ID: the old lease is respected until it expires.
    const later = new ResourceCoordinator({
      store,
      upstream: new FakeOllama().facade(OLLAMA),
      ownerId: "instance-new",
      now: () => new Date(Date.parse(T) + 30_000),
      manageResidency: false,
      fetchImpl: refused,
    });
    expect(later.heartbeat(run)).toMatchObject({ held: false });
    const expired = new ResourceCoordinator({
      store,
      upstream: new FakeOllama().facade(OLLAMA),
      ownerId: "instance-new",
      now: () => new Date(Date.parse(T) + 61_000),
      manageResidency: false,
      fetchImpl: refused,
    });
    expect(expired.heartbeat(run)).toMatchObject({ held: true, lease: { ownerId: "instance-new" } });
  });

  describe("releasable", () => {
    it("lists every resident model with its size, at the normalised host, as an effect the schema accepts", async () => {
      const ollama = new FakeOllama().hold("A", undefined, 5_000_000_000).hold("B");
      const { c } = coordinator({ ollama, manageResidency: true, ollamaHost: "http://127.0.0.1:11434/" });
      const effect = await c.releasable(BASE_URL);
      expect(effect).toEqual({
        kind: "release_residency",
        host: OLLAMA,
        models: [
          { name: "A", sizeBytes: 5_000_000_000 },
          { name: "B", sizeBytes: 2e10 },
        ],
        reload: true,
      });
      expect(Effect.safeParse(effect).success).toBe(true);
    });

    it("lists nothing when residency isn't managed, without probing", async () => {
      const ollama = new FakeOllama().hold("A");
      let probes = 0;
      const counting: FetchLike = (url, init) => {
        probes += 1;
        return ollama.fetch(url, init);
      };
      const { c } = coordinator({ ollama, fetchImpl: counting });
      expect(await c.releasable(BASE_URL)).toBeUndefined();
      expect(probes).toBe(0);
    });

    it("lists nothing for a remote target, an idle or absent Ollama, or an unknown residency", async () => {
      const { c } = coordinator({ ollama: new FakeOllama().hold("A"), manageResidency: true });
      expect(await c.releasable("http://10.0.0.7:8188")).toBeUndefined();
      expect(await coordinator({ ollama: new FakeOllama(), manageResidency: true }).c.releasable(BASE_URL)).toBeUndefined();
      expect(await coordinator({ fetchImpl: refused, manageResidency: true }).c.releasable(BASE_URL)).toBeUndefined();
      expect(await coordinator({ fetchImpl: hanging, manageResidency: true }).c.releasable(BASE_URL)).toBeUndefined();
    });
  });

  describe("restore", () => {
    it("loads back what the run unloaded, with its keep-alive, writes one note, and adds nothing the second time", async () => {
      const ollama = new FakeOllama();
      const { c } = coordinator({ ollama, manageResidency: true });
      const r = validating([
        { name: "A", keepAlive: "600s" },
        { name: "B", keepAlive: "-1m" },
      ]);
      await c.restore(r);
      expect(ollama.loads).toEqual([
        { host: OLLAMA, model: "A", keepAlive: "600s" },
        { host: OLLAMA, model: "B", keepAlive: "-1m" },
      ]);
      expect(notes().map((e) => e.data)).toEqual([
        { residency: "restored", ollamaHost: OLLAMA, restored: ["A", "B"], failed: [], unverified: [] },
      ]);
      await c.restore(r);
      expect(ollama.loads).toHaveLength(2);
      expect(notes()).toHaveLength(1);
      expect(store.getRun(run.id)?.state).toBe("VALIDATING");
    });

    it("does nothing for a run that unloaded nothing", async () => {
      const ollama = new FakeOllama();
      const { c } = coordinator({ ollama });
      await c.restore(run);
      expect(ollama.loads).toEqual([]);
      expect(notes()).toEqual([]);
    });

    it("records a failed reload as failed, and leaves the run as it is", async () => {
      const ollama = new FakeOllama();
      ollama.loadFails.add("A");
      const { c } = coordinator({ ollama });
      await c.restore(validating([{ name: "A", keepAlive: "5m" }]));
      const [note] = notes();
      expect(note.data).toMatchObject({ residency: "restored", restored: [], unverified: [] });
      expect(note.data?.failed).toEqual([{ name: "A", reason: expect.stringMatching(/didn't confirm.*doesn't list it/) }]);
      expect(store.getRun(run.id)?.state).toBe("VALIDATING");
    });

    it("records a reload whose check fails as unverified, never as not loaded (#796)", async () => {
      const ollama = new FakeOllama();
      ollama.psAnswers = 0;
      const { c } = coordinator({ ollama });
      await c.restore(validating([{ name: "A", keepAlive: "5m" }]));
      const [note] = notes();
      expect(note.data).toMatchObject({ residency: "restored", restored: [], failed: [] });
      expect(note.data?.unverified).toEqual([{ name: "A", reason: expect.stringMatching(/accepted, and the check afterwards failed/) }]);
      expect(note.reason).toMatch(/whether A is loaded back is unverified/);
    });

    it("records a load request that throws, and still checks", async () => {
      const ollama = new FakeOllama();
      const throwing = new ResourceCoordinator({
        store,
        upstream: {
          ...ollama.facade(OLLAMA),
          loadOllama: async () => {
            throw new Error("socket hang up");
          },
        },
        ownerId: "instance-a",
        now,
        manageResidency: true,
        fetchImpl: ollama.fetch,
        probeTimeoutMs: 20,
      });
      await expect(throwing.restore(validating([{ name: "A", keepAlive: "5m" }]))).resolves.toBeUndefined();
      expect(notes()[0]?.data?.failed).toEqual([{ name: "A", reason: expect.stringMatching(/socket hang up/) }]);
    });
  });
});
