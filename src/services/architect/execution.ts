// The execution workflow behind `architect_run` (TODO 3.3-3.8; spec §16.1): prepare an
// action plan, start a run under a grant, follow it, cancel it, take the user's verdict and
// export the run's record.
//
// Effects pass `admitEffect` (admission.ts); the run itself is driven by the controller.
// What the user decides (approval, verdict) arrives through an approval channel: a client
// dialog only the user can answer, or the terminal command. A verdict the agent relays is
// stored as the agent's report and never counts as the user's (spec §16.1).

import { homedir } from "node:os";
import { join, sep } from "node:path";
import { z } from "zod";
import { type ModelAcquirer, acquiredLockEntry, acquisitionView } from "./acquisition.js";
import {
  type AdmissionDeps,
  ApprovalError,
  admitEffect,
  approveCommand,
  prepareActionPlan,
  shortHash,
} from "./admission.js";
import { acceptanceFrom } from "./evaluation.js";
import { artifactDir, writeFileNoFollow } from "./files.js";
import { canonicalJson, sha256Hex } from "./hash.js";
import {
  type Acceptance,
  type ActionPlan,
  type ApprovalChannel,
  type ApprovalGrant,
  type ApprovalRequest,
  type Effect,
  type EvaluationRecord,
  FINAL_RUN_STATES,
  type LocalRenderEffect,
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
  /**
   * Start driving a run without waiting for it; failures go where the controller reports
   * polling errors, and its poller continues the run. Used for runs that download first.
   */
  schedule?(runId: string): void;
  /** Whether a call on the run is in progress in this process (a download step, a submission). */
  busy?(runId: string): boolean;
}

/** A dialog the client shows the user; undefined when there is none on this route. */
export type ApprovalDialog = (actionPlan: ActionPlan, request: ApprovalRequest) => Promise<ApprovalGrant | undefined>;
export type VerdictDialog = (run: RunRecord, summary: string) => Promise<{ verdict: "accept" | "reject"; note?: string; issuer: string } | undefined>;

export interface ExecutionDeps extends AdmissionDeps {
  driver: RunDriver;
  dataDir: string;
  /** The dependency lock of a candidate's graph (planning's `dependencyLock`), for a run's lineage. */
  dependencyLock: (candidateId: string, task: TaskSpec) => unknown;
  /** A run's acquisitions with download progress, for status; without it, progress isn't shown. */
  acquirer?: Pick<ModelAcquirer, "view">;
}

const LockObject = z.record(z.string(), z.unknown());

/**
 * A copy of `value` with machine-specific paths made portable (spec §15.5): a model root
 * becomes the path below it (`checkpoints/x.safetensors`), the root itself `<model root>`,
 * and the home directory `~`. Applied to the exported run record, not to the store.
 */
