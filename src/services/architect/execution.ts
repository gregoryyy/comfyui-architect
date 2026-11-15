// The execution workflow behind `architect_run` (TODO 3.3-3.8; spec §16.1): prepare an
// action plan, start a run under a grant, follow it, cancel it, take the user's verdict and
// export the run's record.
//
// Effects pass `admitEffect` (admission.ts); the run itself is driven by the controller.
// What the user decides (approval, verdict) arrives through an approval channel: a client
// dialog only the user can answer, or the terminal command. A verdict the agent relays is
// stored as the agent's report and never counts as the user's (spec §16.1).

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  type AdmissionDeps,
  ApprovalError,
  admitEffect,
  approveCommand,
  prepareActionPlan,
  shortHash,
} from "./admission.js";
import { canonicalJson, sha256Hex } from "./hash.js";
import {
  type Acceptance,
  type ActionPlan,
  type ApprovalChannel,
  type ApprovalGrant,
  type ApprovalRequest,
  type EvaluationRecord,
  FINAL_RUN_STATES,
  type RunPrincipal,
  type RunRecord,
  type TaskSpec,
} from "./schemas.js";
import type { ArchitectStore } from "./store.js";

/** What execution needs from the run controller (controller.ts). */
export interface RunDriver {
  /** Drive a run the store just created in PREPARING up to submission. */
  advance(runId: string): Promise<RunRecord>;
  /** One observation of the target; moves the run when it learned something. */
  reconcile(runId: string): Promise<RunRecord>;
  /** Cancel the run's own prompt only (spec §14.5). */
  cancel(runId: string, principal: RunPrincipal): Promise<RunRecord>;
}

/** A dialog the client shows the user; undefined when there is none on this route. */
export type ApprovalDialog = (actionPlan: ActionPlan, request: ApprovalRequest) => Promise<ApprovalGrant | undefined>;
export type VerdictDialog = (run: RunRecord, summary: string) => Promise<{ verdict: "accept" | "reject"; note?: string; issuer: string } | undefined>;

export interface ExecutionDeps extends AdmissionDeps {
  driver: RunDriver;
  dataDir: string;
}

/** The idempotency key of a run: one per target, task revision, plan and action plan (spec §15.4). */
export function idempotencyKey(actionPlan: ActionPlan): string {
  return sha256Hex(
    canonicalJson({
      baseUrl: actionPlan.target.baseUrl,
      taskId: actionPlan.taskId,
      taskRevision: actionPlan.taskRevision,
      planId: actionPlan.planId,
      actionPlanId: actionPlan.id,
    }),
  );
}

const USER_REVIEW_CRITERION = "user_review";

/** The criteria a user verdict answers: the task's `user_review` criteria, or one default. */
function reviewCriteria(task: TaskSpec | undefined): string[] {
  const ids = (task?.acceptance ?? []).filter((c) => c.kind === "user_review").map((c) => c.id);
  return ids.length > 0 ? ids : [USER_REVIEW_CRITERION];
}

/**
 * Acceptance from the automatic checks and the user's verdict (spec §15.3). A rejection
 * fails; an acceptance passes only when every automatic check passed, and otherwise is the
 * user's waiver, which is not a machine verification.
 */
export function acceptanceOf(records: readonly EvaluationRecord[]): Acceptance {
  const user = records.filter((r) => r.source === "user");
  const automatic = records.filter((r) => r.source === "automatic");
  if (user.some((r) => r.verdict === "fail")) return "failed";
  const userAccepted = user.length > 0 && user.every((r) => r.verdict === "pass");
  const automaticPassed = automatic.every((r) => r.verdict === "pass" || r.verdict === "not_applicable");
  if (userAccepted) return automaticPassed ? "passed" : "waived_by_user";
  if (automatic.some((r) => r.verdict === "fail")) return "failed";
  return "pending";
}

