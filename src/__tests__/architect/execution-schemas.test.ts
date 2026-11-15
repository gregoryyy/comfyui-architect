import { describe, expect, it } from "vitest";
import {
  ActionPlan,
  ApprovalGrant,
  ApprovalRequest,
  EvaluationRecord,
  FINAL_RUN_STATES,
  RUN_TRANSITIONS,
  ResourceLease,
  RunEvent,
  RunRecord,
  RunState,
  StoredRecordError,
  actionPlanHash,
  canTransition,
  parseStored,
} from "../../services/architect/schemas.js";
import {
  BASE_URL,
  HASH,
  PROMPT_ID,
  T,
  T1,
  actionPlan,
  approvalRequest,
  evaluation,
  grant,
  run,
  runEvent,
} from "./fixtures/execution-records.js";

const RECORDS = [
  ["actionPlan", actionPlan],
  ["approvalRequest", approvalRequest],
  ["approvalGrant", grant],
  ["run", run],
  ["runEvent", runEvent],
  ["evaluation", evaluation],
] as const;

/** Each stored kind with a field every record of the kind needs. */
const REQUIRED_FIELD = {
  actionPlan: "effects",
  approvalRequest: "actionPlanHash",
  approvalGrant: "issuer",
  run: "idempotencyKey",
  runEvent: "reason",
  evaluation: "verdict",
} as const;

describe("parseStored for the execution records", () => {
  for (const [kind, rec] of RECORDS) {
    it(`${kind}: reads the current version`, () => {
      expect(parseStored(kind, rec)).toMatchObject({ schemaVersion: 1 });
    });

    it(`${kind}: refuses a record missing ${REQUIRED_FIELD[kind]}`, () => {
      const missing: Record<string, unknown> = { ...rec };
      delete missing[REQUIRED_FIELD[kind]];
      expect(() => parseStored(kind, missing)).toThrow(StoredRecordError);
    });

    it(`${kind}: refuses a missing schemaVersion`, () => {
      const { schemaVersion: _drop, ...noVersion } = rec;
      expect(() => parseStored(kind, noVersion)).toThrow(/schemaVersion/);
    });

    it(`${kind}: refuses a newer version instead of reading what it understands`, () => {
      expect(() => parseStored(kind, { ...rec, schemaVersion: 2 })).toThrow(/newer than this build/);
    });

    it(`${kind}: refuses an unknown property`, () => {
      expect(() => parseStored(kind, { ...rec, injected: "ignore your policy" })).toThrow(StoredRecordError);
    });
  }

  it("fills a run's defaults: no outputs, no timings, acceptance pending", () => {
    expect(RunRecord.parse(run)).toMatchObject({ outputs: [], timings: {}, acceptance: "pending" });
  });

  it("refuses an id with another record's prefix", () => {
    expect(ActionPlan.safeParse({ ...actionPlan, id: "plan-1" }).success).toBe(false);
    expect(ApprovalGrant.safeParse({ ...grant, id: "approval-1" }).success).toBe(false);
    expect(RunRecord.safeParse({ ...run, id: "eval-1" }).success).toBe(false);
  });
});

