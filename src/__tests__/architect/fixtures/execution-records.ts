// Execution records for the TODO 3.1 tests: one action plan with its request, grant, run,
// event and evaluation, consistent with each other and with the planning records below.
// Plain objects, so a test can spread and break them; the action plan's hash is computed.

import { actionPlanHash } from "../../../services/architect/schemas.js";

export const T = "2026-11-15T12:00:00.000Z";
/** One minute after T. */
export const T1 = "2026-11-15T12:01:00.000Z";
/** One hour after T: after every expiry below. */
export const T_LATE = "2026-11-15T13:00:00.000Z";
export const BASE_URL = "http://127.0.0.1:8188";
export const FINGERPRINT = "a".repeat(64);
export const PROMPT_ID = "4f1c7a52-2d6b-4a8e-9a3f-0c2b7e5d9a10";

export const task = {
  schemaVersion: 1 as const,
  id: "task-a1",
  revision: 1,
  createdAt: T,
  updatedAt: T,
  intent: "A red bicycle against a white wall.",
  media: { kind: "image" as const, operation: "text_to_image" as const, output: { width: 1024, height: 1024 } },
};

export const env = {
  schemaVersion: 1 as const,
  id: "env-1",
  capturedAt: T,
  target: { baseUrl: BASE_URL },
  probeErrors: [],
};

export const plan = {
  schemaVersion: 1 as const,
  id: "plan-1",
  taskId: "task-a1",
  taskRevision: 1,
  environmentId: "env-1",
  state: "SELECTED" as const,
  candidateIds: ["cand-1"],
  selectedCandidateId: "cand-1",
  blockers: {
    missing_dependencies: [],
    unsupported_operation: [],
    insufficient_evidence: [],
    resource_limits: [],
    policy_conflicts: [],
  },
  createdAt: T,
  updatedAt: T,
};

export const candidate = {
  schemaVersion: 1 as const,
  id: "cand-1",
  planId: "plan-1",
  taskId: "task-a1",
  taskRevision: 1,
  recipeId: "recipe-fixture.t2i",
  recipeRevision: 1,
  environmentId: "env-1",
  bindings: { checkpoint: "a.safetensors" },
  transforms: [],
  graphFingerprint: FINGERPRINT,
  roleMap: { image: "2" },
  validation: { checks: [], overall: "pass" as const },
  dependencyDelta: { missingModels: [], missingNodeClasses: [] },
  resourceEstimate: { status: "unknown" as const, reason: "no measured profile" },
  ranking: { tier: "fixture" as const, explanation: "fixture recipe" },
  status: "feasible" as const,
  createdAt: T,
};

const binding = {
  planId: "plan-1",
  taskId: "task-a1",
  taskRevision: 1,
  candidateId: "cand-1",
  target: { baseUrl: BASE_URL },
  effects: [{ kind: "local_render" as const, graphFingerprint: FINGERPRINT, outputNodes: ["2"] }],
  budgets: { maxRuns: 1, maxWallTimeSeconds: 600 },
};

export const HASH = actionPlanHash(binding);

export const actionPlan = {
  schemaVersion: 1 as const,
  id: "actions-1",
  ...binding,
  environmentId: "env-1",
  createdAt: T,
  expiresAt: "2026-11-15T12:30:00.000Z",
  hash: HASH,
};

export const approvalRequest = {
  schemaVersion: 1 as const,
  id: "approval-1",
  actionPlanId: "actions-1",
  actionPlanHash: HASH,
  state: "pending" as const,
  createdAt: T,
  expiresAt: "2026-11-15T12:15:00.000Z",
};

export const grant = {
  schemaVersion: 1 as const,
  id: "grant-1",
  approvalRequestId: "approval-1",
  actionPlanId: "actions-1",
  actionPlanHash: HASH,
  target: { baseUrl: BASE_URL },
  limits: { maxRuns: 1, maxWallTimeSeconds: 600 },
  channel: "terminal" as const,
  issuer: "terminal:tty",
  issuedAt: T1,
  expiresAt: "2026-11-15T12:20:00.000Z",
};

export const run = {
  schemaVersion: 1 as const,
  id: "run-1",
  actionPlanId: "actions-1",
  planId: "plan-1",
  taskId: "task-a1",
  taskRevision: 1,
  candidateId: "cand-1",
  graphFingerprint: FINGERPRINT,
  target: { baseUrl: BASE_URL },
  idempotencyKey: `${BASE_URL}|task-a1@1|plan-1|cand-1`,
  state: "PREPARING" as const,
  createdAt: T1,
  updatedAt: T1,
};

export const runEvent = {
  schemaVersion: 1 as const,
  runId: "run-1",
  seq: 1,
  at: T1,
  kind: "transition" as const,
  to: "PREPARING" as const,
  principal: "controller" as const,
  reason: "started under grant grant-1",
};

export const evaluation = {
  schemaVersion: 1 as const,
  id: "eval-1",
  runId: "run-1",
  criterionId: "shape",
  evaluatorId: "evaluator.dimensions",
  evaluatorVersion: "1",
  verdict: "pass" as const,
  source: "automatic" as const,
  measurement: { value: 1024, unit: "px" },
  explanation: "1024×1024 as the task asks.",
  createdAt: T_LATE,
};
