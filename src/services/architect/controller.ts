// The durable run controller (spec §15.3, §15.4, §14.5; TODO 3.5.2, 3.5.3, AT-06, AT-07).
//
// A run is created by `createRunWithGrant` in PREPARING. From there the controller leases
// the memory pool, compiles the graph again, claims the run's one submission attempt with a
// fresh client-chosen prompt ID and only then POSTs, so a lost response can be reconciled
// by that ID against /queue and /history instead of being submitted again. The claim is a
// compare-and-set in the store, so of two processes on one database only one POSTs. Every
// state change
// is a compare-and-set transition in the store, written with its event before anyone hears
// of it; a run that another actor moved in the meantime is re-read and returned, never
// overwritten.
//
// The store is the source of truth, not this object: a new controller on the same store
// (after a restart, or in the panel agent's server) picks up every non-final run.
// Cancellation touches only the run's own prompt ID, by dequeue or by an interrupt with that
// ID. ComfyUI honours the ID in /interrupt only from 0.3.57; an older one stops whatever
// runs. So the queue is read right before every interrupt, and the interrupt is sent only
// while the run's prompt is the one running. Nothing here clears the queue.
//
// A run whose action plan acquires model files (TODO 4.5) does so in PREPARING, before it
// leases the pool: each advance or poll moves the downloads one step (acquisition.ts) and
// returns, so no call waits for a download. Once every file is placed, the candidate must be
// feasible on a fresh snapshot before the run goes on (ARCH 2026-11-16, after acquisition).
// The wall time of the grant counts from the run's creation, so it covers the downloads.
//
// Ollama models a run's acquisition unloaded, with the user's approval, are loaded back
// once the render is over (GAPS Q23): when the run leaves the states in which the render
// may be live, or when its prompt is taken as not live on the target. The reload runs
// beside the run and never changes its state or acceptance.

import { z } from "zod";
import type { ModelAcquirer } from "./acquisition.js";
import { graphFingerprint } from "./compile.js";
import { type DecodeResult, acceptanceFrom, evaluateOutputs, needsUserReview, type ProbedOutput } from "./evaluation.js";
import { type MediaProbe, probeMedia } from "./media-probe.js";
import { type AttemptView, SEED_CHANGEABLE_CRITERIA, type StopRule, applySteps, buildRevision, chainStopOf, nextAttempt } from "./repair.js";
import { type ResourceCoordinator, residencyRestored, unloadedForRun } from "./resources.js";
import {
  type AcquireModelsEffect,
  type ActionPlan,
  type ApiGraph,
  type ApprovalGrant,
  ArchitectErrorCode,
  type ExecutionErrorDetail,
  FINAL_RUN_STATES,
  type GraphRevision,
  type LocalRenderEffect,
  type RunError,
  type RunEvent,
  RunOutput,
  type RunPrincipal,
  type RunRecord,
  type RunState,
  StoredRecordError,
  type TaskSpec,
  actionPlanHash,
} from "./schemas.js";
import { type ArchitectStore, type RunPatch, StoreConflictError } from "./store.js";
import { ImageDecoderUnavailableError, type SubmitOutcome, type UpstreamFacade } from "./upstream.js";

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
  upstream: Pick<
    UpstreamFacade,
    "submitPrompt" | "queue" | "history" | "dequeue" | "interruptPrompt" | "outputFile" | "decodeImage"
  >;
  resources: Pick<ResourceCoordinator, "acquire" | "heartbeat" | "release" | "restore">;
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
  /**
   * Check the run against a fresh environment snapshot before it is submitted. Called only
   * for a run that waited in WAITING_FOR_RESOURCE, since the target may have changed while
   * it waited. A throw fails the run with the error's code, as a `graphFor` error does.
   */
  revalidate?: (run: RunRecord) => Promise<void>;
  /**
   * Acquires the model files of a run whose action plan has an `acquire_models` effect.
   * Without it such a run fails in PREPARING; nothing is downloaded.
   */
  acquirer?: Pick<ModelAcquirer, "step" | "stop" | "forgetNodeSchemas">;
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

/** States after which an attempt's chain decides what follows (ARCH 2026-11-16, milestone 6). */
const ATTEMPT_ENDED: readonly RunState[] = ["FAILED", "COMPLETED", "CANCELLED", "AWAITING_REVIEW"];
/** Passes of one chain decision; each creates at most one attempt, and the grant bounds them first. */
const MAX_CHAIN_PASSES = 16;