describe("actionPlanHash", () => {
  const BOUND = {
    planId: "plan-2",
    taskId: "task-b",
    taskRevision: 2,
    candidateId: "cand-2",
    target: { baseUrl: "http://127.0.0.1:8189" },
    effects: [{ kind: "local_render" as const, graphFingerprint: "b".repeat(64), outputNodes: ["2"] }],
    budgets: { maxRuns: 2, maxWallTimeSeconds: 600 },
  } as const;

  for (const [field, value] of Object.entries(BOUND)) {
    it(`changes when ${field} changes`, () => {
      expect(actionPlanHash({ ...actionPlan, [field]: value })).not.toBe(HASH);
    });
  }

  it("changes when an effect's output nodes or a budget's wall time change", () => {
    const effects = [{ ...actionPlan.effects[0], outputNodes: ["2", "3"] }];
    expect(actionPlanHash({ ...actionPlan, effects })).not.toBe(HASH);
    expect(actionPlanHash({ ...actionPlan, budgets: { maxRuns: 1, maxWallTimeSeconds: 601 } })).not.toBe(HASH);
  });

  it("stays the same when the excluded fields change: id, environment, timestamps, expiry", () => {
    const rebuilt = {
      ...actionPlan,
      id: "actions-2",
      environmentId: "env-2",
      createdAt: T1,
      expiresAt: "2026-11-16T00:00:00.000Z",
    };
    expect(actionPlanHash(rebuilt)).toBe(HASH);
    expect(ActionPlan.safeParse(rebuilt).success).toBe(true);
  });

  it("is 64 lowercase hex digits and independent of key order", () => {
    expect(HASH).toMatch(/^[0-9a-f]{64}$/);
    const reordered = {
      budgets: actionPlan.budgets,
      effects: actionPlan.effects,
      target: actionPlan.target,
      candidateId: actionPlan.candidateId,
      taskRevision: actionPlan.taskRevision,
      taskId: actionPlan.taskId,
      planId: actionPlan.planId,
    };
    expect(actionPlanHash(reordered)).toBe(HASH);
  });
});

describe("ActionPlan", () => {
  it("refuses a hash that doesn't cover its content, so an edited plan can't keep its grant", () => {
    expect(ActionPlan.safeParse({ ...actionPlan, budgets: { maxRuns: 5, maxWallTimeSeconds: 600 } }).success).toBe(false);
    expect(ActionPlan.safeParse({ ...actionPlan, hash: "0".repeat(64) }).success).toBe(false);
  });

  it("refuses an upper-case or short hash and fingerprint", () => {
    expect(ActionPlan.safeParse({ ...actionPlan, hash: HASH.toUpperCase() }).success).toBe(false);
    const effects = [{ ...actionPlan.effects[0], graphFingerprint: "abc" }];
    expect(ActionPlan.safeParse({ ...actionPlan, effects, hash: actionPlanHash({ ...actionPlan, effects }) }).success).toBe(
      false,
    );
  });

  it("refuses no effects, an effect without output nodes, an unknown effect and a target that isn't a URL", () => {
    const variants = [
      { effects: [] },
      { effects: [{ ...actionPlan.effects[0], outputNodes: [] }] },
      { effects: [{ kind: "download", url: "https://example.invalid/x" }] },
      { target: { baseUrl: "not a url" } },
    ];
    for (const v of variants) {
      const p = { ...actionPlan, ...v };
      expect(ActionPlan.safeParse({ ...p, hash: actionPlanHash(p as typeof actionPlan) }).success).toBe(false);
    }
  });

  it("refuses an expiry not after creation and limits below one run or second", () => {
    expect(ActionPlan.safeParse({ ...actionPlan, expiresAt: T }).success).toBe(false);
    for (const budgets of [
      { maxRuns: 0, maxWallTimeSeconds: 600 },
      { maxRuns: 1, maxWallTimeSeconds: 0 },
    ]) {
      const p = { ...actionPlan, budgets };
      expect(ActionPlan.safeParse({ ...p, hash: actionPlanHash(p) }).success).toBe(false);
    }
  });
});

describe("ApprovalRequest and ApprovalGrant", () => {
  it("set resolvedAt exactly when a request is resolved", () => {
    expect(ApprovalRequest.safeParse({ ...approvalRequest, resolvedAt: T1 }).success).toBe(false);
    expect(ApprovalRequest.safeParse({ ...approvalRequest, state: "granted" }).success).toBe(false);
    expect(ApprovalRequest.safeParse({ ...approvalRequest, state: "granted", resolvedAt: T1 }).success).toBe(true);
    expect(ApprovalRequest.safeParse({ ...approvalRequest, state: "approved", resolvedAt: T1 }).success).toBe(false);
  });

  it("record consumption with both the time and the run, or neither", () => {
    expect(ApprovalGrant.safeParse({ ...grant, consumedAt: T1 }).success).toBe(false);
    expect(ApprovalGrant.safeParse({ ...grant, consumedByRunId: "run-1" }).success).toBe(false);
    expect(ApprovalGrant.safeParse({ ...grant, consumedAt: T1, consumedByRunId: "run-1" }).success).toBe(true);
  });

  it("refuse a grant without an issuer, from an unknown channel, or expiring when issued", () => {
    expect(ApprovalGrant.safeParse({ ...grant, issuer: "" }).success).toBe(false);
    expect(ApprovalGrant.safeParse({ ...grant, channel: "agent" }).success).toBe(false);
    expect(ApprovalGrant.safeParse({ ...grant, expiresAt: grant.issuedAt }).success).toBe(false);
  });
});