/**
 * Store the user's verdict on a run, from an approval channel. Moves a run waiting for
 * review to COMPLETED with its acceptance. Called by the verdict dialog and the terminal
 * `review` command; no tool argument reaches it.
 */
export function recordUserVerdict(
  deps: Pick<ExecutionDeps, "store" | "now" | "newId">,
  args: { runId: string; verdict: "accept" | "reject"; channel: ApprovalChannel; issuer: string; note?: string },
): { run: RunRecord; records: EvaluationRecord[] } {
  const { store, now, newId } = deps;
  const run = store.getRun(args.runId);
  if (!run) throw new ApprovalError("MISSING_INPUT", `run ${args.runId} is not stored`, "Check the run ID.");
  if (run.state !== "AWAITING_REVIEW" && run.state !== "COMPLETED") {
    throw new ApprovalError("MISSING_INPUT", `run ${run.id} is ${run.state}; a verdict needs its outputs`, "Wait until the run is AWAITING_REVIEW or COMPLETED.");
  }
  const task = store.getTask(run.taskId, run.taskRevision);
  const at = now().toISOString();
  const records = reviewCriteria(task).map((criterionId) =>
    store.putEvaluation({
      schemaVersion: 1,
      id: `eval-${newId()}`,
      runId: run.id,
      criterionId,
      evaluatorId: "architect.user-review",
      evaluatorVersion: "1",
      verdict: args.verdict === "accept" ? "pass" : "fail",
      source: "user",
      channel: args.channel,
      explanation: `${args.verdict === "accept" ? "Accepted" : "Rejected"} by the user (${args.issuer})${args.note ? `: ${args.note}` : ""}`,
      evidence: run.outputs.map((o) => `${o.type}/${o.subfolder ? `${o.subfolder}/` : ""}${o.filename}`),
      createdAt: at,
    }),
  );
  if (run.state !== "AWAITING_REVIEW") return { run, records };
  const acceptance = acceptanceOf(store.listEvaluations(run.id));
  const moved = store.transitionRun({
    runId: run.id,
    from: "AWAITING_REVIEW",
    to: "COMPLETED",
    principal: "user",
    reason: `user verdict through ${args.channel}: ${args.verdict}`,
    patch: { acceptance },
    at: now(),
  });
  return { run: moved.run, records };
}

/** Whether the job ran: ComfyUI finished it, it failed, it was cancelled, or nobody knows yet. */
function executionVerdict(run: RunRecord): "passed" | "failed" | "cancelled" | "unknown" | "in_progress" {
  switch (run.state) {
    case "EVALUATING":
    case "AWAITING_REVIEW":
    case "COMPLETED":
      return "passed";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    case "OUTCOME_UNKNOWN":
      return "unknown";
    default:
      return "in_progress";
  }
}

/** The three statements spec §4.2 keeps apart, for a status reply. */
export function verdictsOf(run: RunRecord, records: readonly EvaluationRecord[]) {
  const user = records.filter((r) => r.source === "user");
  const reported = records.filter((r) => r.source === "agent_reported");
  return {
    execution: executionVerdict(run),
    acceptance: run.acceptance,
    userVerdict: user.length === 0 ? "none" : user.some((r) => r.verdict === "fail") ? "rejected" : "accepted",
    ...(reported.length > 0 ? { agentReported: reported.map((r) => r.verdict) } : {}),
  };
}

export class ArchitectExecution {
  constructor(private readonly deps: ExecutionDeps) {}

  /** An action plan and its approval request for the plan's selected candidate. */
  async prepare(request: { planId: string }) {
    const { actionPlan, request: approval } = await prepareActionPlan(this.deps, request.planId);
    return {
      actionPlan,
      approvalRequest: approval,
      shortHash: shortHash(actionPlan.hash),
      approval: {
        howTo:
          "Call start: where the client can show a dialog, the user approves there. Otherwise the user approves in a terminal; you can't approve for them.",
        terminal: approveCommand(approval.id),
      },
    };
  }

