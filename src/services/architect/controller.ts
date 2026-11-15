// The durable run controller (spec §15.3, §15.4, §14.5; TODO 3.5.2, 3.5.3, AT-06, AT-07).
//
// A run is created by `createRunWithGrant` in PREPARING. From there the controller leases
// the memory pool, compiles the graph again, stores a submission attempt with a fresh
// client-chosen prompt ID and only then POSTs, so a lost response can be reconciled by
// that ID against /queue and /history instead of being submitted again. Every state change
// is a compare-and-set transition in the store, written with its event before anyone hears
// of it; a run that another actor moved in the meantime is re-read and returned, never
// overwritten.
//
// The store is the source of truth, not this object: a new controller on the same store
// (after a restart, or in the panel agent's server) picks up every non-final run.
// Cancellation touches only the run's own prompt ID, by dequeue or by an interrupt that
// ComfyUI honours only for the running prompt with that ID; nothing here clears the queue
// or interrupts without an ID.

import { z } from "zod";
import { graphFingerprint } from "./compile.js";
import { acceptanceFrom, evaluateOutputs, needsUserReview, type ProbedOutput } from "./evaluation.js";
import { probeMedia } from "./media-probe.js";
import type { ResourceCoordinator } from "./resources.js";
import {
  type ApiGraph,
  ArchitectErrorCode,
  FINAL_RUN_STATES,
  type RunError,
  type RunEvent,
  RunOutput,
  type RunPrincipal,
  type RunRecord,
  type RunState,
  type TaskSpec,
} from "./schemas.js";
import { type ArchitectStore, type RunPatch, StoreConflictError } from "./store.js";
import type { SubmitOutcome, UpstreamFacade } from "./upstream.js";

export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_MAX_CONSECUTIVE_ABSENT = 3;
/**
 * How long a submission attempt without a stored result is left to the process making it.
 * Longer than a POST /prompt can take, so a run another live process is submitting isn't
 * moved under it; after that the attempt counts as interrupted (OUTCOME_UNKNOWN).
 */
export const DEFAULT_SUBMIT_GRACE_MS = 120_000;

export interface RunControllerDeps {
  store: ArchitectStore;
  upstream: Pick<UpstreamFacade, "submitPrompt" | "queue" | "history" | "dequeue" | "interruptPrompt" | "outputFile">;
  resources: Pick<ResourceCoordinator, "acquire" | "heartbeat" | "release">;
  now: () => Date;
  /** A fresh UUID per submission: the client-chosen prompt ID (ARCH milestone 3). */
  newUuid: () => string;
  /**
   * The run's graph, compiled again from its candidate. The controller compares its
   * fingerprint with the run's, which is the one the grant approved, so a caller that
   * already checked it against the candidate can't hand over a different graph.
   */
  graphFor: (run: RunRecord) => Promise<ApiGraph>;
  /** The task revision the run serves. */
  taskFor: (run: RunRecord) => TaskSpec;
  pollIntervalMs?: number;
  /** Absences from queue and history after which an OUTCOME_UNKNOWN run waits for the user. */
  maxConsecutiveAbsent?: number;
  submitGraceMs?: number;
  /** Where a failure inside the polling loop goes; by default a `note` event on the run. */
  onError?: (err: unknown, runId: string) => void;
}

/** States in which the run holds, or may need, its pool's lease: the render may be live. */
const HOLDING: readonly RunState[] = ["VALIDATING", "QUEUED", "RUNNING", "OUTCOME_UNKNOWN"];
/** Every state but the final ones: what `resumeAll` reconciles. */
const RUN_STATES_NOT_FINAL: readonly RunState[] = [
  "AWAITING_APPROVAL",
  "PREPARING",
  "WAITING_FOR_RESOURCE",
  "VALIDATING",
  "QUEUED",
  "RUNNING",
  "EVALUATING",
  "AWAITING_REVIEW",
  "OUTCOME_UNKNOWN",
];

/** Non-final states the polling loop drives; the other two wait for a person. */
const POLLED: readonly RunState[] = [
  "PREPARING",
  "WAITING_FOR_RESOURCE",
  "VALIDATING",
  "QUEUED",
  "RUNNING",
  "OUTCOME_UNKNOWN",
  "EVALUATING",
];

const AttemptData = z.object({ promptId: z.string().uuid() });
const EvaluatingData = z.object({ unparsedOutputs: z.number().int().nonnegative() });