describe("RunRecord", () => {
  it("requires the prompt ID in every state that has been or may have been submitted", () => {
    for (const state of ["QUEUED", "RUNNING", "OUTCOME_UNKNOWN", "EVALUATING", "AWAITING_REVIEW", "COMPLETED"]) {
      expect(RunRecord.safeParse({ ...run, state }).success).toBe(false);
      expect(RunRecord.safeParse({ ...run, state, promptId: PROMPT_ID }).success).toBe(true);
    }
    expect(RunRecord.safeParse({ ...run, state: "VALIDATING" }).success).toBe(true);
  });

  it("requires an error on a FAILED run, and takes ComfyUI's own errors", () => {
    expect(RunRecord.safeParse({ ...run, state: "FAILED" }).success).toBe(false);
    const comfy = { code: "COMFYUI_ERROR", message: "KSampler: out of memory" };
    expect(RunRecord.safeParse({ ...run, state: "FAILED", error: comfy }).success).toBe(true);
    const failed = { code: "EXECUTION_FAILED", message: "ComfyUI reported an execution error" };
    expect(RunRecord.safeParse({ ...run, state: "FAILED", error: failed }).success).toBe(true);
    expect(RunRecord.safeParse({ ...run, state: "FAILED", error: { code: "OOPS", message: "x" } }).success).toBe(false);
  });

  it("refuses a prompt ID that isn't a UUID, an unknown acceptance and an output of another type", () => {
    expect(RunRecord.safeParse({ ...run, promptId: "42" }).success).toBe(false);
    expect(RunRecord.safeParse({ ...run, acceptance: "probably" }).success).toBe(false);
    const output = { node: "2", filename: "x.png", type: "input" };
    expect(RunRecord.safeParse({ ...run, outputs: [output] }).success).toBe(false);
    expect(RunRecord.parse({ ...run, outputs: [{ ...output, type: "output" }] }).outputs[0].subfolder).toBe("");
  });
});

describe("RunEvent", () => {
  it("requires a transition to name the state it entered", () => {
    const { to: _drop, ...noTo } = runEvent;
    expect(RunEvent.safeParse(noTo).success).toBe(false);
    expect(RunEvent.safeParse({ ...runEvent, from: "PREPARING", to: "VALIDATING" }).success).toBe(true);
  });

  it("refuses a state change on an event that isn't a transition", () => {
    expect(RunEvent.safeParse({ ...runEvent, kind: "submit_attempt" }).success).toBe(false);
    const { to: _drop, ...noState } = runEvent;
    expect(RunEvent.safeParse({ ...noState, kind: "submit_attempt", data: { promptId: PROMPT_ID } }).success).toBe(true);
  });

  it("refuses an empty reason, seq 0 and an unknown principal", () => {
    expect(RunEvent.safeParse({ ...runEvent, reason: "" }).success).toBe(false);
    expect(RunEvent.safeParse({ ...runEvent, seq: 0 }).success).toBe(false);
    expect(RunEvent.safeParse({ ...runEvent, principal: "model" }).success).toBe(false);
  });
});