  /** Start the action plan's run under a grant. A second start returns the same run. */
  async start(request: { actionPlanId: string }, dialog?: ApprovalDialog) {
    const { store, now, newId, driver } = this.deps;
    const stored = store.getActionPlan(request.actionPlanId);
    if (!stored) throw new ApprovalError("MISSING_INPUT", `action plan ${request.actionPlanId} is not stored`, "Call architect_run prepare.");
    const key = idempotencyKey(stored);
    const existing = store.findRunByIdempotencyKey(key);
    if (existing) return { run: existing, resumed: true };
    const { actionPlan, grant } = await admitEffect(this.deps, stored.id, dialog);
    const created = store.createRunWithGrant({
      run: {
        schemaVersion: 1,
        id: `run-${newId()}`,
        actionPlanId: actionPlan.id,
        planId: actionPlan.planId,
        taskId: actionPlan.taskId,
        taskRevision: actionPlan.taskRevision,
        candidateId: actionPlan.candidateId,
        graphFingerprint: actionPlan.effects[0].graphFingerprint,
        target: actionPlan.target,
        idempotencyKey: key,
        state: "PREPARING",
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
      },
      grantId: grant.id,
      now: now(),
      principal: "agent",
      reason: `started under grant ${grant.id} (${grant.channel}, ${grant.issuer})`,
    });
    const run = await driver.advance(created.run.id);
    return { run, resumed: false, grant: { id: grant.id, channel: grant.channel } };
  }

  /** The run as the target sees it now: one reconciliation, then the record. */
  async status(request: { runId: string }) {
    const { store, driver } = this.deps;
    const before = this.requireRun(request.runId);
    const run = FINAL_RUN_STATES.includes(before.state) ? before : await driver.reconcile(before.id);
    const records = store.listEvaluations(run.id);
    const events = store.listRunEvents(run.id);
    return {
      run,
      verdicts: verdictsOf(run, records),
      evaluations: records.map((r) => ({ criterion: r.criterionId, verdict: r.verdict, source: r.source, explanation: r.explanation })),
      recentEvents: events.slice(-5).map((e) => ({ seq: e.seq, at: e.at, kind: e.kind, ...(e.to ? { to: e.to } : {}), reason: e.reason })),
    };
  }

  /** Cancel the run's own prompt; never touches other jobs. */
  async cancel(request: { runId: string }) {
    const run = this.requireRun(request.runId);
    return { run: await this.deps.driver.cancel(run.id, "agent") };
  }

  /**
   * The user's verdict on a run's outputs. With a dialog, the user answers it. Without one,
   * a verdict the agent passes is stored as the agent's report, and the reply names the
   * terminal command for the user's own.
   */
  async evaluate(request: { runId: string; reportedVerdict?: "accept" | "reject"; note?: string }, dialog?: VerdictDialog) {
    const { store, now, newId } = this.deps;
    const run = this.requireRun(request.runId);
    if (run.state !== "AWAITING_REVIEW" && run.state !== "COMPLETED") {
      throw new ApprovalError("MISSING_INPUT", `run ${run.id} is ${run.state}; a verdict needs its outputs`, "Call status until the run is AWAITING_REVIEW or COMPLETED.");
    }
    const summary = this.reviewSummary(run);
    const answer = dialog ? await dialog(run, summary) : undefined;
    if (answer) {
      const r = recordUserVerdict(this.deps, { runId: run.id, verdict: answer.verdict, channel: "elicitation", issuer: answer.issuer, ...(answer.note ? { note: answer.note } : {}) });
      return { run: r.run, verdicts: verdictsOf(r.run, store.listEvaluations(r.run.id)), userVerdict: answer.verdict };
    }
    if (request.reportedVerdict) {
      const task = store.getTask(run.taskId, run.taskRevision);
      for (const criterionId of reviewCriteria(task)) {
        store.putEvaluation({
          schemaVersion: 1,
          id: `eval-${newId()}`,
          runId: run.id,
          criterionId,
          evaluatorId: "architect.agent-report",
          evaluatorVersion: "1",
          verdict: request.reportedVerdict === "accept" ? "pass" : "fail",
          source: "agent_reported",
          explanation: `Reported by the agent, not given by the user through an approval channel${request.note ? `: ${request.note}` : ""}`,
          evidence: [],
          createdAt: now().toISOString(),
        });
      }
    }
    const fresh = this.requireRun(run.id);
    return {
      run: fresh,
      verdicts: verdictsOf(fresh, store.listEvaluations(fresh.id)),
      userVerdict: "none" as const,
      nextStep: `The user's own verdict comes from a dialog or, in a terminal: COMFYUI_ARCHITECT=1 comfyui-mcp architect review ${run.id}`,
    };
  }

