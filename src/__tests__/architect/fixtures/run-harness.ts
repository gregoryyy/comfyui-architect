// A store seeded up to one run in PREPARING, for the controller and resource tests
// (TODO 3.5, 3.6): planning records, an action plan whose effect names GRAPH's fingerprint,
// a granted request and the grant the run consumed.

import { graphFingerprint } from "../../../services/architect/compile.js";
import { type ApiGraph, type RunRecord, actionPlanHash } from "../../../services/architect/schemas.js";
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
}

/** Seed everything up to a run in PREPARING and return it. */
export function seedRun(store: ArchitectStore, opts: SeedOptions = {}): RunRecord {
  const budgets = { maxRuns: 1, maxWallTimeSeconds: opts.maxWallTimeSeconds ?? 600 };
  const effects = [{ kind: "local_render" as const, graphFingerprint: GRAPH_FINGERPRINT, outputNodes: ["2"] }];
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