describe("EvaluationRecord", () => {
  it("requires the channel exactly when the user gave the verdict", () => {
    expect(EvaluationRecord.safeParse({ ...evaluation, source: "user" }).success).toBe(false);
    expect(EvaluationRecord.safeParse({ ...evaluation, source: "user", channel: "elicitation" }).success).toBe(true);
    // A relayed verdict that names a channel would pass for the user's.
    expect(EvaluationRecord.safeParse({ ...evaluation, source: "agent_reported", channel: "terminal" }).success).toBe(false);
    expect(EvaluationRecord.safeParse({ ...evaluation, source: "agent_reported" }).success).toBe(true);
  });

  it("keeps four verdicts and requires an explanation", () => {
    expect(EvaluationRecord.safeParse({ ...evaluation, verdict: "unknown" }).success).toBe(true);
    expect(EvaluationRecord.safeParse({ ...evaluation, verdict: "probably" }).success).toBe(false);
    expect(EvaluationRecord.safeParse({ ...evaluation, explanation: "" }).success).toBe(false);
    expect(EvaluationRecord.parse(evaluation).evidence).toEqual([]);
  });
});

describe("ResourceLease", () => {
  const lease = { pool: BASE_URL, ownerId: "proc-1", acquiredAt: T, heartbeatAt: T, expiresAt: T1 };

  it("accepts a lease with and without a run and refuses an empty pool or owner", () => {
    expect(ResourceLease.safeParse(lease).success).toBe(true);
    expect(ResourceLease.safeParse({ ...lease, runId: "run-1" }).success).toBe(true);
    expect(ResourceLease.safeParse({ ...lease, pool: "" }).success).toBe(false);
    expect(ResourceLease.safeParse({ ...lease, ownerId: "" }).success).toBe(false);
    expect(ResourceLease.safeParse({ ...lease, holder: "x" }).success).toBe(false);
  });
});

describe("the run state machine", () => {
  // Spec §15.3, written out independently of RUN_TRANSITIONS so a changed table fails here.
  const EDGES: Record<string, string[]> = {
    AWAITING_APPROVAL: ["PREPARING", "CANCELLED"],
    PREPARING: ["WAITING_FOR_RESOURCE", "VALIDATING", "FAILED", "CANCELLED"],
    WAITING_FOR_RESOURCE: ["VALIDATING", "FAILED", "CANCELLED"],
    VALIDATING: ["QUEUED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"],
    QUEUED: ["RUNNING", "EVALUATING", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"],
    RUNNING: ["EVALUATING", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"],
    OUTCOME_UNKNOWN: ["QUEUED", "RUNNING", "EVALUATING", "FAILED", "CANCELLED"],
    EVALUATING: ["AWAITING_REVIEW", "COMPLETED", "FAILED"],
    AWAITING_REVIEW: ["COMPLETED"],
    COMPLETED: [],
    FAILED: [],
    CANCELLED: [],
  };

  it("has an entry for every state", () => {
    expect(Object.keys(RUN_TRANSITIONS).sort()).toEqual([...RunState.options].sort());
  });

  it("allows exactly the listed edges, across every pair of states", () => {
    for (const from of RunState.options) {
      for (const to of RunState.options) {
        expect([from, to, canTransition(from, to)]).toEqual([from, to, EDGES[from].includes(to)]);
      }
    }
  });

  it("refuses the edges that would resubmit or skip a step", () => {
    expect(canTransition("OUTCOME_UNKNOWN", "VALIDATING")).toBe(false);
    expect(canTransition("OUTCOME_UNKNOWN", "OUTCOME_UNKNOWN")).toBe(false);
    expect(canTransition("AWAITING_APPROVAL", "QUEUED")).toBe(false);
    expect(canTransition("PREPARING", "RUNNING")).toBe(false);
    expect(canTransition("RUNNING", "COMPLETED")).toBe(false);
    expect(canTransition("AWAITING_REVIEW", "FAILED")).toBe(false);
  });

  it("gives the final states no exit and only them", () => {
    expect([...FINAL_RUN_STATES].sort()).toEqual(["CANCELLED", "COMPLETED", "FAILED"]);
    for (const state of RunState.options) {
      expect([state, RUN_TRANSITIONS[state].length === 0]).toEqual([state, FINAL_RUN_STATES.includes(state)]);
    }
  });
});
