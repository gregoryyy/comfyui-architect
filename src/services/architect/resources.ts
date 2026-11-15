// Resource coordination for Architect's renders (spec §11.3, §11.4; TODO 3.6, AT-10).
//
// One lease per memory pool, held in `resource_leases`, so two Architect processes (the
// stdio server and the panel agent's server, say) never start two renders on the same
// pool. A lease coordinates Architect instances only; it can't keep an unrelated
// application from using memory (spec §11.4).
//
// No memory arithmetic happens in this milestone. Resource estimates are `unknown` (no
// measured profile exists yet), so the first run of a candidate is the bounded probe its
// grant names, limited by the grant's wall time. With nothing added up, unified memory
// can't be counted twice either (spec §11.1): the pool is the target, and the only other
// consumer checked is a local Ollama whose resident models block the render.

import type { ResourceLease, RunRecord } from "./schemas.js";
import type { ArchitectStore } from "./store.js";
import type { UpstreamFacade } from "./upstream.js";
import { isLoopbackHostname } from "./validate.js";
import { z } from "zod";

/** The default lease time-to-live; the controller heartbeats well inside it. */
export const DEFAULT_LEASE_TTL_MS = 60_000;
/** How long a residency probe waits for Ollama's `/api/ps`. */
export const DEFAULT_RESIDENCY_PROBE_TIMEOUT_MS = 4_000;

/**
 * The memory pool a run uses: its target's normalised base URL. One pool per target in this
 * milestone; a target with several devices gets one pool per device when the resource
 * profiles of ROAD phase 2 can tell them apart.
 */
export function memoryPool(baseUrl: string): string {
  const url = new URL(baseUrl);
  // URL lowercases scheme and host and drops a default port; a trailing slash or a query
  // would otherwise make the same ComfyUI two pools.
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

/** What `/api/ps` said about the models a local Ollama holds in memory. */
export type OllamaResidency =
  /** No Ollama there, or one that can't share the target's pool; `reason` says which. */
  | { state: "absent"; reason: string }
  | { state: "resident"; models: string[] }
  | { state: "idle" }
  /** The probe failed: a timeout, an error status, a body that doesn't parse (#796). */
  | { state: "unknown"; reason: string };

/** The fetch the probe uses; injected so tests need no Ollama. */
export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

const PsBody = z.object({
  models: z.array(
    z
      .object({
        name: z.string().optional(),
        model: z.string().optional(),
        size_vram: z.number().optional(),
      })
      .passthrough(),
  ),
});

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** Whether an error is a refused TCP connection, which proves nothing listens there. */
function connectionRefused(err: unknown): boolean {
  const codes: unknown[] = [];
  const collect = (e: unknown, depth: number) => {
    if (depth > 3 || e === null || typeof e !== "object") return;
    if ("code" in e) codes.push(e.code);
    if ("cause" in e) collect(e.cause, depth + 1);
    // Node tries every address of `localhost` (::1 and 127.0.0.1) and reports an
    // AggregateError when all of them refuse.
    if (e instanceof AggregateError) for (const inner of e.errors) collect(inner, depth + 1);
  };
  collect(err, 0);
  return codes.length > 0 && codes.every((c) => c === "ECONNREFUSED");
}

/**
 * Which models a loopback Ollama holds in memory, from `GET <host>/api/ps`. Upstream's
 * `loadedModels` reads the same endpoint but answers `[]` for every failure; here a refused
 * connection is the one failure that observes something (no Ollama), and every other
 * failure is `unknown` (#796). A model counts as resident when `size_vram` is above zero;
 * Ollama reports it on Apple unified memory too. A non-loopback host is `absent`: a remote
 * Ollama doesn't share this machine's pool (spec §11.1).
 */
export async function probeOllamaResidency(host: string, fetchImpl: FetchLike, timeoutMs: number): Promise<OllamaResidency> {
  const hostname = hostnameOf(host);
  if (hostname === undefined) return { state: "unknown", reason: `the Ollama host "${host}" is not a URL` };
  if (!isLoopbackHostname(hostname)) {
    return { state: "absent", reason: `Ollama at ${hostname} is remote and doesn't share this machine's memory pool` };
  }
  const url = `${host.replace(/\/+$/, "")}/api/ps`;
  let body: unknown;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { state: "unknown", reason: `${url} answered HTTP ${res.status}` };
    body = await res.json();
  } catch (err) {
    if (connectionRefused(err)) return { state: "absent", reason: `nothing listens at ${host} (connection refused)` };
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    const message = err instanceof Error ? err.message : String(err);
    return { state: "unknown", reason: timedOut ? `${url} didn't answer within ${timeoutMs} ms` : `${url} failed: ${message}` };
  }
  const parsed = PsBody.safeParse(body);
  if (!parsed.success) return { state: "unknown", reason: `${url} returned a body that isn't Ollama's model list` };
  const models = parsed.data.models
    .filter((m) => (m.size_vram ?? 0) > 0)
    .map((m) => m.model || m.name || "(unnamed model)");
  return models.length > 0 ? { state: "resident", models } : { state: "idle" };
}