/** Whether the root records that its chain stopped. */
function chainStopped(events: readonly RunEvent[]): boolean {
  return chainStopOf(events) !== undefined;
}

/** A child attempt: a run the controller created under its root's grant. */
function isLaterAttempt(run: RunRecord): boolean {
  return run.attempt !== undefined && run.attempt.rootRunId !== run.id;
}
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
const NodeOutput = z.record(z.string(), z.unknown());
/** Keys of a node's output that carry flags beside its images, not files (SaveAnimatedWEBP's `animated`). */
const OUTPUT_FLAG_KEYS: readonly string[] = ["animated"];
const ImageRef = z.object({ filename: z.unknown(), subfolder: z.unknown().optional(), type: z.unknown() });

/** What a history entry says happened to the prompt. */
type HistoryOutcome =
  | { kind: "success"; outputs: Record<string, unknown> }
  | { kind: "interrupted" }
  | { kind: "error"; message: string; detail?: ExecutionErrorDetail }
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
    // The fields the repair classifies on (TODO 6.1.1), each bounded: ComfyUI's text is data.
    const detail: ExecutionErrorDetail = {
      ...(d.node_id !== undefined ? { nodeId: String(d.node_id).slice(0, 64) } : {}),
      ...(d.node_type !== undefined ? { nodeType: d.node_type.slice(0, 200) } : {}),
      ...(d.exception_type !== undefined ? { exceptionType: d.exception_type.slice(0, 200) } : {}),
      ...(d.exception_message !== undefined ? { exceptionMessage: bounded(d.exception_message) } : {}),
    };
    return {
      kind: "error",
      message: bounded(`ComfyUI reported an execution error in ${where}: ${what}`),
      ...(Object.keys(detail).length > 0 ? { detail } : {}),
    };
  }
  if (status?.completed === true && status.status_str === "success") return { kind: "success", outputs: parsed.data.outputs ?? {} };
  return { kind: "unclear", reason: `the history entry says completed=${String(status?.completed)}, status ${status?.status_str ?? "absent"}` };
}

