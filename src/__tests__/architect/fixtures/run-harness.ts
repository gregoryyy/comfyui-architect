// A store seeded up to one run in PREPARING, for the controller and resource tests
// (TODO 3.5, 3.6): planning records, an action plan whose effect names GRAPH's fingerprint,
// a granted request and the grant the run consumed. Also a fake Ollama for the residency
// tests (GAPS Q23).

import { graphFingerprint } from "../../../services/architect/compile.js";
import type { FetchLike } from "../../../services/architect/resources.js";
import {
  type AcquireModelsEffect,
  type ApiGraph,
  type ReleaseResidencyEffect,
  type RunRecord,
  actionPlanHash,
} from "../../../services/architect/schemas.js";
import type { UpstreamFacade } from "../../../services/architect/upstream.js";
import type { ArchitectStore } from "../../../services/architect/store.js";
import { actionPlan, approvalRequest, candidate, env, grant, plan, run, task } from "./execution-records.js";

/** A graph whose output node "2" writes the images. */
export const GRAPH: ApiGraph = {
  "1": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "architect" } },
};
export const GRAPH_FINGERPRINT = graphFingerprint(GRAPH);

/** The moment the run is created, one minute after its `createdAt`. */
export const RUN_CREATED = new Date("2026-11-15T12:02:00.000Z");

export interface SeedOptions {
  /** Extra TaskSpec fields, such as `acceptance`. */
  task?: Record<string, unknown>;
  maxWallTimeSeconds?: number;
  /** A `release_residency` effect the user approved with the render. */
  release?: ReleaseResidencyEffect;
  /** An `acquire_models` effect the user approved before the render (TODO 4.5). */
  acquire?: AcquireModelsEffect;
}

/** Seed everything up to a run in PREPARING and return it. */
export function seedRun(store: ArchitectStore, opts: SeedOptions = {}): RunRecord {
  const budgets = { maxRuns: 1, maxWallTimeSeconds: opts.maxWallTimeSeconds ?? 600 };
  const effects = [
    ...(opts.acquire ? [opts.acquire] : []),
    { kind: "local_render" as const, graphFingerprint: GRAPH_FINGERPRINT, outputNodes: ["2"] },
    ...(opts.release ? [opts.release] : []),
  ];
  const binding = {
    planId: actionPlan.planId,
    taskId: actionPlan.taskId,
    taskRevision: actionPlan.taskRevision,
    candidateId: actionPlan.candidateId,
    target: actionPlan.target,
    effects,
    budgets,
  };
  const hash = actionPlanHash(binding);
  store.putTaskRevision({ ...task, ...opts.task });
  store.putSnapshot(env);
  store.putPlan(plan);
  store.putCandidate({ ...candidate, graphFingerprint: GRAPH_FINGERPRINT, roleMap: { image: "2" } });
  store.putActionPlan({ ...actionPlan, effects, budgets, hash });
  store.putApprovalRequest({ ...approvalRequest, actionPlanHash: hash });
  store.resolveApprovalRequest(approvalRequest.id, "granted", new Date("2026-11-15T12:01:00.000Z"));
  store.putGrant({ ...grant, actionPlanHash: hash, limits: budgets });
  return store.createRunWithGrant({ run: { ...run, graphFingerprint: GRAPH_FINGERPRINT }, grantId: grant.id, now: RUN_CREATED }).run;
}

/** The loopback Ollama host the fakes answer for. */
export const OLLAMA_HOST = "http://127.0.0.1:11434";

/** A `release_residency` effect for these models at OLLAMA_HOST. */
export function releaseOf(names: string[], host = OLLAMA_HOST): ReleaseResidencyEffect {
  return { kind: "release_residency", host, models: names.map((name) => ({ name, sizeBytes: 2e10 })), reload: true };
}

/**
 * Ollama as `/api/ps` and `/api/generate` show it: a POST with keep_alive 0 unloads the
 * model, unless it is `sticky` (a client keeps using it). Loads come through the facade's
 * `loadOllama`, as upstream's warm-up request would send them.
 */
export class FakeOllama {
  models = new Map<string, { sizeBytes: number; expiresAt?: string }>();
  /** Every POST to /api/generate, with its parsed body. */
  posts: { url: string; body: unknown }[] = [];
  loads: { host: string; model: string; keepAlive: string }[] = [];
  sticky = new Set<string>();
  /** Probes /api/ps answers before it hangs until the timeout: an unknown residency. */
  psAnswers = Number.POSITIVE_INFINITY;
  /** The load request answers false and nothing loads. */
  loadFails = new Set<string>();
  private probes = 0;

  hold(name: string, expiresAt?: string, sizeBytes = 2e10): this {
    this.models.set(name, { sizeBytes, ...(expiresAt ? { expiresAt } : {}) });
    return this;
  }

  readonly fetch: FetchLike = async (url, init) => {
    if (url.endsWith("/api/ps")) {
      this.probes += 1;
      if (this.probes > this.psAnswers) {
        return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
      }
      const models = [...this.models].map(([name, m]) => ({ name, model: name, size_vram: m.sizeBytes, ...(m.expiresAt ? { expires_at: m.expiresAt } : {}) }));
      return new Response(JSON.stringify({ models }));
    }
    if (url.endsWith("/api/generate") && init.method === "POST") {
      const body: unknown = JSON.parse(init.body ?? "null");
      this.posts.push({ url, body });
      if (typeof body === "object" && body !== null && "model" in body && "keep_alive" in body && body.keep_alive === 0) {
        const model = String(body.model);
        if (!this.sticky.has(model)) this.models.delete(model);
      }
      return new Response(JSON.stringify({ done: true }));
    }
    return new Response("not found", { status: 404 });
  };

  /** The facade methods the resource coordinator uses. */
  facade(host = OLLAMA_HOST): Pick<UpstreamFacade, "ollamaHost" | "loadOllama" | "isOwnHostAddress"> {
    return {
      ollamaHost: () => host,
      loadOllama: async (h, model, keepAlive) => {
        this.loads.push({ host: h, model, keepAlive });
        if (this.loadFails.has(model)) return false;
        this.hold(model);
        return true;
      },
      isOwnHostAddress: () => false,
    };
  }
}