/** The outcome of `ResourceCoordinator.acquire`. */
export type ResourceAcquisition =
  | {
      ok: true;
      lease: ResourceLease;
      /** The expired lease of another holder this acquisition replaced. */
      tookOverFrom?: ResourceLease;
      /** Models Architect unloaded first, with the user's permission (ARCHITECT_MANAGE_RESIDENCY). */
      unloaded?: string[];
    }
  | {
      ok: false;
      reason: string;
      /** Whether the same run may try again later: the pool frees up, or the user unloads a model. */
      retry: boolean;
      code: "RESOURCE_BUSY" | "RESOURCE_ESTIMATE_UNKNOWN";
    };

/** Whether this instance still holds a run's lease after a heartbeat. */
export type LeaseHeartbeat = { held: true; lease: ResourceLease } | { held: false; reason: string };

export interface ResourceCoordinatorDeps {
  store: ArchitectStore;
  upstream: Pick<UpstreamFacade, "ollamaHost" | "unloadOllama">;
  /** This process's lease owner ID; leases of another owner are respected until they expire. */
  ownerId: string;
  now: () => Date;
  /** Whether the user lets Architect unload a loopback Ollama's models (ARCHITECT_MANAGE_RESIDENCY=1). */
  manageResidency: boolean;
  ttlMs?: number;
  fetchImpl?: FetchLike;
  probeTimeoutMs?: number;
}

/** Leases a run's memory pool and checks the pool's other consumers (spec §11.3, §11.4). */
export class ResourceCoordinator {
  private readonly ttlMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly probeTimeoutMs: number;

  constructor(private readonly deps: ResourceCoordinatorDeps) {
    this.ttlMs = deps.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    this.fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
    this.probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_RESIDENCY_PROBE_TIMEOUT_MS;
  }