  /** Write the run's record and evaluations next to the plan's exported files (spec §15.1). */
  finalize(request: { runId: string }) {
    const { store, dataDir } = this.deps;
    const run = this.requireRun(request.runId);
    if (!FINAL_RUN_STATES.includes(run.state) && run.state !== "AWAITING_REVIEW") {
      throw new ApprovalError("MISSING_INPUT", `run ${run.id} is ${run.state}`, "Finalize a run once it is final or waiting for review.");
    }
    const root = resolve(dataDir, "artifacts");
    const dir = resolve(root, run.taskId, run.planId, "runs", run.id);
    // IDs are generated here, but a stored ID is still data: never write outside artifacts/.
    if (!dir.startsWith(root + sep)) throw new ApprovalError("MISSING_INPUT", `refusing to write outside ${root}`, "Report this run ID.");
    mkdirSync(dir, { recursive: true });
    // A symlink anywhere under artifacts/ could point the write elsewhere (SEC T9).
    if (realpathSync(dir) !== resolve(realpathSync(dataDir), "artifacts", run.taskId, run.planId, "runs", run.id)) {
      throw new ApprovalError("MISSING_INPUT", `refusing to write through a symbolic link under ${root}`, "Remove the link and finalize again.");
    }
    const records = store.listEvaluations(run.id);
    const actionPlan = store.getActionPlan(run.actionPlanId);
    const grant = run.grantId ? store.getGrant(run.grantId) : undefined;
    const files: Record<string, unknown> = {
      "run.json": {
        run,
        lineage: {
          task: { id: run.taskId, revision: run.taskRevision },
          plan: run.planId,
          candidate: run.candidateId,
          graphFingerprint: run.graphFingerprint,
          environment: actionPlan?.environmentId,
          actionPlan: actionPlan ? { id: actionPlan.id, hash: actionPlan.hash } : run.actionPlanId,
          grant: grant ? { id: grant.id, channel: grant.channel, issuer: grant.issuer, issuedAt: grant.issuedAt } : undefined,
          promptId: run.promptId,
        },
        verdicts: verdictsOf(run, records),
        events: store.listRunEvents(run.id),
      },
      "evaluation.json": records,
    };
    const written: string[] = [];
    for (const [name, value] of Object.entries(files)) {
      const path = join(dir, name);
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
      written.push(path);
    }
    return { dir, files: written };
  }

  /** What the user sees before giving a verdict. */
  reviewSummary(run: RunRecord): string {
    const records = this.deps.store.listEvaluations(run.id).filter((r) => r.source === "automatic");
    return [
      `Run ${run.id}: ${run.state}`,
      `Outputs: ${run.outputs.map((o) => `${o.subfolder ? `${o.subfolder}/` : ""}${o.filename}`).join(", ") || "none"}`,
      ...records.map((r) => `- ${r.criterionId}: ${r.verdict} (${r.explanation})`),
    ].join("\n");
  }

  private requireRun(runId: string): RunRecord {
    const run = this.deps.store.getRun(runId);
    if (!run) throw new ApprovalError("MISSING_INPUT", `run ${runId} is not stored`, "Check the run ID.");
    return run;
  }
}