// ComfyUI's history entry, read as untrusted data: only the fields the outcome rests on.
const HistoryShape = z.object({
  outputs: z.record(z.string(), z.unknown()).optional(),
  status: z
    .object({
      status_str: z.string().optional(),
      completed: z.boolean().optional(),
      messages: z.array(z.tuple([z.string(), z.unknown()])).optional(),
    })
    .optional(),
});
const ExecutionErrorData = z.object({
  node_id: z.union([z.string(), z.number()]).optional(),
  node_type: z.string().optional(),
  exception_type: z.string().optional(),
  exception_message: z.string().optional(),
});
const NodeOutput = z.object({ images: z.array(z.unknown()).optional() });
const ImageRef = z.object({ filename: z.unknown(), subfolder: z.unknown().optional(), type: z.unknown() });

/** What a history entry says happened to the prompt. */
type HistoryOutcome =
  | { kind: "success"; outputs: Record<string, unknown> }
  | { kind: "interrupted" }
  | { kind: "error"; message: string }
  /** An entry that doesn't say: not completed, or a shape this build can't read. */
  | { kind: "unclear"; reason: string };

/** ComfyUI's error text is data (spec §14.4); bounded so a traceback doesn't fill the record. */
function bounded(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function classifyHistory(entry: unknown): HistoryOutcome {
  const parsed = HistoryShape.safeParse(entry);
  if (!parsed.success) return { kind: "unclear", reason: "the history entry has an unexpected shape" };
  const status = parsed.data.status;
  const messages = status?.messages ?? [];
  // ComfyUI marks an interrupted prompt as status "error" too; the message tells them apart.
  if (messages.some(([name]) => name === "execution_interrupted")) return { kind: "interrupted" };
  const failure = messages.find(([name]) => name === "execution_error");
  if (failure || status?.status_str === "error") {
    const data = ExecutionErrorData.safeParse(failure?.[1]);
    const d = data.success ? data.data : {};
    const where = d.node_type ? `${d.node_type}${d.node_id !== undefined ? ` (node ${d.node_id})` : ""}` : "a node";
    const what = d.exception_message ? `${d.exception_type ? `${d.exception_type}: ` : ""}${d.exception_message}` : "no message";
    return { kind: "error", message: bounded(`ComfyUI reported an execution error in ${where}: ${what}`) };
  }
  if (status?.completed === true && status.status_str === "success") return { kind: "success", outputs: parsed.data.outputs ?? {} };
  return { kind: "unclear", reason: `the history entry says completed=${String(status?.completed)}, status ${status?.status_str ?? "absent"}` };
}

/**
 * The image files the effect's output nodes wrote. An entry that can't be represented
 * (no file name, a type other than output or temp) is counted, not dropped, so the output
 * count becomes unknown instead of a short count (#796).
 */
function collectOutputs(outputs: Record<string, unknown>, outputNodes: readonly string[] | undefined): { files: RunOutput[]; unparsed: number } {
  const files: RunOutput[] = [];
  let unparsed = 0;
  for (const [node, value] of Object.entries(outputs)) {
    if (outputNodes && !outputNodes.includes(node)) continue;
    const parsed = NodeOutput.safeParse(value);
    if (!parsed.success) {
      unparsed += 1;
      continue;
    }
    for (const image of parsed.data.images ?? []) {
      const ref = ImageRef.safeParse(image);
      const file = ref.success
        ? RunOutput.safeParse({ node, filename: ref.data.filename, subfolder: ref.data.subfolder ?? "", type: ref.data.type })
        : undefined;
      if (file?.success) files.push(file.data);
      else unparsed += 1;
    }
  }
  return { files, unparsed };
}

function messageOf(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.trim() === "" ? "(no message)" : m;
}

/** An error's stable code when it carries one (PlanningError and its kin), else INTERNAL_ERROR. */
function codeOf(err: unknown): RunError["code"] {
  const code = err !== null && typeof err === "object" && "code" in err ? ArchitectErrorCode.safeParse(err.code) : undefined;
  return code?.success ? code.data : "INTERNAL_ERROR";
}

function lastAttempt(events: readonly RunEvent[]): { promptId: string; at: string } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== "submit_attempt") continue;
    const data = AttemptData.safeParse(e.data);
    if (data.success) return { promptId: data.data.promptId, at: e.at };
  }
  return undefined;
}

function cancelRequested(events: readonly RunEvent[]): boolean {
  return events.some((e) => e.kind === "cancel");
}

/** Absences recorded since the run last changed state: the count survives a restart. */
function absencesSinceTransition(events: readonly RunEvent[]): number {
  let n = 0;
  for (let i = events.length - 1; i >= 0 && events[i].kind !== "transition"; i--) {
    const e = events[i];
    if (e.kind === "reconcile" && e.data?.observation === "absent") n += 1;
  }
  return n;
}