/**
 * The image files the effect's output nodes wrote. An entry that can't be represented
 * (no file name, a type other than output or temp) is counted, not dropped, and so is every
 * entry under a key other than `images` (`gifs`, `audio`, `video`, …), which this
 * milestone doesn't read: the output count becomes unknown instead of a short count (#796).
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
    const images: unknown[] = [];
    for (const [key, entries] of Object.entries(parsed.data)) {
      if (OUTPUT_FLAG_KEYS.includes(key)) continue;
      if (!Array.isArray(entries)) unparsed += 1;
      else if (key === "images") images.push(...entries);
      else unparsed += entries.length;
    }
    for (const image of images) {
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
  /** Reloads of unloaded Ollama models in flight, by run; `settled` waits for them. */
  private readonly restoring = new Map<string, Promise<void>>();
  /** Roots whose next step couldn't be decided (an error, or found at resume); the poller retries them. */
  private readonly pendingChains = new Set<string>();
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
    return this.exclusive(runId, () => this.advanceNow(runId)).then((run) => this.afterAttempt(run));
  }

  /**
   * Advance a run in the background (a run that downloads first, TODO 4.5): the caller
   * returns at once, a failure is reported like a polling error, and the poller continues
   * the run. Nothing stacks: the poller skips a run while this call holds its turn.
   */
  schedule(runId: string): void {
    void this.advance(runId).catch((err: unknown) => this.reportError(err, runId));
  }

  /** Whether a call on the run is in progress in this process. */
  busy(runId: string): boolean {
    return this.locks.has(runId);
  }

  /** One observation of the target; the run moves only when the observation settles something. */
  reconcile(runId: string): Promise<RunRecord> {
    return this.exclusive(runId, () => this.reconcileNow(runId)).then((run) => this.afterAttempt(run));
  }

  /**
   * Cancel the run's own prompt (spec §14.5, AT-07): a run not yet submitted is cancelled,
   * a pending prompt is dequeued, a running one interrupted by its ID, and the interruption
   * is seen by reconcile. A final run, or one whose render already finished, is returned as
   * it is.
   */
  cancel(runId: string, principal: RunPrincipal): Promise<RunRecord> {
    return this.exclusive(runId, () => this.cancelNow(runId, principal)).then((run) => this.afterAttempt(run));
  }

  /**
   * Reconcile every non-final run, e.g. after a restart (spec §15.3), then load back the
   * Ollama models of runs whose render is over but whose reload never happened: the process
   * stopped between the two. The reloads run beside the result; `settled` waits for them.
   */
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
    for (const run of this.deps.store.listRuns()) {
      if (HOLDING.includes(run.state)) continue;
      const events = this.deps.store.listRunEvents(run.id);
      if (unloadedForRun(events) && !residencyRestored(events)) this.restoreResidency(run);
      // A chain whose last attempt finished while no process decided what follows: the
      // process stopped between the two (ARCH 2026-11-16, milestone 6, attempts).
      if (run.attempt?.index === 1 && !chainStopped(events)) this.pendingChains.add(run.id);
    }
    await this.retryPendingChains();
    return out;
  }

  /** Resolves when every reload of unloaded Ollama models this controller started is done. */
  async settled(): Promise<void> {
    while (this.restoring.size > 0) await Promise.all([...this.restoring.values()]);
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
      await this.retryPendingChains();
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
    // A later attempt takes no downloads: the root acquired what the grant approved (ARCH 2026-11-16).
    const acquire = run.state === "PREPARING" && !isLaterAttempt(run) ? this.acquireEffectOf(run) : undefined;
    if (overBudget !== false) {
      // Downloads still running are the run's own and stop with it.
      if (acquire && this.deps.acquirer) await this.deps.acquirer.stop(run, { failed: { code: overBudget.code, message: overBudget.reason } });
      return this.move(run, "FAILED", overBudget.reason, { patch: { error: { code: overBudget.code, message: overBudget.reason } } });
    }
    if (acquire) {
      const ready = await this.acquireModels(run, acquire);
      if (ready !== true) return ready;
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
        // What `restore` loads back after the render (GAPS Q23).
        ...(acquired.unloaded ? { unloadedOllamaModels: acquired.unloaded, ollamaHost: acquired.ollamaHost } : {}),
      },
    });
    return validating.state === "VALIDATING" ? this.validateAndSubmit(validating) : validating;
  }

  /** The run's approved downloads, when its action plan has them. */
  private acquireEffectOf(run: RunRecord): AcquireModelsEffect | undefined {
    return this.deps.store.getActionPlan(run.actionPlanId)?.effects.find((e): e is AcquireModelsEffect => e.kind === "acquire_models");
  }

  /**
   * One step of the run's downloads. True once every file is placed and the candidate is
   * feasible on a fresh snapshot; otherwise the run as it stands (still PREPARING while
   * downloads run, FAILED when one failed or the recheck refused the candidate).
   */
  private async acquireModels(run: RunRecord, effect: AcquireModelsEffect): Promise<RunRecord | true> {
    const fail = (code: RunError["code"], message: string) => this.move(run, "FAILED", message, { patch: { error: { code, message } } });
    const { acquirer, revalidate } = this.deps;
    if (!acquirer) return fail("INTERNAL_ERROR", "this server can't acquire model files; nothing was downloaded");
    // The downloads are the approved ones only if the grant the run consumed binds this
    // action plan's hash as stored now (spec §14.2); the store checks it again when it
    // creates the acquisitions.
    const actionPlan = this.deps.store.getActionPlan(run.actionPlanId);
    const grant = run.grantId === undefined ? undefined : this.deps.store.getGrant(run.grantId);
    if (!actionPlan || !grant || grant.actionPlanId !== actionPlan.id || grant.actionPlanHash !== actionPlanHash(actionPlan)) {
      if (this.deps.store.listAcquisitions(run.id).length > 0) await acquirer.stop(run, { failed: { code: "APPROVAL_INVALIDATED", message: "the run's grant doesn't bind its action plan" } });
      return fail("APPROVAL_INVALIDATED", `run ${run.id}'s grant doesn't bind its action plan as stored; nothing more is downloaded`);
    }
    const progress = await acquirer.step(run, effect);
    const current = this.require(run.id);
    // Cancelled or moved by another actor during the step: theirs to finish.
    if (current.state !== "PREPARING") return current;
    if (progress.kind === "in_progress") return current;
    if (progress.kind === "failed") return fail(progress.error.code, `acquisition failed: ${progress.error.message}`);
    // The cached node schemas predate the placement; the snapshot must see the new files.
    acquirer.forgetNodeSchemas();
    if (!revalidate) return fail("INTERNAL_ERROR", "the placed files can't be checked against a fresh snapshot here");
    try {
      await revalidate(current);
    } catch (err) {
      return fail(codeOf(err), `the files were placed, but the candidate isn't feasible on a fresh snapshot: ${messageOf(err)}`);
    }
    this.deps.store.appendRunEvent({
      runId: run.id,
      kind: "note",
      principal: "controller",
      reason: `acquired ${progress.records.length} model file(s); the candidate is feasible on a fresh snapshot`,
      data: { acquired: progress.records.map((r) => ({ file: `${r.folder}/${r.file}`, placedPath: r.placedPath, sha256: r.observedSha256 })) },
      at: this.deps.now(),
    });
    return true;
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
    // An attempt that renders a revision submits the approved graph with the revision's steps
    // applied in order, and only when that gives the fingerprint the revision recorded (ARCH
    // 2026-11-16, milestone 6, attempts): a stored step list that changed can't reach ComfyUI.
    const revisionId = run.attempt?.revisionId;
    if (revisionId !== undefined) {
      const revision = store.getGraphRevision(revisionId);
      const refuse = (message: string) => this.move(run, "FAILED", message, { patch: { error: { code: "APPROVAL_INVALIDATED", message } } });
      if (!revision || revision.rootRunId !== run.attempt?.rootRunId || revision.baseFingerprint !== run.graphFingerprint) {
        return refuse(`run ${run.id}'s graph revision ${revisionId} isn't stored for its chain`);
      }
      try {
        graph = applySteps(graph, revision.steps);
      } catch (err) {
        return refuse(`revision ${revisionId} doesn't apply to the approved graph: ${messageOf(err)}`);
      }
      const revised = graphFingerprint(graph);
      if (revised !== revision.fingerprint) {
        return refuse(`revision ${revisionId} gives graph ${revised.slice(0, 12)}, not the recorded ${revision.fingerprint.slice(0, 12)}`);
      }
    }
    // A run that waited for the pool was checked against the environment of its start; the
    // target may have changed since, so it is checked again before the POST (spec §15.3).
    const waited = events.some((e) => e.kind === "transition" && e.to === "WAITING_FOR_RESOURCE");
    if (waited && this.deps.revalidate) {
      try {
        await this.deps.revalidate(run);
      } catch (err) {
        const message = `the run no longer validates against a fresh snapshot: ${messageOf(err)}`;
        return this.move(run, "FAILED", message, { patch: { error: { code: codeOf(err), message } } });
      }
    }

    // spec §15.4: one submission per run. The claim checks state and attempt under the
    // store's write lock and writes the attempt, so of two processes that both got here
    // (two servers resuming one VALIDATING run, or a poll racing an advance) one POSTs. The
    // loser, or a run another process cancelled during the awaits above, is returned as stored.
    const promptId = this.deps.newUuid();
    const claim = store.claimSubmission({ runId: run.id, promptId, at: now() });
    if (!claim.won) return this.require(run.id);
    const current = this.require(run.id);

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
      if (cancel && retryCancel && next.state === "RUNNING") await this.interruptIfRunning(next, promptId);
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
          patch: { timings: { finishedAt }, error: { code: "EXECUTION_FAILED", message: outcome.message, ...(outcome.detail ? { detail: outcome.detail } : {}) } },
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
    // The prompt is taken as not live, so the pool is given back with what was unloaded.
    this.restoreResidency(run);
    if (cancel) {
      return this.move(run, "CANCELLED", `prompt ${promptId} never appeared on the target, and the run was cancelled`, {
        patch: { error: null },
      });
    }
    return this.require(run.id);
  }

  /**
   * Stop a prompt that ran past the grant's wall time (spec §14.2 limits), by its own ID,
   * then fail the run with BUDGET_EXCEEDED: dequeue it, and interrupt it when the dequeue
   * finds it running. Undefined when the prompt is in neither place, so the caller's
   * observation decides from the history.
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
    // A RUNNING run is dequeued too: the dequeue reads /queue first, so a prompt that is
    // pending, running or gone is told apart before anything is sent.
    let result: Awaited<ReturnType<UpstreamFacade["dequeue"]>>;
    try {
      result = await this.deps.upstream.dequeue(promptId);
    } catch {
      return this.require(run.id); // retried on the next observation
    }
    if (result.state === "removed") return fail({ dequeue: result });
    if (result.state === "pending") return this.require(run.id);
    if (result.state === "absent") return undefined;
    const interrupted = await this.interruptIfRunning(run, promptId);
    if (interrupted === "interrupted") return fail({ interrupted: promptId });
    // It left the running slot between the two reads: the history decides.
    if (interrupted === "not_running") return undefined;
    return this.require(run.id);
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
      case "PREPARING":
        // The run's own downloads stop first, by the job ids on its acquisitions; staged
        // files go with them (spec §14.5: nothing that isn't the run's is touched).
        if (!isLaterAttempt(run) && this.acquireEffectOf(run) && this.deps.acquirer) await this.deps.acquirer.stop(run, "cancelled");
        return this.move(this.require(runId), "CANCELLED", `cancelled by the ${principal} before submission`, { principal });
      case "AWAITING_APPROVAL":
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
      case "RUNNING": {
        const promptId = this.promptIdOf(run);
        // Not running any more: it finished, was interrupted or vanished, which the
        // observation reads from the history. The cancel event is stored, so an
        // interruption is seen as the cancellation.
        if ((await this.interruptIfRunning(run, promptId)) === "not_running") return this.observe(this.require(runId), false);
        return this.require(runId);
      }
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
        if (next.state === "RUNNING") await this.interruptIfRunning(next, promptId);
        return next.state === "RUNNING" ? this.require(run.id) : next;
      }
      case "absent":
        return this.observe(run, false);
      case "pending":
        return observeAfter ? this.observe(run, false) : this.require(run.id);
    }
  }

  /**
   * Interrupt the run's own prompt, only while /queue, read right before, shows it as the
   * one prompt running. ComfyUI before 0.3.57 ignores the ID and stops whatever runs, so an
   * interrupt sent while another job runs, or without having looked, could stop a job that
   * isn't Architect's (spec §14.5). The version gate is admission's; this check holds on any
   * version. A queue that can't be read, or a running slot shared with another prompt,
   * sends nothing and leaves a note; the stored cancel request or budget retries it on the
   * next observation.
   */
  private async interruptIfRunning(run: RunRecord, promptId: string): Promise<"interrupted" | "not_running" | "not_sent"> {
    const note = (reason: string) => {
      // A cancel request is retried on every poll; one note per distinct reason, not one per poll.
      const last = this.deps.store.listRunEvents(run.id).at(-1);
      if (last?.kind === "note" && last.reason === reason) return;
      this.deps.store.appendRunEvent({ runId: run.id, kind: "note", principal: "controller", reason, data: { promptId }, at: this.deps.now() });
    };
    let queue: { running: string[]; pending: string[] };
    try {
      queue = await this.deps.upstream.queue();
    } catch (err) {
      note(bounded(`didn't interrupt prompt ${promptId}: /queue couldn't be read to confirm it is the one running (${messageOf(err)})`));
      return "not_sent";
    }
    if (!queue.running.includes(promptId)) return "not_running";
    if (queue.running.some((id) => id !== promptId)) {
      note(`didn't interrupt prompt ${promptId}: another prompt is running beside it, and an interrupt might stop that one`);
      return "not_sent";
    }
    try {
      await this.deps.upstream.interruptPrompt(promptId);
      return "interrupted";
    } catch (err) {
      note(bounded(`the interrupt of prompt ${promptId} failed: ${messageOf(err)}`));
      return "not_sent";
    }
  }

  /** Stop a prompt submitted for a run that was cancelled while the POST was in flight. */
  private async stopOrphan(run: RunRecord, promptId: string): Promise<void> {
    let note: string;
    try {
      const result = await this.deps.upstream.dequeue(promptId);
      if (result.state === "running") {
        const interrupted = await this.interruptIfRunning(run, promptId);
        note =
          interrupted === "interrupted"
            ? `prompt ${promptId} was running; interrupted it`
            : interrupted === "not_running"
              ? `prompt ${promptId} was running and isn't any more`
              : `prompt ${promptId} is running and wasn't interrupted`;
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
      let bytes: Buffer;
      try {
        ({ bytes } = await upstream.outputFile({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type }));
      } catch (err) {
        const reason = `couldn't fetch the file: ${messageOf(err)}`;
        files.push({ ref, probe: { readable: false, fetched: false, reason }, decode: { state: "not_attempted", reason } });
        continue;
      }
      const probe = probeMedia(bytes);
      files.push({ ref, probe, decode: await this.decode(bytes, probe) });
    }
    const stored = new Set(store.listEvaluations(run.id).map((e) => e.id));
    for (const input of evaluateOutputs({ run, task, files, unparsedOutputs, at: now() })) {
      if (!stored.has(input.id)) store.putEvaluation(input);
    }
    // A smoke attempt is judged on the built-in checks only and never waits for a review:
    // it shows the path executes, not that the task is met (spec §13.1; TODO 6.2.1).
    const smoke = run.attempt?.stage === "smoke";
    const acceptance = acceptanceFrom(smoke ? { ...task, acceptance: [] } : task, store.listEvaluations(run.id));
    const review = !smoke && needsUserReview(task);
    return this.move(run, review ? "AWAITING_REVIEW" : "COMPLETED", review ? `automatic checks done (${acceptance}); waiting for the user's review` : `automatic checks done: ${acceptance}`, {
      patch: { acceptance },
    });
  }

  /**
   * Decode the whole image (spec §13.2 readability): a header can parse over data that is
   * truncated or corrupt. A decoder that can't be loaded observes nothing about the file.
   */
  private async decode(bytes: Buffer, probe: MediaProbe): Promise<DecodeResult> {
    if (!probe.readable) return { state: "not_attempted", reason: "the header couldn't be read" };
    try {
      const { width, height } = await this.deps.upstream.decodeImage(bytes);
      return { state: "decoded", width, height };
    } catch (err) {
      if (err instanceof ImageDecoderUnavailableError) return { state: "not_attempted", reason: messageOf(err) };
      return { state: "failed", reason: bounded(messageOf(err), 500) };
    }
  }

  // -------------------------------------------------------------------------------------
  // Attempts under one grant (spec §13.4; ARCH 2026-11-16, milestone 6, attempts)

  /**
   * After a call on an attempt: when it ended (FAILED, COMPLETED, CANCELLED or waiting for
   * review), decide what follows in its chain. The call's own result is returned either way;
   * a decision that fails is retried by the poller.
   */
  private async afterAttempt(run: RunRecord): Promise<RunRecord> {
    if (!run.attempt || !ATTEMPT_ENDED.includes(run.state)) return run;
    try {
      await this.continueChain(run.attempt.rootRunId);
    } catch (err) {
      this.pendingChains.add(run.attempt.rootRunId);
      this.reportError(err, run.attempt.rootRunId);
    }
    return run;
  }

  private async retryPendingChains(): Promise<void> {
    for (const rootId of [...this.pendingChains]) {
      this.pendingChains.delete(rootId);
      try {
        await this.continueChain(rootId);
      } catch (err) {
        this.pendingChains.add(rootId);
        this.reportError(err, rootId);
      }
    }
  }

  /**
   * Decide and carry out what follows the chain's last attempt, until an attempt is in
   * flight or the chain stops: a final after a passed smoke, a repair within the grant, or a
   * stop recorded on the root with its rule and result. The child is created only through
   * the store's admission transaction; the store refuses what the grant doesn't cover, and a
   * refusal stops the chain. Calls on one chain take turns.
   */
  private continueChain(rootId: string): Promise<void> {
    return this.exclusive(`chain:${rootId}`, async () => {
      // Each pass creates at most one attempt; the grant's run limit bounds the passes.
      for (let pass = 0; pass < MAX_CHAIN_PASSES; pass++) {
        const step = await this.decide(rootId);
        if (step === undefined) return;
        const child = await this.exclusive(step.id, () => this.advanceNow(step.id));
        if (!ATTEMPT_ENDED.includes(child.state)) return;
      }
    });
  }

  /** One decision: the attempt to advance next, or undefined when nothing is to be done now. */
  private async decide(rootId: string): Promise<RunRecord | undefined> {
    const { store, now } = this.deps;
    const root = store.getRun(rootId);
    if (!root?.attempt || root.attempt.rootRunId !== root.id) return undefined;
    const rootEvents = store.listRunEvents(root.id);
    if (chainStopped(rootEvents)) return undefined;
    const attempts = store.listAttempts(root.id);
    const last = attempts.at(-1);
    if (!last?.attempt) return undefined;
    // A created attempt that hasn't left PREPARING (the process stopped after creating it) is advanced.
    if (last.id !== root.id && last.state === "PREPARING") return last;
    if (!ATTEMPT_ENDED.includes(last.state)) return undefined;

    let actionPlan: ActionPlan | undefined;
    let grant: ApprovalGrant | undefined;
    try {
      actionPlan = store.getActionPlan(root.actionPlanId);
      grant = root.grantId === undefined ? undefined : store.getGrant(root.grantId);
    } catch (err) {
      // An action plan or grant edited since it was stored doesn't parse: nothing more runs under it.
      if (!(err instanceof StoredRecordError)) throw err;
      this.stopChain(root, { rule: "refused", reason: `the root's action plan or grant doesn't read back: ${err.message}` }, attempts);
      return undefined;
    }
    const render = actionPlan?.effects.find((e): e is LocalRenderEffect => e.kind === "local_render");
    if (!actionPlan || !grant || !render) {
      this.stopChain(root, { rule: "refused", reason: "the root's action plan or grant is not stored" }, attempts);
      return undefined;
    }
    const task = this.deps.taskFor(root);
    const views = attempts.map((a) => this.attemptView(a, task));
    const lastView = views[views.length - 1];
    // Only a failure the decision could repair needs the graph the last attempt rendered.
    let approved: ApiGraph | undefined;
    const graphOfLast = async (): Promise<ApiGraph> => {
      approved = await this.deps.graphFor(root);
      if (graphFingerprint(approved) !== root.graphFingerprint) throw new Error(`the graph compiled now isn't the one grant ${grant.id} approved`);
      return applySteps(approved, lastView.steps);
    };
    const needsGraph = last.state === "FAILED" || (last.state === "COMPLETED" && lastView.qualityFailure !== undefined);
    const decision = nextAttempt({
      attempts: views,
      repair: render.repair?.transformations ?? [],
      limits: grant.limits,
      deadlinePassed: now().getTime() >= Date.parse(root.createdAt) + grant.limits.maxWallTimeSeconds * 1000,
      cancelRequested: cancelRequested(rootEvents) || cancelRequested(store.listRunEvents(last.id)),
      lastGraph: needsGraph ? await graphOfLast() : {},
    });
    if (decision.kind === "wait") return undefined;
    if (decision.kind === "stop") {
      this.stopChain(root, decision, attempts);
      return undefined;
    }

    if (!approved) approved = await this.deps.graphFor(root);
    const at = now();
    const index = last.attempt.index + 1;
    let revision: GraphRevision | undefined;
    if (decision.steps.length > 0) {
      try {
        revision = buildRevision({
          id: `grev-${this.deps.newUuid()}`,
          rootRunId: root.id,
          actionPlanId: actionPlan.id,
          candidateId: root.candidateId,
          approved,
          approvedFingerprint: render.graphFingerprint,
          ...(last.attempt.revisionId ? { parentRevisionId: last.attempt.revisionId } : {}),
          steps: decision.steps,
          at,
        }).revision;
      } catch (err) {
        this.stopChain(root, { rule: "no_applicable_transformation", reason: `the next revision doesn't apply: ${messageOf(err)}` }, attempts);
        return undefined;
      }
    }
    const childId = `run-${this.deps.newUuid()}`;
    let created: { run: RunRecord; created: boolean };
    try {
      created = store.createChildAttempt({
        run: {
          schemaVersion: 1,
          id: childId,
          actionPlanId: root.actionPlanId,
          planId: root.planId,
          taskId: root.taskId,
          taskRevision: root.taskRevision,
          candidateId: root.candidateId,
          graphFingerprint: root.graphFingerprint,
          target: root.target,
          idempotencyKey: `${root.idempotencyKey}#${index}`,
          state: "PREPARING",
          ...(root.grantId ? { grantId: root.grantId } : {}),
          attempt: {
            rootRunId: root.id,
            index,
            stage: decision.stage,
            repairRound: decision.repairRound,
            ...(revision ? { revisionId: revision.id } : {}),
          },
          createdAt: at.toISOString(),
          updatedAt: at.toISOString(),
        },
        predecessorRunId: last.id,
        ...(revision ? { revision } : {}),
        now: at,
        reason: `attempt ${index} (${decision.stage}${decision.repairRound > 0 ? `, repair round ${decision.repairRound}` : ""}) under grant ${grant.id}: ${decision.reason}`,
      });
    } catch (err) {
      // A conflict, or a stored record that no longer parses (an edited action plan): no attempt.
      if (!(err instanceof StoreConflictError) && !(err instanceof StoredRecordError)) throw err;
      this.stopChain(root, { rule: "refused", reason: `the next attempt was refused: ${err.message}` }, attempts);
      return undefined;
    }
    store.appendRunEvent({
      runId: root.id,
      kind: "note",
      principal: "controller",
      reason: bounded(`attempt ${index} follows attempt ${last.attempt.index}: ${decision.reason}`),
      data: { chain: "attempt", attempt: index, runId: created.run.id, stage: decision.stage, repairRound: decision.repairRound, ...(revision ? { revisionId: revision.id } : {}) },
      at,
    });
    return created.run;
  }

  /** The decision's view of one attempt. */
  private attemptView(run: RunRecord, task: TaskSpec): AttemptView {
    const { store } = this.deps;
    const attempt = run.attempt;
    if (!attempt) throw new Error(`run ${run.id} isn't an attempt`);
    const steps = attempt.revisionId === undefined ? [] : (store.getGraphRevision(attempt.revisionId)?.steps ?? []);
    let qualityFailure: AttemptView["qualityFailure"];
    if (attempt.stage === "final" && run.state === "COMPLETED" && run.acceptance === "failed") {
      const failing = [...new Set(store.listEvaluations(run.id).filter((e) => e.verdict === "fail" && e.source !== "agent_reported").map((e) => e.criterionId))];
      const kinds = failing.map((id) => task.acceptance.find((c) => c.id === id)?.kind);
      // A seed can change the outcome only if every failure is of a kind it can change.
      const seedChangeable = kinds.length > 0 && kinds.every((k) => k !== undefined && SEED_CHANGEABLE_CRITERIA.includes(k));
      qualityFailure = { criteria: failing, seedChangeable };
    }
    return {
      runId: run.id,
      index: attempt.index,
      stage: attempt.stage,
      repairRound: attempt.repairRound,
      state: run.state,
      acceptance: run.acceptance,
      steps,
      ...(run.error ? { error: run.error } : {}),
      submitted: store.listRunEvents(run.id).some((e) => e.kind === "submit_attempt"),
      ...(qualityFailure ? { qualityFailure } : {}),
    };
  }

  /** Record on the root that the chain stopped, with the rule and the result (once). */
  private stopChain(root: RunRecord, stop: { rule: StopRule; reason: string; resultRunId?: string }, attempts: readonly RunRecord[]): void {
    if (chainStopped(this.deps.store.listRunEvents(root.id))) return;
    this.deps.store.appendRunEvent({
      runId: root.id,
      kind: "note",
      principal: "controller",
      reason: bounded(`the attempts stopped: ${stop.reason}`),
      data: { chain: "stopped", rule: stop.rule, attempts: attempts.length, ...(stop.resultRunId ? { resultRunId: stop.resultRunId } : {}) },
      at: this.deps.now(),
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
    if (!HOLDING.includes(next.state)) {
      this.deps.resources.release(next);
      // The render is over, so the Ollama models unloaded for it go back. A run that never
      // held the pool unloaded nothing; one another actor moved first is covered too.
      if (HOLDING.includes(run.state)) this.restoreResidency(next);
    }
    return next;
  }

  /**
   * Start loading back the Ollama models the run's acquisition unloaded, once per run in
   * this process. `move` is synchronous, so the reload is tracked here instead of awaited;
   * a rejection (the store failed) goes where polling errors go.
   */
  private restoreResidency(run: RunRecord): void {
    if (this.restoring.has(run.id)) return;
    const work = this.deps.resources
      .restore(run)
      .catch((err: unknown) => this.reportError(err, run.id))
      .finally(() => this.restoring.delete(run.id));
    this.restoring.set(run.id, work);
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
    // spec §13.4: the deadline runs from the approved operation's start, the root's, and
    // covers every attempt under the grant.
    let start = run.createdAt;
    if (run.attempt && run.attempt.rootRunId !== run.id) {
      const root = this.deps.store.getRun(run.attempt.rootRunId);
      if (!root) return { code: "APPROVAL_INVALIDATED", reason: `run ${run.id}'s root ${run.attempt.rootRunId} is not stored, so its deadline is unknown` };
      start = root.createdAt;
    }
    const deadline = Date.parse(start) + seconds * 1000;
    if (this.deps.now().getTime() < deadline) return false;
    return { code: "BUDGET_EXCEEDED", reason: `the run passed the ${seconds} s of wall time grant ${grant.id} allows from ${start}` };
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