export function portablePaths(value: unknown, roots: readonly string[]): unknown {
  const ordered = [...new Set(roots)].sort((a, b) => b.length - a.length);
  const home = homedir();
  const fix = (text: string): string => {
    let out = text;
    for (const root of ordered) out = out.split(`${root}${sep}`).join("").split(root).join("<model root>");
    return home.length > 1 ? out.split(home).join("~") : out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return fix(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
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

/** States in which the run's job may still be submitted or rendering. */
const JOB_MAY_RUN: readonly RunRecord["state"][] = ["PREPARING", "WAITING_FOR_RESOURCE", "VALIDATING", "QUEUED", "RUNNING", "OUTCOME_UNKNOWN"];

/** The criteria a user verdict answers: the task's `user_review` criteria, or one default. */
function reviewCriteria(task: TaskSpec | undefined): string[] {
  const ids = (task?.acceptance ?? []).filter((c) => c.kind === "user_review").map((c) => c.id);
  return ids.length > 0 ? ids : [USER_REVIEW_CRITERION];
}

/**
 * Acceptance (spec §15.3): `acceptanceFrom` decides what the checks and the task's required
 * criteria establish, and the user's verdict sits on top. A rejection fails. An acceptance
 * over checks that didn't all pass is the user's waiver, which is not a machine
 * verification. An agent's report counts for nothing.
 */
export function acceptanceOf(task: TaskSpec, records: readonly EvaluationRecord[]): Acceptance {
  const user = latestUserVerdicts(records);
  if (user.some((r) => r.verdict === "fail")) return "failed";
  const machine = acceptanceFrom(task, records);
  if (user.length > 0 && user.every((r) => r.verdict === "pass")) return machine === "passed" ? "passed" : "waived_by_user";
  return machine;
}

/** The user's latest verdict per criterion: a later answer replaces an earlier one. */
function latestUserVerdicts(records: readonly EvaluationRecord[]): EvaluationRecord[] {
  const latest = new Map<string, EvaluationRecord>();
  for (const r of records) {
    if (r.source !== "user") continue;
    const seen = latest.get(r.criterionId);
    if (!seen || r.createdAt >= seen.createdAt) latest.set(r.criterionId, r);
  }
  return [...latest.values()];
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
  const acceptance = task ? acceptanceOf(task, store.listEvaluations(run.id)) : "pending";
  if (run.state === "COMPLETED") {
    // A later verdict on a completed run (the user changed their mind) updates its acceptance.
    if (acceptance === run.acceptance) return { run, records };
    const updated = store.setRunAcceptance({ runId: run.id, acceptance, principal: "user", reason: `user verdict through ${args.channel}: ${args.verdict}`, at: now() });
    return { run: updated.run, records };
  }
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

/** The action plan's render. Every action plan has exactly one (admission.ts builds it). */
function renderEffect(actionPlan: ActionPlan): Extract<Effect, { kind: "local_render" }> {
  const render = actionPlan.effects.find((e): e is Extract<Effect, { kind: "local_render" }> => e.kind === "local_render");
  if (!render) throw new ApprovalError("APPROVAL_INVALIDATED", `action plan ${actionPlan.id} has no render`, "Call architect_run prepare again.");
  return render;
}

/** Whether the job ran: ComfyUI finished it, it failed, it was cancelled, or nobody knows yet. */
function executionVerdict(run: RunRecord, submitted: boolean): "passed" | "failed" | "cancelled" | "unknown" | "in_progress" | "not_run" {
  // A run stopped before its job was submitted never ran: that isn't an execution failure.
  if (!submitted && (run.state === "FAILED" || run.state === "CANCELLED")) return "not_run";
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
export function verdictsOf(run: RunRecord, records: readonly EvaluationRecord[], submitted: boolean) {
  const user = latestUserVerdicts(records);
  const reported = records.filter((r) => r.source === "agent_reported");
  return {
    execution: executionVerdict(run, submitted),
    acceptance: run.acceptance,
    userVerdict: user.length === 0 ? "none" : user.some((r) => r.verdict === "fail") ? "rejected" : "accepted",
    ...(reported.length > 0 ? { agentReported: reported.map((r) => r.verdict) } : {}),
  };
}

export class ArchitectExecution {
  constructor(private readonly deps: ExecutionDeps) {}

  /** An action plan and its approval request for the plan's selected candidate. */
  async prepare(request: { planId: string }) {
    // One unfinished run per plan. A run whose outcome is unknown may be rendering: a new
    // action plan for the same plan would render it again (spec §15.4). The user resolves
    // or cancels it first; a deliberate rerun then gets its own approval.
    const open = this.deps.store.listRuns().filter((r) => r.planId === request.planId && JOB_MAY_RUN.includes(r.state));
    if (open.length > 0) {
      throw new ApprovalError(
        "GRAPH_CONFLICT",
        `plan ${request.planId} has an unfinished run, ${open[0].id} (${open[0].state})`,
        `Call status for ${open[0].id}; if its outcome stays unknown, tell the user, who decides whether to cancel it before preparing again.`,
      );
    }
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
        graphFingerprint: renderEffect(actionPlan).graphFingerprint,
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
    // A run that downloads first is handed to the controller without waiting: resolving a
    // download's destination calls upstream's live-server probes, which can take many
    // seconds each, and the client's request would time out. The poller continues it; status
    // shows its downloads. A run without downloads is advanced to submission as before.
    if (actionPlan.effects.some((e) => e.kind === "acquire_models")) {
      if (driver.schedule) driver.schedule(created.run.id);
      else void driver.advance(created.run.id).catch(() => undefined); // the poller retries; the controller records its errors
      return { run: created.run, resumed: false, grant: { id: grant.id, channel: grant.channel } };
    }
    const run = await driver.advance(created.run.id);
    return { run, resumed: false, grant: { id: grant.id, channel: grant.channel } };
  }

  /** The run as the target sees it now: one reconciliation, then the record. */
  async status(request: { runId: string }) {
    const { store, driver } = this.deps;
    const before = this.requireRun(request.runId);
    // A step already running on this run (a download being started) isn't waited for: the
    // stored record is current as far as it goes, and the next status sees the step's result.
    const run = FINAL_RUN_STATES.includes(before.state) || driver.busy?.(before.id) ? before : await driver.reconcile(before.id);
    const records = store.listEvaluations(run.id);
    const events = store.listRunEvents(run.id);
    const acquisitions = this.deps.acquirer
      ? await this.deps.acquirer.view(run.id)
      : store.listAcquisitions(run.id).map((a) => acquisitionView(a));
    return {
      run,
      ...(acquisitions.length > 0 ? { acquisitions } : {}),
      verdicts: verdictsOf(run, records, this.submitted(run.id)),
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
      return { run: r.run, verdicts: verdictsOf(r.run, store.listEvaluations(r.run.id), true), userVerdict: answer.verdict };
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
      verdicts: verdictsOf(fresh, store.listEvaluations(fresh.id), true),
      userVerdict: "none" as const,
      nextStep: `The user's own verdict comes from a dialog or, in a terminal: COMFYUI_ARCHITECT=1 comfyui-mcp architect review ${run.id}`,
    };
  }

  /**
   * Write the run's record, its evaluations and its dependency lock next to the plan's
   * exported files (spec §15.1, FR-11), without following a symbolic link (SEC T9).
   */
  finalize(request: { runId: string }) {
    const { store, dataDir } = this.deps;
    const run = this.requireRun(request.runId);
    if (!FINAL_RUN_STATES.includes(run.state) && run.state !== "AWAITING_REVIEW") {
      throw new ApprovalError("MISSING_INPUT", `run ${run.id} is ${run.state}`, "Finalize a run once it is final or waiting for review.");
    }
    let dir: string;
    try {
      dir = artifactDir(dataDir, [run.taskId, run.planId, "runs", run.id]);
    } catch (err) {
      throw new ApprovalError("MISSING_INPUT", `refusing to write the run record: ${err instanceof Error ? err.message : String(err)}`, "Remove the link or odd name under artifacts/ and finalize again.");
    }
    const records = store.listEvaluations(run.id);
    const actionPlan = store.getActionPlan(run.actionPlanId);
    const grant = run.grantId ? store.getGrant(run.grantId) : undefined;
    const task = store.getTask(run.taskId, run.taskRevision);
    // FR-11: each file the run acquired, with its source, commit and the sha256 observed
    // before it was placed. Only placed files: the others never reached a model folder.
    const acquisitions = store.listAcquisitions(run.id);
    const acquired = acquisitions.filter((a) => a.state === "placed").map(acquiredLockEntry);
    // The input files the grant bound, with the content hash read at start (GAPS Q33): asset
    // id, sha256 and size, never a path on this machine.
    const inputs = actionPlan?.effects.find((e): e is LocalRenderEffect => e.kind === "local_render")?.inputs;
    const baseLock = task ? this.deps.dependencyLock(run.candidateId, task) : undefined;
    const lockFields = LockObject.safeParse(baseLock);
    const lock =
      baseLock === undefined || (acquired.length === 0 && inputs === undefined)
        ? baseLock
        : {
            ...(lockFields.success ? lockFields.data : { lock: baseLock }),
            ...(acquired.length > 0 ? { acquired } : {}),
            ...(inputs ? { inputs } : {}),
          };
    const lockText = lock === undefined ? undefined : `${JSON.stringify(lock, null, 2)}\n`;
    const files: Record<string, string> = {
      "run.json": `${JSON.stringify(
        portablePaths(
        {
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
            ...(inputs ? { inputs } : {}),
            ...(acquisitions.length > 0
              ? {
                  acquisitions: acquisitions.map((a) => ({
                    ...acquiredLockEntry(a),
                    ...(a.placedPath ? { placed: `${a.folder}/${a.file}` } : {}),
                    state: a.state,
                    pinnedSha256: a.source.sha256,
                    pinnedSizeBytes: a.source.sizeBytes,
                    ...(a.error ? { error: a.error } : {}),
                  })),
                }
              : {}),
            dependencyLock: lockText ? { file: "dependencies.lock.json", sha256: sha256Hex(lockText) } : "unknown: the task revision is not stored",
          },
          verdicts: verdictsOf(run, records, this.submitted(run.id)),
          events: store.listRunEvents(run.id),
        },
          acquisitions.map((a) => a.destinationRoot),
        ),
        null,
        2,
      )}\n`,
      "evaluation.json": `${JSON.stringify(records, null, 2)}\n`,
      ...(lockText ? { "dependencies.lock.json": lockText } : {}),
    };
    const written: string[] = [];
    for (const [name, text] of Object.entries(files)) {
      const path = join(dir, name);
      writeFileNoFollow(path, text);
      written.push(path);
    }
    return { dir, files: written };
  }

  /** Whether the run's job was ever submitted (an attempt is recorded before the POST). */
  private submitted(runId: string): boolean {
    return this.deps.store.listRunEvents(runId).some((e) => e.kind === "submit_attempt");
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