/** Drives runs through spec §15.3's states; see the file comment. */
export class RunController {
  private readonly pollIntervalMs: number;
  private readonly maxAbsent: number;
  private readonly submitGraceMs: number;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly leaseWarned = new Set<string>();
  private readonly lastError = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(private readonly deps: RunControllerDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxAbsent = deps.maxConsecutiveAbsent ?? DEFAULT_MAX_CONSECUTIVE_ABSENT;
    this.submitGraceMs = deps.submitGraceMs ?? DEFAULT_SUBMIT_GRACE_MS;
  }

  /**
   * Drive a run from PREPARING or WAITING_FOR_RESOURCE through submission. It submits at
   * most once per run: a run with a stored attempt is never submitted again (spec §15.4).
   * Runs in other states are returned as they are.
   */
  advance(runId: string): Promise<RunRecord> {
    return this.exclusive(runId, () => this.advanceNow(runId));
  }

  /** One observation of the target; the run moves only when the observation settles something. */
  reconcile(runId: string): Promise<RunRecord> {
    return this.exclusive(runId, () => this.reconcileNow(runId));
  }

  /**
   * Cancel the run's own prompt (spec §14.5, AT-07): a run not yet submitted is cancelled,
   * a pending prompt is dequeued, a running one interrupted by its ID, and the interruption
   * is seen by reconcile. A final run, or one whose render already finished, is returned as
   * it is.
   */
  cancel(runId: string, principal: RunPrincipal): Promise<RunRecord> {
    return this.exclusive(runId, () => this.cancelNow(runId, principal));
  }

  /** Reconcile every non-final run, e.g. after a restart (spec §15.3). */
  async resumeAll(): Promise<RunRecord[]> {
    const out: RunRecord[] = [];
    const active = this.deps.store.listRuns({ states: RUN_STATES_NOT_FINAL });
    for (const run of active) {
      try {
        out.push(await this.reconcile(run.id));
      } catch (err) {
        this.reportError(err, run.id);
        out.push(this.deps.store.getRun(run.id) ?? run);
      }
    }
    return out;
  }

