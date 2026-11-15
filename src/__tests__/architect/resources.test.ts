import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type FetchLike,
  ResourceCoordinator,
  memoryPool,
  probeOllamaResidency,
} from "../../services/architect/resources.js";
import { RunRecord } from "../../services/architect/schemas.js";
import { ArchitectStore } from "../../services/architect/store.js";
import { BASE_URL, T } from "./fixtures/execution-records.js";
import { seedRun } from "./fixtures/run-harness.js";

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
    expect(await probeOllamaResidency(OLLAMA, f, 1000)).toEqual({ state: "resident", models: ["llama3:8b"] });
    expect(f.calls).toEqual([`${OLLAMA}/api/ps`]);
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

  it("doesn't probe a remote Ollama: it doesn't share this machine's pool", async () => {
    const f = answering({ models: [{ name: "big", size_vram: 1 }] });
    const r = await probeOllamaResidency("http://10.0.0.5:11434", f, 1000);
    expect(r.state).toBe("absent");
    expect(f.calls).toEqual([]);
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

  function coordinator(opts: { fetchImpl: FetchLike; manageResidency?: boolean; ownerId?: string; unload?: () => void }) {
    const unloaded: string[] = [];
    const c = new ResourceCoordinator({
      store,
      upstream: {
        ollamaHost: () => OLLAMA,
        unloadOllama: async (host) => {
          unloaded.push(host);
          opts.unload?.();
          return [];
        },
      },
      ownerId: opts.ownerId ?? "instance-a",
      now,
      manageResidency: opts.manageResidency ?? false,
      fetchImpl: opts.fetchImpl,
      probeTimeoutMs: 20,
    });
    return { c, unloaded };
  }

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

  it("blocks on a resident model without permission, naming it and the variable, and gives the lease back", async () => {
    const { c, unloaded } = coordinator({ fetchImpl: answering({ models: [{ model: "qwen3:32b", size_vram: 2e10 }] }) });
    const r = await c.acquire(run);
    expect(r).toMatchObject({ ok: false, code: "RESOURCE_BUSY", retry: true });
    expect(!r.ok && r.reason).toMatch(/qwen3:32b.*ARCHITECT_MANAGE_RESIDENCY=1/);
    expect(unloaded).toEqual([]);
    expect(store.getLease(pool)).toBeUndefined();
  });

  it("unloads with permission and proceeds only when the re-probe shows it gone", async () => {
    let resident = true;
    const ps: FetchLike = async () =>
      new Response(JSON.stringify({ models: resident ? [{ model: "qwen3:32b", size_vram: 2e10 }] : [] }));
    const ok = coordinator({ fetchImpl: ps, manageResidency: true, unload: () => (resident = false) });
    expect(await ok.c.acquire(run)).toMatchObject({ ok: true, unloaded: ["qwen3:32b"] });
    expect(ok.unloaded).toEqual([OLLAMA]);
    ok.c.release(run);

    resident = true;
    const stuck = coordinator({ fetchImpl: ps, manageResidency: true });
    expect(await stuck.c.acquire(run)).toMatchObject({ ok: false, code: "RESOURCE_BUSY", retry: true });
    expect(store.getLease(pool)).toBeUndefined();
  });

  it("blocks without a retry when Ollama's residency is unknown", async () => {
    const { c } = coordinator({ fetchImpl: hanging });
    expect(await c.acquire(run)).toMatchObject({ ok: false, code: "RESOURCE_ESTIMATE_UNKNOWN", retry: false });
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
      upstream: { ollamaHost: () => OLLAMA, unloadOllama: async () => [] },
      ownerId: "instance-new",
      now: () => new Date(Date.parse(T) + 30_000),
      manageResidency: false,
      fetchImpl: refused,
    });
    expect(later.heartbeat(run)).toMatchObject({ held: false });
    const expired = new ResourceCoordinator({
      store,
      upstream: { ollamaHost: () => OLLAMA, unloadOllama: async () => [] },
      ownerId: "instance-new",
      now: () => new Date(Date.parse(T) + 61_000),
      manageResidency: false,
      fetchImpl: refused,
    });
    expect(expired.heartbeat(run)).toMatchObject({ held: true, lease: { ownerId: "instance-new" } });
  });
});