  /**
   * Lease the run's pool, then check that no local Ollama model sits in it. A busy pool and
   * a resident model can clear, so they ask for a retry; an Ollama that can't be read is a
   * hard unknown and blocks the automatic run (spec §7.3). Every refusal releases the lease
   * this call took, so a blocked run never holds the pool.
   */
  async acquire(run: RunRecord): Promise<ResourceAcquisition> {
    const { store, ownerId, now } = this.deps;
    const pool = memoryPool(run.target.baseUrl);
    const taken = store.acquireLease({ pool, ownerId, runId: run.id, now: now(), ttlMs: this.ttlMs });
    if (!taken.acquired) {
      const h = taken.holder;
      return {
        ok: false,
        code: "RESOURCE_BUSY",
        retry: true,
        reason: `the memory pool ${pool} is leased by ${h.ownerId}${h.runId ? ` for ${h.runId}` : ""} until ${h.expiresAt}`,
      };
    }
    const refuse = (code: "RESOURCE_BUSY" | "RESOURCE_ESTIMATE_UNKNOWN", retry: boolean, reason: string): ResourceAcquisition => {
      this.release(run);
      return { ok: false, code, retry, reason };
    };

    const first = await this.residency(run.target.baseUrl);
    if (first.state === "unknown") {
      return refuse("RESOURCE_ESTIMATE_UNKNOWN", false, `whether a local Ollama model holds the pool is unknown: ${first.reason}`);
    }
    if (first.state !== "resident") return { ok: true, lease: taken.lease, ...(taken.tookOverFrom ? { tookOverFrom: taken.tookOverFrom } : {}) };

    const names = first.models.join(", ");
    if (!this.deps.manageResidency) {
      return refuse(
        "RESOURCE_BUSY",
        true,
        `Ollama holds ${names} in the memory pool the render needs; unload ${first.models.length === 1 ? "it" : "them"}, ` +
          "or set ARCHITECT_MANAGE_RESIDENCY=1 to let Architect unload them before a render",
      );
    }
    // The user allowed Architect to manage this residency (spec §11.3 step 3). Whether
    // another client is using the model can't be seen from /api/ps; the permission covers
    // that risk. The release is then verified, never assumed (step 4).
    const host = this.deps.upstream.ollamaHost();
    let unloadError = "";
    try {
      await this.deps.upstream.unloadOllama(host);
    } catch (err) {
      unloadError = `; the unload request failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    const after = await this.residency(run.target.baseUrl);
    if (after.state === "unknown") {
      return refuse("RESOURCE_ESTIMATE_UNKNOWN", false, `Architect asked Ollama to unload ${names}, but can't verify it: ${after.reason}${unloadError}`);
    }
    if (after.state === "resident") {
      return refuse("RESOURCE_BUSY", true, `Ollama still holds ${after.models.join(", ")} after Architect asked it to unload them${unloadError}`);
    }
    return {
      ok: true,
      lease: taken.lease,
      unloaded: first.models,
      ...(taken.tookOverFrom ? { tookOverFrom: taken.tookOverFrom } : {}),
    };
  }

  /**
   * Extend the run's lease. When the lease lapsed and another holder took it, or this is a
   * new process whose predecessor held it, the pool is taken again if it is free or expired;
   * otherwise the result says who holds it.
   */
  heartbeat(run: RunRecord): LeaseHeartbeat {
    const { store, ownerId, now } = this.deps;
    const pool = memoryPool(run.target.baseUrl);
    const current = store.getLease(pool);
    if (current && current.ownerId === ownerId && current.runId === run.id) {
      return { held: true, lease: store.heartbeatLease({ pool, ownerId, now: now(), ttlMs: this.ttlMs }) };
    }
    const taken = store.acquireLease({ pool, ownerId, runId: run.id, now: now(), ttlMs: this.ttlMs });
    if (taken.acquired) return { held: true, lease: taken.lease };
    return { held: false, reason: `the memory pool ${pool} is leased by ${taken.holder.ownerId} until ${taken.holder.expiresAt}` };
  }

  /**
   * Release the run's lease. The store releases by owner, so the run is checked first: this
   * owner's lease for another run stays. Both calls are synchronous on one connection, so
   * nothing in this process runs between them, and another process has another owner ID.
   */
  release(run: RunRecord): boolean {
    const { store, ownerId } = this.deps;
    const pool = memoryPool(run.target.baseUrl);
    const current = store.getLease(pool);
    if (!current || current.ownerId !== ownerId || current.runId !== run.id) return false;
    return store.releaseLease({ pool, ownerId });
  }

  /** Ollama's residency, probed only when both the target and the Ollama host are loopback. */
  private async residency(targetBaseUrl: string): Promise<OllamaResidency> {
    const target = hostnameOf(targetBaseUrl);
    if (target === undefined || !isLoopbackHostname(target)) {
      // A remote ComfyUI renders on another machine's memory (spec §11.1).
      return { state: "absent", reason: `the target ${target ?? targetBaseUrl} is remote; a local Ollama doesn't share its pool` };
    }
    return probeOllamaResidency(this.deps.upstream.ollamaHost(), this.fetchImpl, this.probeTimeoutMs);
  }
}