  /** Reconcile active runs every poll interval; the timer doesn't keep the process alive. */
  startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
    this.timer.unref();
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One polling pass: every run the controller drives that no call in this process is
   * already handling, and no OUTCOME_UNKNOWN run that waits for the user.
   */
  async pollOnce(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const run of this.deps.store.listRuns({ states: POLLED })) {
        if (this.locks.has(run.id)) continue;
        if (run.state === "OUTCOME_UNKNOWN" && absencesSinceTransition(this.deps.store.listRunEvents(run.id)) >= this.maxAbsent) continue;
        try {
          await this.reconcile(run.id);
          this.lastError.delete(run.id);
        } catch (err) {
          this.reportError(err, run.id);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  // -------------------------------------------------------------------------------------
  // Submission

  private async advanceNow(runId: string): Promise<RunRecord> {
    const run = this.require(runId);
    if (run.state === "VALIDATING") return this.validateAndSubmit(run);
    if (run.state !== "PREPARING" && run.state !== "WAITING_FOR_RESOURCE") return run;

    const overBudget = this.budgetExceeded(run);
    if (overBudget !== false) {
      return this.move(run, "FAILED", overBudget.reason, { patch: { error: { code: overBudget.code, message: overBudget.reason } } });
    }
    const acquired = await this.deps.resources.acquire(run);
    if (!acquired.ok) {
      if (acquired.retry) {
        // A run already waiting stays as it is: one event when it starts waiting, not one per poll.
        if (run.state === "WAITING_FOR_RESOURCE") return this.require(runId);
        return this.move(run, "WAITING_FOR_RESOURCE", acquired.reason, { data: { code: acquired.code } });
      }
      return this.move(run, "FAILED", acquired.reason, { patch: { error: { code: acquired.code, message: acquired.reason } } });
    }
    const validating = this.move(run, "VALIDATING", `leased ${acquired.lease.pool}`, {
      data: {
        pool: acquired.lease.pool,
        ...(acquired.tookOverFrom ? { tookOverFrom: acquired.tookOverFrom } : {}),
        ...(acquired.unloaded ? { unloadedOllamaModels: acquired.unloaded } : {}),
      },
    });
    return validating.state === "VALIDATING" ? this.validateAndSubmit(validating) : validating;
  }

  private async validateAndSubmit(run: RunRecord): Promise<RunRecord> {
    const { store, upstream, now } = this.deps;
    const events = store.listRunEvents(run.id);
    const attempt = lastAttempt(events);
    if (attempt) {
      // An attempt without a stored result: this or another process stopped during the
      // POST, or another process is in it now. Never submitted again; reconciled by its ID.
      if (now().getTime() - Date.parse(attempt.at) < this.submitGraceMs) return run;
      const reason = `the submission of prompt ${attempt.promptId} has no stored result; reconciling by its ID`;
      const moved = this.move(run, "OUTCOME_UNKNOWN", reason, {
        patch: { promptId: attempt.promptId, error: { code: "OUTCOME_UNKNOWN", message: reason } },
      });
      return moved.state === "OUTCOME_UNKNOWN" && cancelRequested(events) ? this.cancelSubmitted(moved, attempt.promptId, "controller", true) : moved;
    }
    const overBudget = this.budgetExceeded(run);
    if (overBudget !== false) {
      return this.move(run, "FAILED", overBudget.reason, { patch: { error: { code: overBudget.code, message: overBudget.reason } } });
    }

    let graph: ApiGraph;
    try {
      graph = await this.deps.graphFor(run);
    } catch (err) {
      const message = `the graph couldn't be compiled again: ${messageOf(err)}`;
      return this.move(run, "FAILED", message, { patch: { error: { code: codeOf(err), message } } });
    }
    const fingerprint = graphFingerprint(graph);
    if (fingerprint !== run.graphFingerprint) {
      const message = `the graph compiled now (${fingerprint.slice(0, 12)}) isn't the one the grant approved (${run.graphFingerprint.slice(0, 12)})`;
      return this.move(run, "FAILED", message, { patch: { error: { code: "APPROVAL_INVALIDATED", message } } });
    }

    // Read again after the await: another process may have cancelled the run meanwhile.
    // From here to the attempt event nothing awaits, so this process can't interleave.
    const current = this.require(run.id);
    if (current.state !== "VALIDATING") return current;
    const promptId = this.deps.newUuid();
    store.appendRunEvent({
      runId: run.id,
      kind: "submit_attempt",
      principal: "controller",
      reason: `submitting prompt ${promptId} to ${run.target.baseUrl}`,
      data: { promptId },
      at: now(),
    });

    let outcome: SubmitOutcome;
    try {
      outcome = await upstream.submitPrompt(graph, promptId);
    } catch (err) {
      // The facade classifies its outcomes; anything it throws leaves the submission open.
      outcome = { kind: "unknown", message: messageOf(err) };
    }
    store.appendRunEvent({
      runId: run.id,
      kind: "submit_result",
      principal: "controller",
      reason: `ComfyUI's answer: ${outcome.kind}`,
      data:
        outcome.kind === "accepted"
          ? { outcome: "accepted", promptId: outcome.promptId, ...(outcome.rejectedOutputs ? { rejectedOutputs: outcome.rejectedOutputs } : {}) }
          : { outcome: outcome.kind, message: bounded(outcome.message) },
      at: now(),
    });

    const at = now().toISOString();
    let next: RunRecord;
    switch (outcome.kind) {
      case "accepted":
        if (outcome.promptId === promptId) {
          next = this.move(current, "QUEUED", `ComfyUI queued prompt ${promptId}`, { patch: { promptId, timings: { submittedAt: at } } });
        } else {
          // Reconciliation and cancellation key on the ID stored before the POST. A job
          // ComfyUI filed under another ID can't be verified as this run's, so it is never
          // claimed or cancelled automatically; the user decides.
          const message = `ComfyUI accepted the prompt as ${outcome.promptId}, not as the requested ${promptId}`;
          next = this.move(current, "OUTCOME_UNKNOWN", message, {
            patch: { promptId, timings: { submittedAt: at }, error: { code: "OUTCOME_UNKNOWN", message } },
            data: { returnedPromptId: outcome.promptId },
          });
        }
        break;
      case "rejected": {
        // EXECUTION_FAILED for every failure ComfyUI itself answered, at submission or in
        // its history, so a run's error code is always one the result envelope carries.
        const message = bounded(`ComfyUI refused the prompt: ${outcome.message || "(no message)"}`);
        return this.move(current, "FAILED", message, { patch: { error: { code: "EXECUTION_FAILED", message } } });
      }
      case "unknown": {
        // spec §15.4: a lost response is not a failed submission.
        const message = bounded(`whether ComfyUI queued prompt ${promptId} is unknown: ${outcome.message || "(no message)"}`);
        next = this.move(current, "OUTCOME_UNKNOWN", message, { patch: { promptId, error: { code: "OUTCOME_UNKNOWN", message } } });
        break;
      }
    }

    if (next.state === "CANCELLED") {
      // Cancelled by another process while the POST was in flight: the prompt may now be in
      // ComfyUI's queue under this run's ID, so stop it by that ID.
      await this.stopOrphan(next, promptId);
      return this.require(run.id);
    }
    if ((next.state === "QUEUED" || next.state === "OUTCOME_UNKNOWN") && cancelRequested(store.listRunEvents(run.id))) {
      return this.cancelSubmitted(next, promptId, "controller", true);
    }
    return next;
  }

  // -------------------------------------------------------------------------------------
  // Reconciliation

  private async reconcileNow(runId: string): Promise<RunRecord> {
    const run = this.require(runId);
    switch (run.state) {
      case "PREPARING":
      case "WAITING_FOR_RESOURCE":
      case "VALIDATING":
        return this.advanceNow(runId);
      case "QUEUED":
      case "RUNNING":
      case "OUTCOME_UNKNOWN":
        return this.observe(run, true);
      case "EVALUATING":
        return this.evaluate(run);
      default:
        return run;
    }
  }

  /**
   * Observe a submitted run: /queue first, then /history. A read that fails changes
   * nothing and records nothing (#796). `retryCancel` lets a pending cancel request be
   * retried; it is off when the call comes from the cancellation itself.
   */
  private async observe(run: RunRecord, retryCancel: boolean): Promise<RunRecord> {
    const { store, upstream } = this.deps;
    const promptId = this.promptIdOf(run);
    const events = store.listRunEvents(run.id);
    const absences = absencesSinceTransition(events);
    const parked = run.state === "OUTCOME_UNKNOWN" && absences >= this.maxAbsent;
    if (!parked) this.heartbeat(run);
    const cancel = cancelRequested(events);

    if (run.state === "QUEUED" || run.state === "RUNNING") {
      const overBudget = this.budgetExceeded(run);
      if (overBudget !== false) {
        // Undefined: the prompt left the queue before the stop reached it; the history decides.
        const stopped = await this.stopForBudget(run, promptId, overBudget);
        if (stopped !== undefined) return stopped;
      }
    }

    let queue: { running: string[]; pending: string[] };
    try {
      queue = await upstream.queue();
    } catch {
      return this.require(run.id);
    }
    if (queue.pending.includes(promptId)) {
      let next = run;
      if (run.state === "OUTCOME_UNKNOWN") {
        next = this.move(run, "QUEUED", `reconciled: prompt ${promptId} is pending`, { patch: { error: null }, data: { observation: "pending" } });
      }
      if (cancel && retryCancel && next.state === "QUEUED") return this.cancelSubmitted(next, promptId, "controller", false);
      return next;
    }
    if (queue.running.includes(promptId)) {
      let next = run;
      if (run.state !== "RUNNING") {
        next = this.move(run, "RUNNING", `reconciled: prompt ${promptId} is running`, {
          patch: { error: null, timings: { startedAt: run.timings.startedAt ?? this.deps.now().toISOString() } },
          data: { observation: "running" },
        });
      }
      if (cancel && retryCancel && next.state === "RUNNING") await this.interrupt(promptId);
      return next;
    }

    let entry: unknown;
    try {
      entry = await upstream.history(promptId);
    } catch {
      return this.require(run.id);
    }
    if (entry === undefined) return this.absent(run, promptId, absences, parked, cancel);

    const outcome = classifyHistory(entry);
    const finishedAt = this.deps.now().toISOString();
    switch (outcome.kind) {
      case "success": {
        const actionPlan = store.getActionPlan(run.actionPlanId);
        const outputNodes = actionPlan?.effects.flatMap((e) => (e.kind === "local_render" ? e.outputNodes : []));
        const { files, unparsed } = collectOutputs(outcome.outputs, outputNodes);
        const next = this.move(run, "EVALUATING", `ComfyUI completed prompt ${promptId} with ${files.length} image output(s)`, {
          patch: { outputs: files, error: null, timings: { finishedAt } },
          data: { observation: "completed", unparsedOutputs: unparsed },
        });
        return next.state === "EVALUATING" ? this.evaluate(next) : next;
      }
      case "interrupted":
        if (cancel) {
          return this.move(run, "CANCELLED", `ComfyUI interrupted prompt ${promptId} as requested`, {
            patch: { error: null, timings: { finishedAt } },
            data: { observation: "interrupted" },
          });
        }
        return this.move(run, "FAILED", `ComfyUI interrupted prompt ${promptId}, and no cancellation was requested`, {
          patch: {
            timings: { finishedAt },
            error: { code: "EXECUTION_FAILED", message: `prompt ${promptId} was interrupted by something other than Architect` },
          },
          data: { observation: "interrupted" },
        });
      case "error":
        return this.move(run, "FAILED", outcome.message, {
          patch: { timings: { finishedAt }, error: { code: "EXECUTION_FAILED", message: outcome.message } },
          data: { observation: "error" },
        });
      case "unclear":
        // An entry that doesn't say how the prompt ended settles nothing.
        return this.require(run.id);
    }
  }

  /**
   * The prompt is in neither /queue nor /history. A queued or running prompt vanished:
   * that is OUTCOME_UNKNOWN. An OUTCOME_UNKNOWN run stays there and is never submitted
   * again; after `maxConsecutiveAbsent` absences in a row the prompt is taken as not live
   * on the target, so the lease is released and the run waits for the user, or is
   * cancelled when the user already asked for that.
   */
  private absent(run: RunRecord, promptId: string, absences: number, parked: boolean, cancel: boolean): RunRecord {
    const { store, now } = this.deps;
    if (run.state !== "OUTCOME_UNKNOWN") {
      const message = `prompt ${promptId} is in neither ComfyUI's queue nor its history`;
      return this.move(run, "OUTCOME_UNKNOWN", message, {
        patch: { error: { code: "OUTCOME_UNKNOWN", message } },
        data: { observation: "absent" },
      });
    }
    if (parked) {
      return cancel
        ? this.move(run, "CANCELLED", `prompt ${promptId} never appeared on the target, and the run was cancelled`, { patch: { error: null } })
        : run;
    }
    const count = absences + 1;
    const settled = count >= this.maxAbsent;
    store.appendRunEvent({
      runId: run.id,
      kind: "reconcile",
      principal: "controller",
      reason: settled
        ? `prompt ${promptId} was absent from queue and history ${count} times in a row; the lease is released and the run waits for the user (cancel it or prepare a new run)`
        : `prompt ${promptId} is absent from queue and history (${count} of ${this.maxAbsent})`,
      data: { observation: "absent", consecutiveAbsent: count },
      at: now(),
    });
    if (!settled) return this.require(run.id);
    this.deps.resources.release(run);
    if (cancel) {
      return this.move(run, "CANCELLED", `prompt ${promptId} never appeared on the target, and the run was cancelled`, {
        patch: { error: null },
      });
    }
    return this.require(run.id);
  }

  /**
   * Stop a prompt that ran past the grant's wall time (spec §14.2 limits), by its own ID,
   * then fail the run with BUDGET_EXCEEDED. Undefined when the prompt is no longer in the
   * queue, so the caller's observation decides from the history.
   */
  private async stopForBudget(
    run: RunRecord,
    promptId: string,
    why: { code: RunError["code"]; reason: string },
  ): Promise<RunRecord | undefined> {
    const fail = (data: Record<string, unknown>) =>
      this.move(run, "FAILED", why.reason, {
        patch: { error: { code: why.code, message: why.reason }, timings: { finishedAt: this.deps.now().toISOString() } },
        data,
      });
    if (run.state === "QUEUED") {
      let result: Awaited<ReturnType<UpstreamFacade["dequeue"]>>;
      try {
        result = await this.deps.upstream.dequeue(promptId);
      } catch {
        return this.require(run.id); // retried on the next observation
      }
      if (result.state === "removed") return fail({ dequeue: result });
      if (result.state === "pending") return this.require(run.id);
      if (result.state === "absent") return undefined;
    }
    if (!(await this.interrupt(promptId))) return this.require(run.id);
    return fail({ interrupted: promptId });
  }

  // -------------------------------------------------------------------------------------
  // Cancellation

  private async cancelNow(runId: string, principal: RunPrincipal): Promise<RunRecord> {
    const run = this.require(runId);
    // A final run, or one whose render is done, has nothing left to cancel.
    if (FINAL_RUN_STATES.includes(run.state) || run.state === "EVALUATING" || run.state === "AWAITING_REVIEW") return run;
    this.deps.store.appendRunEvent({
      runId,
      kind: "cancel",
      principal,
      reason: `cancellation requested by the ${principal}`,
      at: this.deps.now(),
    });
    switch (run.state) {
      case "AWAITING_APPROVAL":
      case "PREPARING":
      case "WAITING_FOR_RESOURCE":
        return this.move(run, "CANCELLED", `cancelled by the ${principal} before submission`, { principal });
      case "VALIDATING":
        if (!lastAttempt(this.deps.store.listRunEvents(runId))) {
          return this.move(run, "CANCELLED", `cancelled by the ${principal} before submission`, { principal });
        }
        // A submission is in flight or was interrupted: whoever settles it sees the cancel
        // event and stops the prompt by its ID.
        return run;
      case "QUEUED":
      case "OUTCOME_UNKNOWN":
        return this.cancelSubmitted(run, this.promptIdOf(run), principal, false);
      case "RUNNING":
        await this.interrupt(this.promptIdOf(run));
        return this.require(runId);
      default:
        return run;
    }
  }

  /**
   * Dequeue the run's prompt; interrupt it by ID when it is already running. A prompt in
   * neither place is observed once more, since it may have finished. A failed dequeue
   * changes nothing; the recorded cancel request is retried by the next observation.
   */
  private async cancelSubmitted(run: RunRecord, promptId: string, principal: RunPrincipal, observeAfter: boolean): Promise<RunRecord> {
    let result: Awaited<ReturnType<UpstreamFacade["dequeue"]>>;
    try {
      result = await this.deps.upstream.dequeue(promptId);
    } catch {
      return this.require(run.id);
    }
    switch (result.state) {
      case "removed":
        return this.move(run, "CANCELLED", `prompt ${promptId} removed from ComfyUI's queue`, {
          principal,
          patch: { error: null },
          data: { dequeue: result },
        });
      case "running": {
        const next =
          run.state === "RUNNING"
            ? run
            : this.move(run, "RUNNING", `prompt ${promptId} is running; interrupting it`, {
                patch: { error: null, timings: { startedAt: run.timings.startedAt ?? this.deps.now().toISOString() } },
                data: { observation: "running" },
              });
        await this.interrupt(promptId);
        return next.state === "RUNNING" ? this.require(run.id) : next;
      }
      case "absent":
        return this.observe(run, false);
      case "pending":
        return observeAfter ? this.observe(run, false) : this.require(run.id);
    }
  }

  /** Interrupt by the run's own prompt ID; ComfyUI ignores it unless that prompt is running. */
  private async interrupt(promptId: string): Promise<boolean> {
    try {
      await this.deps.upstream.interruptPrompt(promptId);
      return true;
    } catch {
      return false; // retried on the next observation while the cancel request stands
    }
  }

  /** Stop a prompt submitted for a run that was cancelled while the POST was in flight. */
  private async stopOrphan(run: RunRecord, promptId: string): Promise<void> {
    let note: string;
    try {
      const result = await this.deps.upstream.dequeue(promptId);
      if (result.state === "running") {
        note = (await this.interrupt(promptId)) ? `prompt ${promptId} was running; interrupted it` : `prompt ${promptId} is running; the interrupt failed`;
      } else {
        note = `prompt ${promptId}: ${result.state}`;
      }
    } catch (err) {
      note = `prompt ${promptId} couldn't be dequeued: ${messageOf(err)}`;
    }
    this.deps.store.appendRunEvent({
      runId: run.id,
      kind: "note",
      principal: "controller",
      reason: `the run was cancelled during submission; ${note}`,
      data: { promptId },
      at: this.deps.now(),
    });
  }

  // -------------------------------------------------------------------------------------
  // Evaluation

  /**
   * Fetch and probe every output, store the automatic checks and finish the run:
   * AWAITING_REVIEW when the task asks for the user's review, COMPLETED otherwise. Records
   * stored by an earlier attempt are kept, so a restart during evaluation doesn't write
   * a second set.
   */
  private async evaluate(run: RunRecord): Promise<RunRecord> {
    const { store, upstream, now } = this.deps;
    let task: TaskSpec;
    try {
      task = this.deps.taskFor(run);
    } catch (err) {
      store.appendRunEvent({
        runId: run.id,
        kind: "note",
        principal: "controller",
        reason: `the automatic checks didn't run: ${messageOf(err)}`,
        at: now(),
      });
      return this.move(run, "COMPLETED", "ComfyUI finished; acceptance stays pending without the task", { patch: { acceptance: "pending" } });
    }

    const events = store.listRunEvents(run.id);
    const entered = [...events].reverse().find((e) => e.kind === "transition" && e.to === "EVALUATING");
    const parsed = EvaluatingData.safeParse(entered?.data);
    const unparsedOutputs = parsed.success ? parsed.data.unparsedOutputs : 0;

    const files: ProbedOutput[] = [];
    for (const ref of run.outputs) {
      try {
        const { bytes } = await upstream.outputFile({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type });
        files.push({ ref, probe: probeMedia(bytes) });
      } catch (err) {
        files.push({ ref, probe: { readable: false, fetched: false, reason: `couldn't fetch the file: ${messageOf(err)}` } });
      }
    }
    const stored = new Set(store.listEvaluations(run.id).map((e) => e.id));
    for (const input of evaluateOutputs({ run, task, files, unparsedOutputs, at: now() })) {
      if (!stored.has(input.id)) store.putEvaluation(input);
    }
    const acceptance = acceptanceFrom(task, store.listEvaluations(run.id));
    const review = needsUserReview(task);
    return this.move(run, review ? "AWAITING_REVIEW" : "COMPLETED", review ? `automatic checks done (${acceptance}); waiting for the user's review` : `automatic checks done: ${acceptance}`, {
      patch: { acceptance },
    });
  }

  // -------------------------------------------------------------------------------------
  // Helpers

  /**
   * A compare-and-set transition from the run's state as read. When another actor moved the
   * run first, the stored run is returned instead (spec §15.3). A run that ends up outside
   * the holding states gives back its lease.
   */
  private move(
    run: RunRecord,
    to: RunState,
    reason: string,
    opts: { principal?: RunPrincipal; patch?: RunPatch; data?: Record<string, unknown> } = {},
  ): RunRecord {
    let next: RunRecord;
    try {
      next = this.deps.store.transitionRun({
        runId: run.id,
        from: run.state,
        to,
        principal: opts.principal ?? "controller",
        reason,
        ...(opts.patch ? { patch: opts.patch } : {}),
        ...(opts.data ? { data: opts.data } : {}),
        at: this.deps.now(),
      }).run;
    } catch (err) {
      if (!(err instanceof StoreConflictError)) throw err;
      next = this.require(run.id);
    }
    if (!HOLDING.includes(next.state)) this.deps.resources.release(next);
    return next;
  }

  private heartbeat(run: RunRecord): void {
    const beat = this.deps.resources.heartbeat(run);
    if (beat.held) {
      this.leaseWarned.delete(run.id);
      return;
    }
    if (this.leaseWarned.has(run.id)) return;
    this.leaseWarned.add(run.id);
    this.deps.store.appendRunEvent({
      runId: run.id,
      kind: "note",
      principal: "controller",
      reason: `the run's prompt may be live, but its lease isn't held: ${beat.reason}`,
      at: this.deps.now(),
    });
  }

  /** False, or why the run is past the wall time its grant allows from its start. */
  private budgetExceeded(run: RunRecord): false | { code: "BUDGET_EXCEEDED" | "APPROVAL_INVALIDATED"; reason: string } {
    const grant = run.grantId === undefined ? undefined : this.deps.store.getGrant(run.grantId);
    if (!grant) return { code: "APPROVAL_INVALIDATED", reason: `run ${run.id} has no stored grant, so its limits are unknown` };
    const seconds = grant.limits.maxWallTimeSeconds;
    const deadline = Date.parse(run.createdAt) + seconds * 1000;
    if (this.deps.now().getTime() < deadline) return false;
    return { code: "BUDGET_EXCEEDED", reason: `the run passed the ${seconds} s of wall time grant ${grant.id} allows from ${run.createdAt}` };
  }

  private promptIdOf(run: RunRecord): string {
    // RunRecord's schema requires it in every submitted state.
    if (run.promptId === undefined) throw new Error(`run ${run.id} is ${run.state} without a prompt ID`);
    return run.promptId;
  }

  private require(runId: string): RunRecord {
    const run = this.deps.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} is not stored`);
    return run;
  }

  /** Calls on one run take turns in this process; across processes the store's CAS decides. */
  private exclusive<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(runId);
    const result = (async () => {
      if (previous) await previous;
      return fn();
    })();
    // The marker settles either way; the result, with its error, goes to the caller.
    const marker = result.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(runId, marker);
    void marker.then(() => {
      if (this.locks.get(runId) === marker) this.locks.delete(runId);
    });
    return result;
  }

  private reportError(err: unknown, runId: string): void {
    if (this.deps.onError) {
      this.deps.onError(err, runId);
      return;
    }
    const message = messageOf(err);
    if (this.lastError.get(runId) === message) return;
    this.lastError.set(runId, message);
    try {
      this.deps.store.appendRunEvent({
        runId,
        kind: "note",
        principal: "controller",
        reason: bounded(`reconciliation failed: ${message}`),
        at: this.deps.now(),
      });
    } catch {
      // The store itself failed; the next pass tries again, and the run is unchanged.
    }
  }
}

