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
//
// With ARCHITECT_MANAGE_RESIDENCY=1 the user can let a render free that memory (GAPS Q23):
// the action plan lists the resident models as a `release_residency` effect, so the
// approval names each one, and only those are unloaded before the render and loaded back
// after it. Since the demand is unknown, every model resident in the pool is listed.

import { isIP } from "node:net";
import type { ReleaseResidencyEffect, ResourceLease, RunEvent, RunRecord } from "./schemas.js";
import type { ArchitectStore } from "./store.js";
import type { UpstreamFacade } from "./upstream.js";
import { isLoopbackHostname } from "./validate.js";
import { z } from "zod";

/** The default lease time-to-live; the controller heartbeats well inside it. */
export const DEFAULT_LEASE_TTL_MS = 60_000;
/** How long a residency probe waits for Ollama's `/api/ps`. */
export const DEFAULT_RESIDENCY_PROBE_TIMEOUT_MS = 4_000;
/** How long an unload request waits; upstream's unload-all uses the same bound. */
export const DEFAULT_UNLOAD_TIMEOUT_MS = 15_000;

/** A URL without a trailing slash, a query or a default port, with scheme and host lowercased. */
function normaliseUrl(raw: string): string {
  const url = new URL(raw);
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * The memory pool a run uses: its target's normalised base URL. One pool per target in this
 * milestone; a target with several devices gets one pool per device when the resource
 * profiles of ROAD phase 2 can tell them apart.
 */
export function memoryPool(baseUrl: string): string {
  // A trailing slash or a query would otherwise make the same ComfyUI two pools.
  return normaliseUrl(baseUrl);
}

/** One model `/api/ps` lists with memory on the device. */
export interface ResidentModel {
  name: string;
  /** `size_vram`, in bytes. */
  sizeBytes: number;
  /** When Ollama will unload it by itself (`expires_at`), as Ollama wrote it. */
  expiresAt?: string;
}

/** What `/api/ps` said about the models a local Ollama holds in memory. */
export type OllamaResidency =
  /** No Ollama there, or one that can't share the target's pool; `reason` says which. */
  | { state: "absent"; reason: string }
  | { state: "resident"; models: string[]; detail: ResidentModel[] }
  | { state: "idle" }
  /** The probe failed: a timeout, an error status, a body that doesn't parse (#796). */
  | { state: "unknown"; reason: string };

/** The fetch the probe and the unload use; injected so tests need no Ollama. */
export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

const PsBody = z.object({
  models: z.array(
    z
      .object({
        name: z.string().optional(),
        model: z.string().optional(),
        size_vram: z.number().optional(),
        expires_at: z.string().optional(),
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

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
 * Which models an Ollama on this machine holds in memory, from `GET <host>/api/ps`.
 * Upstream's `loadedModels` reads the same endpoint but answers `[]` for every failure;
 * here a refused connection is the one failure that observes something (no Ollama), and
 * every other failure is `unknown` (#796). A model counts as resident when `size_vram` is
 * above zero; Ollama reports it on Apple unified memory too.
 *
 * The host is probed when it is loopback or, by `isOwnHost`, an address of this machine:
 * OLLAMA_HOST set to the machine's LAN address still shares its pool. An IP address that
 * isn't this machine's is another machine, so `absent` (spec §11.1). A host name is
 * `unknown`: it isn't resolved here, and it may name this machine.
 */
export async function probeOllamaResidency(
  host: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  isOwnHost: (hostname: string) => boolean = () => false,
): Promise<OllamaResidency> {
  const hostname = hostnameOf(host);
  if (hostname === undefined) return { state: "unknown", reason: `the Ollama host "${host}" is not a URL` };
  if (!isLoopbackHostname(hostname) && !isOwnHost(hostname)) {
    if (isIP(hostname.replace(/^\[|\]$/g, "")) !== 0) {
      return { state: "absent", reason: `Ollama at ${hostname} is another machine and doesn't share this machine's memory pool` };
    }
    return {
      state: "unknown",
      reason:
        `OLLAMA_HOST names ${hostname}, which isn't resolved here and may be this machine; ` +
        "set OLLAMA_HOST to a loopback or IP address so Architect can tell whether its models share the pool",
    };
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
    return { state: "unknown", reason: timedOut ? `${url} didn't answer within ${timeoutMs} ms` : `${url} failed: ${messageOf(err)}` };
  }
  const parsed = PsBody.safeParse(body);
  if (!parsed.success) return { state: "unknown", reason: `${url} returned a body that isn't Ollama's model list` };
  const detail: ResidentModel[] = parsed.data.models
    .filter((m) => (m.size_vram ?? 0) > 0)
    .map((m) => ({
      name: m.model || m.name || "(unnamed model)",
      sizeBytes: Math.round(m.size_vram ?? 0),
      ...(m.expires_at ? { expiresAt: m.expires_at } : {}),
    }));
  return detail.length > 0 ? { state: "resident", models: detail.map((m) => m.name), detail } : { state: "idle" };
}

const DAY_MS = 86_400_000;

/**
 * The `keep_alive` that loads a model back with the time it had left (GAPS Q23), from
 * `/api/ps`'s `expires_at` at the moment it was unloaded:
 * - missing or unparseable: "5m", Ollama's default keep-alive;
 * - more than a year ahead: kept forever. Ollama stores keep_alive -1 as the largest
 *   duration and reports a date in 2318. Its API parses a string keep_alive with Go's
 *   ParseDuration, which refuses a bare "-1", so the negative duration is "-1m";
 * - otherwise the remaining whole seconds, at least 60, so the model doesn't drop out
 *   again right after the reload.
 */
export function keepAliveToRestore(expiresAt: string | undefined, now: Date): string {
  const at = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
  if (Number.isNaN(at)) return "5m";
  const remaining = at - now.getTime();
  if (remaining > 365 * DAY_MS) return "-1m";
  return `${Math.max(60, Math.floor(remaining / 1000))}s`;
}

/** A model Architect unloaded for a run, with the keep-alive it gets back. */
export interface UnloadedModel {
  name: string;
  keepAlive: string;
}

/** What loading models back established, model by model. */
export interface ReloadResult {
  /** The check afterwards lists them as resident. */
  restored: string[];
  /** Not loaded: the check afterwards observed Ollama without them. */
  failed: { name: string; reason: string }[];
  /** The check afterwards failed, so whether they are loaded is unknown (#796). */
  unverified: { name: string; reason: string }[];
}

// What the controller records on a run's VALIDATING transition when the acquisition
// unloaded models; `restore` reads it back from there.
const UnloadRecord = z.object({
  ollamaHost: z.string().min(1),
  unloadedOllamaModels: z.array(z.object({ name: z.string().min(1), keepAlive: z.string().min(1) })).min(1),
});

/** The models a run's acquisition unloaded, from its VALIDATING transition. */
export function unloadedForRun(events: readonly RunEvent[]): { host: string; models: UnloadedModel[] } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== "transition" || e.to !== "VALIDATING") continue;
    const parsed = UnloadRecord.safeParse(e.data);
    if (parsed.success) return { host: parsed.data.ollamaHost, models: parsed.data.unloadedOllamaModels };
  }
  return undefined;
}

/** Whether the run's unloaded models were already loaded back (the note `restore` writes). */
export function residencyRestored(events: readonly RunEvent[]): boolean {
  return events.some((e) => e.kind === "note" && e.data?.residency === "restored");
}

/** The outcome of `ResourceCoordinator.acquire`. */
export type ResourceAcquisition =
  | {
      ok: true;
      lease: ResourceLease;
      /** The expired lease of another holder this acquisition replaced. */
      tookOverFrom?: ResourceLease;
      /** Models Architect unloaded first, as the run's approval listed them (GAPS Q23). */
      unloaded?: UnloadedModel[];
      /** The Ollama host they were unloaded from; set with `unloaded`. */
      ollamaHost?: string;
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
  upstream: Pick<UpstreamFacade, "ollamaHost" | "loadOllama" | "isOwnHostAddress">;
  /** This process's lease owner ID; leases of another owner are respected until they expire. */
  ownerId: string;
  now: () => Date;
  /**
   * Whether the user lets Architect unload a loopback Ollama's models for a render and load
   * them back after it (ARCHITECT_MANAGE_RESIDENCY=1). Each run's approval still names the
   * models; this only lets the action plan list them.
   */
  manageResidency: boolean;
  ttlMs?: number;
  fetchImpl?: FetchLike;
  probeTimeoutMs?: number;
  unloadTimeoutMs?: number;
}

/** Leases a run's memory pool and checks the pool's other consumers (spec §11.3, §11.4). */
export class ResourceCoordinator {
  private readonly ttlMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly probeTimeoutMs: number;
  private readonly unloadTimeoutMs: number;

  constructor(private readonly deps: ResourceCoordinatorDeps) {
    this.ttlMs = deps.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    this.fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
    this.probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_RESIDENCY_PROBE_TIMEOUT_MS;
    this.unloadTimeoutMs = deps.unloadTimeoutMs ?? DEFAULT_UNLOAD_TIMEOUT_MS;
  }

  /**
   * The `release_residency` effect an action plan for a render on `baseUrl` should list, so
   * the approval names every model that would be unloaded (GAPS Q23). Undefined unless
   * residency is managed, the target is loopback and Ollama holds models in the pool. An
   * unknown residency lists nothing; the acquisition blocks on it later.
   */
  async releasable(baseUrl: string): Promise<ReleaseResidencyEffect | undefined> {
    if (!this.deps.manageResidency) return undefined;
    const residency = await this.residency(baseUrl);
    if (residency.state !== "resident") return undefined;
    let host: string;
    try {
      host = normaliseUrl(this.deps.upstream.ollamaHost());
    } catch {
      // The probe read this host, so it is a URL; an approval can't name one that isn't.
      return undefined;
    }
    return {
      kind: "release_residency",
      host,
      models: residency.detail.map(({ name, sizeBytes }) => ({ name, sizeBytes })),
      reload: true,
    };
  }

  /**
   * Lease the run's pool, then check that no local Ollama model sits in it. A busy pool and
   * a resident model can clear, so they ask for a retry; an Ollama that can't be read is a
   * hard unknown and blocks the automatic run (spec §7.3). Resident models are unloaded only
   * when the run's approved action plan lists each of them for this Ollama host. Every
   * refusal releases the lease this call took, so a blocked run never holds the pool.
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
    const tookOver = taken.tookOverFrom ? { tookOverFrom: taken.tookOverFrom } : {};
    const refuse = (code: "RESOURCE_BUSY" | "RESOURCE_ESTIMATE_UNKNOWN", retry: boolean, reason: string): ResourceAcquisition => {
      this.release(run);
      return { ok: false, code, retry, reason };
    };

    const first = await this.residency(run.target.baseUrl);
    if (first.state === "unknown") {
      return refuse("RESOURCE_ESTIMATE_UNKNOWN", false, `whether a local Ollama model holds the pool is unknown: ${first.reason}`);
    }
    if (first.state !== "resident") return { ok: true, lease: taken.lease, ...tookOver };

    const names = first.models.join(", ");
    const approved = store.getActionPlan(run.actionPlanId)?.effects.find((e): e is ReleaseResidencyEffect => e.kind === "release_residency");
    if (!this.deps.manageResidency || !approved) {
      return refuse(
        "RESOURCE_BUSY",
        true,
        `Ollama holds ${names} in the memory pool the render needs; unload ${first.models.length === 1 ? "it" : "them"}, ` +
          "or set ARCHITECT_MANAGE_RESIDENCY=1 and prepare the run again so the approval lists them",
      );
    }
    const host = this.currentHost();
    if (host === undefined || normaliseUrl(approved.host) !== host) {
      return refuse(
        "RESOURCE_BUSY",
        true,
        `the approval lets Architect unload models from Ollama at ${approved.host}, but Ollama is now at ` +
          `${host ?? this.deps.upstream.ollamaHost()}; prepare the run again`,
      );
    }
    // Never unload a model the user didn't approve: one loaded since the approval blocks
    // the run, and nothing is unloaded for it.
    const listed = new Set(approved.models.map((m) => m.name));
    const extra = first.models.filter((n) => !listed.has(n));
    if (extra.length > 0) {
      return refuse(
        "RESOURCE_BUSY",
        true,
        `${extra.join(", ")} ${extra.length === 1 ? "was" : "were"} loaded after the approval; ` +
          `unload ${extra.length === 1 ? "it" : "them"} or prepare the run again`,
      );
    }

    // Whether another client is using a model can't be seen from /api/ps; the approval
    // covers that risk. The keep-alive each model had left is taken before the unload, so
    // the reload gives it back. The release is then verified, never assumed (spec §11.3).
    const at = now();
    const unloaded: UnloadedModel[] = first.detail.map((m) => ({ name: m.name, keepAlive: keepAliveToRestore(m.expiresAt, at) }));
    const errors: string[] = [];
    for (const m of unloaded) {
      try {
        await this.unloadModel(host, m.name);
      } catch (err) {
        errors.push(`${m.name}: ${messageOf(err)}`);
      }
    }
    const unloadError = errors.length > 0 ? `; the unload request failed for ${errors.join("; ")}` : "";
    const after = await this.residency(run.target.baseUrl);
    if (after.state === "unknown") {
      // Whether they went is unknown; loading back what may still be loaded is harmless.
      const back = await this.reload(host, unloaded);
      return refuse(
        "RESOURCE_ESTIMATE_UNKNOWN",
        false,
        `Architect asked Ollama to unload ${names}, but can't verify it: ${after.reason}${unloadError}${reloadSummary(back)}`,
      );
    }
    if (after.state === "resident") {
      // A refused acquisition leaves Ollama as it found it: what did go is loaded back.
      const gone = unloaded.filter((m) => !after.models.includes(m.name));
      const back = gone.length > 0 ? await this.reload(host, gone) : undefined;
      return refuse(
        "RESOURCE_BUSY",
        true,
        `Ollama still holds ${after.models.join(", ")} after Architect asked it to unload them${unloadError}${back ? reloadSummary(back) : ""}`,
      );
    }
    return { ok: true, lease: taken.lease, unloaded, ollamaHost: host, ...tookOver };
  }

  /**
   * Load back the models a run's acquisition unloaded, once its render is over, and record
   * what happened in one `note` event (`data.residency: "restored"`). Does nothing when the
   * run unloaded nothing or the note exists; a second reload would be harmless, so the note
   * is the only guard. A failed reload is recorded and doesn't change the run's state or
   * acceptance. Loads and probes don't throw; a store failure rejects, and since no note was
   * written the next call tries again.
   */
  async restore(run: RunRecord): Promise<void> {
    const { store, now } = this.deps;
    const events = store.listRunEvents(run.id);
    if (residencyRestored(events)) return;
    const record = unloadedForRun(events);
    if (!record) return;
    const result = await this.reload(record.host, record.models);
    const parts = [
      result.restored.length > 0 ? `loaded ${result.restored.join(", ")} back into Ollama` : "",
      ...result.failed.map((f) => `${f.name} isn't loaded back: ${f.reason}`),
      ...result.unverified.map((f) => `whether ${f.name} is loaded back is unverified: ${f.reason}`),
    ].filter((p) => p !== "");
    store.appendRunEvent({
      runId: run.id,
      kind: "note",
      principal: "controller",
      reason: `after the render, ${parts.join("; ")}`,
      data: { residency: "restored", ollamaHost: record.host, ...result },
      at: now(),
    });
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

  /**
   * Ollama's residency, probed only when the target is loopback and the Ollama host is
   * this machine (see `probeOllamaResidency`).
   */
  private async residency(targetBaseUrl: string): Promise<OllamaResidency> {
    const target = hostnameOf(targetBaseUrl);
    if (target === undefined || !isLoopbackHostname(target)) {
      // A remote ComfyUI renders on another machine's memory (spec §11.1).
      return { state: "absent", reason: `the target ${target ?? targetBaseUrl} is remote; a local Ollama doesn't share its pool` };
    }
    const upstream = this.deps.upstream;
    return probeOllamaResidency(upstream.ollamaHost(), this.fetchImpl, this.probeTimeoutMs, (h) => upstream.isOwnHostAddress(h));
  }

  private currentHost(): string | undefined {
    try {
      return normaliseUrl(this.deps.upstream.ollamaHost());
    } catch {
      return undefined;
    }
  }

  /**
   * Unload one model. Upstream's unload-all would also unload models the approval doesn't
   * list, so the request is sent here: a generate request with keep_alive 0 and no prompt.
   */
  private async unloadModel(host: string, model: string): Promise<void> {
    const res = await this.fetchImpl(`${host}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(this.unloadTimeoutMs),
    });
    if (!res.ok) throw new Error(`Ollama answered HTTP ${res.status}`);
  }

  /** Load models back with their keep-alive, then check once which of them Ollama holds. */
  private async reload(host: string, models: readonly UnloadedModel[]): Promise<ReloadResult> {
    const requestErrors = new Map<string, string>();
    for (const m of models) {
      try {
        if (!(await this.deps.upstream.loadOllama(host, m.name, m.keepAlive))) {
          requestErrors.set(m.name, "Ollama didn't confirm the load request");
        }
      } catch (err) {
        requestErrors.set(m.name, `the load request failed: ${messageOf(err)}`);
      }
    }
    const after = await probeOllamaResidency(host, this.fetchImpl, this.probeTimeoutMs, (h) => this.deps.upstream.isOwnHostAddress(h));
    const result: ReloadResult = { restored: [], failed: [], unverified: [] };
    for (const m of models) {
      const requestError = requestErrors.get(m.name);
      if (after.state === "resident" && after.models.includes(m.name)) {
        result.restored.push(m.name);
      } else if (after.state === "unknown") {
        // #796: a check that failed says nothing about whether the model is loaded.
        const request = requestError ?? "the load request was accepted";
        result.unverified.push({ name: m.name, reason: `${request}, and the check afterwards failed: ${after.reason}` });
      } else {
        const seen = after.state === "absent" ? after.reason : "Ollama doesn't list it afterwards";
        result.failed.push({ name: m.name, reason: requestError ? `${requestError}; ${seen}` : seen });
      }
    }
    return result;
  }
}

/** The tail of a refusal reason that says what loading back established. */
function reloadSummary(r: ReloadResult): string {
  const parts = [
    r.restored.length > 0 ? `loaded ${r.restored.join(", ")} back` : "",
    r.failed.length > 0 ? `couldn't load ${r.failed.map((f) => f.name).join(", ")} back` : "",
    r.unverified.length > 0 ? `couldn't verify that ${r.unverified.map((f) => f.name).join(", ")} ${r.unverified.length === 1 ? "is" : "are"} loaded back` : "",
  ].filter((p) => p !== "");
  return parts.length > 0 ? `; ${parts.join(", ")}` : "";
}
