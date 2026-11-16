import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireInputsUnchanged } from "../../services/architect/admission.js";
import { RunController, type RunControllerDeps } from "../../services/architect/controller.js";
import { sha256Hex } from "../../services/architect/hash.js";
import { type FetchLike, ResourceCoordinator, memoryPool } from "../../services/architect/resources.js";
import type { ApiGraph, RunRecord, TaskSpec } from "../../services/architect/schemas.js";
import { ArchitectStore } from "../../services/architect/store.js";
import { ImageDecoderUnavailableError, type SubmitOutcome, createUpstreamFacade } from "../../services/architect/upstream.js";
import sharp from "sharp";
import { BASE_URL } from "./fixtures/execution-records.js";
import { FakeOllama, GRAPH, RUN_CREATED, type SeedOptions, releaseOf, seedRun } from "./fixtures/run-harness.js";

type HistoryEntry = NonNullable<Awaited<ReturnType<RunControllerDeps["upstream"]["history"]>>>;

const OUR_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_PENDING = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_RUNNING = "aaaaaaaa-0000-4000-8000-000000000002";
const POOL = memoryPool(BASE_URL);

/** A real PNG, which the facade's sharp decode reads whole. */
function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 180, g: 20, b: 20 } } }).png().toBuffer();
}

/** The facade's decode, sharp itself: the fake ComfyUI serves files, it doesn't judge them. */
const { decodeImage } = createUpstreamFacade();

/**
 * ComfyUI as the controller sees it through the facade. It has no way to clear the queue
 * or to interrupt without an ID, so a controller that tried couldn't compile against it.
 */
class FakeComfy {
  pending: string[] = [];
  running: string[] = [];
  history = new Map<string, HistoryEntry>();
  files = new Map<string, Buffer>();
  submitted: string[] = [];
  dequeued: string[] = [];
  interrupted: string[] = [];
  /** Prompts an interrupt actually stopped. */
  stopped: string[] = [];
  queueReads = 0;
  queueFails = false;
  historyFails = false;
  /** ComfyUI before 0.3.57: /interrupt ignores the prompt ID and stops whatever runs. */
  globalInterrupt = false;
  /** sharp can't be loaded in this process. */
  decoderMissing = false;
  /** How long a POST /prompt takes to answer, so two processes can overlap in it. */
  submitDelayMs = 0;
  /** What a POST answers; by default ComfyUI queues the prompt under the requested ID. */
  onSubmit: (promptId: string) => SubmitOutcome = (id) => {
    this.pending.push(id);
    return { kind: "accepted", promptId: id };
  };

  facade(): RunControllerDeps["upstream"] {
    return {
      submitPrompt: async (_graph, promptId) => {
        this.submitted.push(promptId);
        if (this.submitDelayMs > 0) await sleep(this.submitDelayMs);
        return this.onSubmit(promptId);
      },
      queue: async () => {
        this.queueReads += 1;
        if (this.queueFails) throw new Error("/queue answered 502");
        return { running: [...this.running], pending: [...this.pending] };
      },
      history: async (promptId) => {
        if (this.historyFails) throw new Error("/history timed out");
        return this.history.get(promptId);
      },
      dequeue: async (promptId) => {
        this.dequeued.push(promptId);
        if (this.running.includes(promptId)) return { removed: false, state: "running", verified: true };
        if (!this.pending.includes(promptId)) return { removed: false, state: "absent", verified: true };
        this.pending = this.pending.filter((p) => p !== promptId);
        return { removed: true, state: "removed", verified: true };
      },
      interruptPrompt: async (promptId) => {
        this.interrupted.push(promptId);
        // ComfyUI stops the running prompt only when it has this ID; an old one stops any.
        const victim = this.running[0];
        if (victim !== undefined && (this.globalInterrupt || victim === promptId)) {
          this.running = [];
          this.stopped.push(victim);
          this.history.set(victim, {
            prompt: {},
            outputs: {},
            status: { status_str: "error", completed: false, messages: [["execution_interrupted", { prompt_id: victim }]] },
          });
        }
      },
      outputFile: async (ref) => {
        const bytes = this.files.get(ref.filename);
        if (!bytes) throw new Error(`/view ${ref.filename}: 404`);
        return { bytes, mimeType: "image/png" };
      },
      decodeImage: (bytes) => (this.decoderMissing ? Promise.reject(new ImageDecoderUnavailableError("sharp is switched off")) : decodeImage(bytes)),
    };
  }

  start(promptId: string): void {
    this.pending = this.pending.filter((p) => p !== promptId);
    this.running = [promptId];
  }

  finish(promptId: string, images: { filename: string }[] = [{ filename: "architect_00001_.png" }]): void {
    this.running = this.running.filter((p) => p !== promptId);
    this.pending = this.pending.filter((p) => p !== promptId);
    this.history.set(promptId, {
      prompt: {},
      outputs: { "2": { images: images.map((i) => ({ ...i, subfolder: "", type: "output" })) } },
      status: { status_str: "success", completed: true, messages: [["execution_success", {}]] },
    });
  }

  fail(promptId: string): void {
    this.running = [];
    this.history.set(promptId, {
      prompt: {},
      outputs: {},
      status: {
        status_str: "error",
        completed: false,
        messages: [["execution_error", { node_id: "1", node_type: "KSampler", exception_type: "RuntimeError", exception_message: "CUDA out of memory" }]],
      },
    });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const refused: FetchLike = async () => {
  throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
};

let dir: string;
let clock: Date;
const stores: ArchitectStore[] = [];

function openStore(): ArchitectStore {
  const s = ArchitectStore.open(dir, { now: () => clock });
  stores.push(s);
  return s;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "architect-controller-"));
  clock = new Date(RUN_CREATED);
});

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  store: ArchitectStore;
  comfy: FakeComfy;
  controller: RunController;
  run: RunRecord;
}

function harness(
  opts: {
    task?: Record<string, unknown>;
    fetchImpl?: FetchLike;
    ollama?: FakeOllama;
    release?: ReturnType<typeof releaseOf>;
    /** Replaces the coordinator's reload of unloaded Ollama models. */
    restore?: RunControllerDeps["resources"]["restore"];
    onError?: RunControllerDeps["onError"];
    manageResidency?: boolean;
    ownerId?: string;
    graph?: ApiGraph;
    comfy?: FakeComfy;
    store?: ArchitectStore;
    seed?: boolean;
    maxWallTimeSeconds?: number;
    uuids?: string[];
    graphDelayMs?: number;
    revalidate?: RunControllerDeps["revalidate"];
    inputs?: SeedOptions["inputs"];
  } = {},
): Harness {
  const store = opts.store ?? openStore();
  const run =
    opts.seed === false
      ? undefined
      : seedRun(store, { task: opts.task, maxWallTimeSeconds: opts.maxWallTimeSeconds, release: opts.release, ...(opts.inputs ? { inputs: opts.inputs } : {}) });
  const comfy = opts.comfy ?? new FakeComfy();
  const now = () => new Date(clock);
  const uuids = [...(opts.uuids ?? [OUR_ID])];
  const ollama = opts.ollama ?? new FakeOllama();
  const coordinator = new ResourceCoordinator({
    store,
    upstream: ollama.facade(),
    ownerId: opts.ownerId ?? "instance-a",
    now,
    manageResidency: opts.manageResidency ?? false,
    fetchImpl: opts.fetchImpl ?? (opts.ollama ? ollama.fetch : refused),
    probeTimeoutMs: 20,
  });
  const resources: RunControllerDeps["resources"] = opts.restore
    ? {
        acquire: (r) => coordinator.acquire(r),
        heartbeat: (r) => coordinator.heartbeat(r),
        release: (r) => coordinator.release(r),
        restore: opts.restore,
      }
    : coordinator;
  const controller = new RunController({
    store,
    upstream: comfy.facade(),
    resources,
    now,
    newUuid: () => {
      const next = uuids.shift();
      if (!next) throw new Error("the test ran out of UUIDs: a second submission?");
      return next;
    },
    graphFor: async () => {
      if (opts.graphDelayMs) await sleep(opts.graphDelayMs);
      return opts.graph ?? GRAPH;
    },
    ...(opts.revalidate ? { revalidate: opts.revalidate } : {}),
    ...(opts.onError ? { onError: opts.onError } : {}),
    taskFor: (r): TaskSpec => {
      const t = store.getTask(r.taskId, r.taskRevision);
      if (!t) throw new Error("task missing");
      return t;
    },
  });
  return { store, comfy, controller, run: run ?? store.listRuns()[0] };
}

const kinds = (store: ArchitectStore, runId: string) => store.listRunEvents(runId).map((e) => (e.kind === "transition" ? `→${e.to}` : e.kind));
const later = (seconds: number) => (clock = new Date(clock.getTime() + seconds * 1000));

describe("submission", () => {
  it("stores the attempt with the prompt ID before the POST, then queues and completes with evaluations", async () => {
    const h = harness();
    h.comfy.onSubmit = (id) => {
      // The attempt is on disk while the request is in flight.
      const attempt = h.store.listRunEvents(h.run.id).find((e) => e.kind === "submit_attempt");
      expect(attempt?.data).toEqual({ promptId: id });
      expect(h.store.getRun(h.run.id)?.state).toBe("VALIDATING");
      h.comfy.pending.push(id);
      return { kind: "accepted", promptId: id };
    };
    const queued = await h.controller.advance(h.run.id);
    expect(queued).toMatchObject({ state: "QUEUED", promptId: OUR_ID });
    expect(queued.timings.submittedAt).toBe(clock.toISOString());
    expect(h.store.getLease(POOL)).toMatchObject({ ownerId: "instance-a", runId: h.run.id });

    h.comfy.start(OUR_ID);
    later(5);
    expect((await h.controller.reconcile(h.run.id)).state).toBe("RUNNING");
    h.comfy.finish(OUR_ID);
    h.comfy.files.set("architect_00001_.png", await png(1024, 1024));
    later(5);
    const done = await h.controller.reconcile(h.run.id);
    expect(done).toMatchObject({ state: "COMPLETED", acceptance: "passed" });
    expect(done.outputs).toEqual([{ node: "2", filename: "architect_00001_.png", subfolder: "", type: "output" }]);
    expect(done.timings.startedAt).toBeDefined();
    expect(done.timings.finishedAt).toBeDefined();

    const evals = h.store.listEvaluations(h.run.id);
    expect(evals.map((e) => [e.criterionId, e.verdict]).sort()).toEqual([
      ["output_count", "pass"],
      ["output_dimensions", "pass"],
      ["output_format", "pass"],
      ["output_readable", "pass"],
      ["run_completion", "pass"],
    ]);
    expect(kinds(h.store, h.run.id)).toEqual([
      "→PREPARING",
      "→VALIDATING",
      "submit_attempt",
      "submit_result",
      "→QUEUED",
      "→RUNNING",
      "→EVALUATING",
      "→COMPLETED",
    ]);
    expect(h.comfy.submitted).toEqual([OUR_ID]);
    expect(h.store.getLease(POOL)).toBeUndefined();
  });

  it("waits for the user's review when the task asks for one, and records failed checks as failed", async () => {
    const h = harness({ task: { acceptance: [{ id: "looks-right", kind: "user_review", required: true, rubric: "A red bicycle?" }] } });
    await h.controller.advance(h.run.id);
    h.comfy.finish(OUR_ID, [{ filename: "small.png" }]);
    h.comfy.files.set("small.png", await png(512, 512));
    const r = await h.controller.reconcile(h.run.id);
    expect(r).toMatchObject({ state: "AWAITING_REVIEW", acceptance: "failed" });
    expect(h.store.listEvaluations(h.run.id).find((e) => e.criterionId === "output_dimensions")?.verdict).toBe("fail");
    expect(h.store.listEvaluations(h.run.id).some((e) => e.criterionId === "looks-right")).toBe(false);
  });

  it("keeps acceptance pending when an output can't be fetched", async () => {
    const h = harness();
    await h.controller.advance(h.run.id);
    h.comfy.finish(OUR_ID);
    const r = await h.controller.reconcile(h.run.id);
    expect(r).toMatchObject({ state: "COMPLETED", acceptance: "pending" });
    expect(h.store.listEvaluations(h.run.id).find((e) => e.criterionId === "output_readable")?.verdict).toBe("unknown");
  });

  it("fails a run ComfyUI refused, and releases the lease", async () => {
    const h = harness();
    h.comfy.onSubmit = () => ({ kind: "rejected", message: "Prompt outputs failed validation: KSampler missing model" });
    const r = await h.controller.advance(h.run.id);
    expect(r.state).toBe("FAILED");
    expect(r.error).toMatchObject({ code: "EXECUTION_FAILED" });
    expect(r.error?.message).toMatch(/KSampler missing model/);
    expect(h.store.getLease(POOL)).toBeUndefined();
    expect(h.comfy.submitted).toHaveLength(1);
  });

  it("fails a run whose ComfyUI execution failed, with ComfyUI's message", async () => {
    const h = harness();
    await h.controller.advance(h.run.id);
    h.comfy.start(OUR_ID);
    h.comfy.fail(OUR_ID);
    const r = await h.controller.reconcile(h.run.id);
    expect(r).toMatchObject({ state: "FAILED", error: { code: "EXECUTION_FAILED" } });
    expect(r.error?.message).toMatch(/KSampler.*CUDA out of memory/);
  });

  it("refuses a graph other than the one the grant approved, before any POST", async () => {
    const h = harness({ graph: { ...GRAPH, "3": { class_type: "PreviewImage", inputs: { images: ["1", 0] } } } });
    const r = await h.controller.advance(h.run.id);
    expect(r).toMatchObject({ state: "FAILED", error: { code: "APPROVAL_INVALIDATED" } });
    expect(h.comfy.submitted).toEqual([]);
    expect(h.store.getLease(POOL)).toBeUndefined();
  });

  it("enters OUTCOME_UNKNOWN when ComfyUI files the prompt under another ID", async () => {
    const h = harness();
    h.comfy.onSubmit = () => ({ kind: "accepted", promptId: OTHER_PENDING });
    const r = await h.controller.advance(h.run.id);
    expect(r).toMatchObject({ state: "OUTCOME_UNKNOWN", promptId: OUR_ID, error: { code: "OUTCOME_UNKNOWN" } });
    const last = h.store.listRunEvents(h.run.id).at(-1);
    expect(last?.data).toEqual({ returnedPromptId: OTHER_PENDING });
  });
});

describe("a lost response (AT-06)", () => {
  it("enters OUTCOME_UNKNOWN and reconciles to QUEUED when the prompt turns out pending", async () => {
    const h = harness();
    h.comfy.onSubmit = (id) => {
      h.comfy.pending.push(id); // ComfyUI got it; the answer was lost
      return { kind: "unknown", message: "socket hang up" };
    };
    const unknown = await h.controller.advance(h.run.id);
    expect(unknown).toMatchObject({ state: "OUTCOME_UNKNOWN", promptId: OUR_ID, error: { code: "OUTCOME_UNKNOWN" } });
    expect(h.store.getLease(POOL)?.runId).toBe(h.run.id);
    const queued = await h.controller.reconcile(h.run.id);
    expect(queued.state).toBe("QUEUED");
    expect(queued.error).toBeUndefined();
    expect(h.comfy.submitted).toEqual([OUR_ID]);
  });

  it("treats a facade that throws like a lost response", async () => {
    const h = harness();
    h.comfy.onSubmit = () => {
      throw new Error("ECONNRESET");
    };
    expect((await h.controller.advance(h.run.id)).state).toBe("OUTCOME_UNKNOWN");
  });

  it("stays OUTCOME_UNKNOWN while the prompt is absent, never resubmits, and stops polling after the limit", async () => {
    const h = harness();
    h.comfy.onSubmit = () => ({ kind: "unknown", message: "timeout" });
    await h.controller.advance(h.run.id);
    for (let i = 0; i < 6; i++) {
      later(2);
      expect((await h.controller.reconcile(h.run.id)).state).toBe("OUTCOME_UNKNOWN");
    }
    const absences = h.store.listRunEvents(h.run.id).filter((e) => e.kind === "reconcile");
    expect(absences.map((e) => e.data?.consecutiveAbsent)).toEqual([1, 2, 3]);
    // Absent three times in a row: not live on the target, so the pool is free again.
    expect(h.store.getLease(POOL)).toBeUndefined();
    const reads = h.comfy.queueReads;
    await h.controller.pollOnce();
    expect(h.comfy.queueReads).toBe(reads);
    expect(h.comfy.submitted).toEqual([OUR_ID]);
    // The user decides: a cancel now settles it, touching only the run's own prompt ID.
    expect((await h.controller.cancel(h.run.id, "user")).state).toBe("CANCELLED");
    expect(h.comfy.dequeued).toEqual([OUR_ID]);
    expect(h.comfy.interrupted).toEqual([]);
  });

  it("doesn't POST again for a run with a stored attempt, before or after a restart", async () => {
    const h = harness();
    await h.controller.advance(h.run.id);
    expect(await h.controller.advance(h.run.id)).toMatchObject({ state: "QUEUED" });
    expect(h.comfy.submitted).toEqual([OUR_ID]);

    // A process that stopped between the attempt and the answer: VALIDATING with an attempt.
    const dir2 = mkdtempSync(join(tmpdir(), "architect-controller-crash-"));
    const crashed = ArchitectStore.open(dir2, { now: () => clock });
    stores.push(crashed);
    const run = seedRun(crashed);
    crashed.transitionRun({ runId: run.id, from: "PREPARING", to: "VALIDATING", principal: "controller", reason: "leased", at: clock });
    expect(crashed.claimSubmission({ runId: run.id, promptId: OUR_ID, at: clock }).won).toBe(true);
    const after = harness({ store: crashed, seed: false, uuids: [] });
    expect((await after.controller.advance(run.id)).state).toBe("VALIDATING"); // inside the grace period
    later(121);
    const r = await after.controller.reconcile(run.id);
    expect(r).toMatchObject({ state: "OUTCOME_UNKNOWN", promptId: OUR_ID });
    expect(after.comfy.submitted).toEqual([]);
    rmSync(dir2, { recursive: true, force: true });
  });

  it("changes nothing and records nothing when /queue or /history can't be read", async () => {
    const h = harness();
    await h.controller.advance(h.run.id);
    const before = h.store.listRunEvents(h.run.id).length;
    h.comfy.queueFails = true;
    expect((await h.controller.reconcile(h.run.id)).state).toBe("QUEUED");
    h.comfy.queueFails = false;
    h.comfy.pending = [];
    h.comfy.historyFails = true;
    expect((await h.controller.reconcile(h.run.id)).state).toBe("QUEUED");
    expect(h.store.listRunEvents(h.run.id)).toHaveLength(before);
  });

  it("moves a queued prompt that vanished from queue and history to OUTCOME_UNKNOWN", async () => {
    const h = harness();
    await h.controller.advance(h.run.id);
    h.comfy.pending = [];
    expect(await h.controller.reconcile(h.run.id)).toMatchObject({ state: "OUTCOME_UNKNOWN", error: { code: "OUTCOME_UNKNOWN" } });
    expect(h.comfy.submitted).toEqual([OUR_ID]);
  });
});

describe("cancellation of the run's own prompt only (AT-07)", () => {
  it("dequeues only its own pending prompt while unrelated jobs are pending and running", async () => {
    const h = harness();
    h.comfy.running = [OTHER_RUNNING];
    h.comfy.pending = [OTHER_PENDING];
    await h.controller.advance(h.run.id);
    expect(h.comfy.pending).toEqual([OTHER_PENDING, OUR_ID]);
    const r = await h.controller.cancel(h.run.id, "user");
    expect(r.state).toBe("CANCELLED");
    expect(h.comfy.dequeued).toEqual([OUR_ID]);
    expect(h.comfy.interrupted).toEqual([]);
    expect(h.comfy.pending).toEqual([OTHER_PENDING]);
    expect(h.comfy.running).toEqual([OTHER_RUNNING]);
    expect(h.store.getLease(POOL)).toBeUndefined();
    const facade = h.comfy.facade();
    expect(Object.keys(facade).some((k) => /clear|free|interruptAll/i.test(k))).toBe(false);
  });

  it("interrupts its running prompt by ID and sees the interruption as CANCELLED", async () => {
    const h = harness();
    h.comfy.pending = [OTHER_PENDING];
    await h.controller.advance(h.run.id);
    h.comfy.start(OUR_ID);
    await h.controller.reconcile(h.run.id);
    const r = await h.controller.cancel(h.run.id, "user");
    expect(r.state).toBe("RUNNING");
    expect(h.comfy.interrupted).toEqual([OUR_ID]);
    const done = await h.controller.reconcile(h.run.id);
    expect(done.state).toBe("CANCELLED");
    expect(h.comfy.pending).toEqual([OTHER_PENDING]);
    expect([...h.comfy.dequeued, ...h.comfy.interrupted].every((id) => id === OUR_ID)).toBe(true);
  });

  it("never stops an unrelated running job, even when the stored state is stale", async () => {
    const h = harness();
    await h.controller.advance(h.run.id);
    h.comfy.start(OUR_ID);
    await h.controller.reconcile(h.run.id);
    // ComfyUI has moved on to another job; the run still reads RUNNING.
    h.comfy.running = [OTHER_RUNNING];
    h.comfy.finish(OUR_ID);
    h.comfy.running = [OTHER_RUNNING];
    h.comfy.globalInterrupt = true;
    const r = await h.controller.cancel(h.run.id, "user");
    // The queue read before the interrupt shows another prompt running: nothing is sent,
    // and the history says the run's own prompt finished.
    expect(h.comfy.interrupted).toEqual([]);
    expect(h.comfy.running).toEqual([OTHER_RUNNING]);
    expect(r.state).toBe("COMPLETED");
  });

  it("cancels a run that isn't submitted yet without touching ComfyUI", async () => {
    const h = harness();
    const r = await h.controller.cancel(h.run.id, "user");
    expect(r.state).toBe("CANCELLED");
    expect([...h.comfy.submitted, ...h.comfy.dequeued, ...h.comfy.interrupted]).toEqual([]);
    expect(await h.controller.cancel(h.run.id, "user")).toMatchObject({ state: "CANCELLED" });
    expect(h.store.listRunEvents(h.run.id).filter((e) => e.kind === "cancel")).toHaveLength(1);
  });

  it("calls an interruption nobody asked for a failure", async () => {
    const h = harness();
    await h.controller.advance(h.run.id);
    h.comfy.start(OUR_ID);
    await h.comfy.facade().interruptPrompt(OUR_ID);
    const r = await h.controller.reconcile(h.run.id);
    expect(r).toMatchObject({ state: "FAILED", error: { code: "EXECUTION_FAILED" } });
  });

  it("stops the prompt of a run another process cancelled while the POST was in flight", async () => {
    const h = harness();
    const other = openStore();
    h.comfy.onSubmit = (id) => {
      other.transitionRun({ runId: h.run.id, from: "VALIDATING", to: "CANCELLED", principal: "user", reason: "cancelled elsewhere", at: clock });
      h.comfy.pending.push(id);
      return { kind: "accepted", promptId: id };
    };
    const r = await h.controller.advance(h.run.id);
    expect(r.state).toBe("CANCELLED");
    expect(h.comfy.dequeued).toEqual([OUR_ID]);
    expect(h.comfy.pending).toEqual([]);
    expect(h.store.getLease(POOL)).toBeUndefined();
  });
});

describe("one submission per run across processes (spec §15.4)", () => {
  const SECOND_ID = "bbbbbbbb-0000-4000-8000-000000000002";

  it("POSTs once when another process's poll reaches the run while this one compiles", async () => {
    const comfy = new FakeComfy();
    comfy.submitDelayMs = 50;
    const a = harness({ comfy, graphDelayMs: 20 });
    const b = harness({ comfy, store: openStore(), seed: false, ownerId: "instance-b", uuids: [SECOND_ID], graphDelayMs: 20 });
    const advancing = a.controller.advance(a.run.id);
    await sleep(5); // a has moved the run to VALIDATING and compiles its graph
    const polled = b.controller.reconcile(a.run.id);
    await Promise.all([advancing, polled]);
    expect(comfy.submitted).toHaveLength(1);
    const attempts = a.store.listRunEvents(a.run.id).filter((e) => e.kind === "submit_attempt");
    expect(attempts.map((e) => e.data)).toEqual([{ promptId: comfy.submitted[0] }]);
    expect(a.store.getRun(a.run.id)).toMatchObject({ state: "QUEUED", promptId: comfy.submitted[0] });
  });

  it("POSTs once when two restarted servers resume the same VALIDATING run", async () => {
    const comfy = new FakeComfy();
    comfy.submitDelayMs = 50;
    const a = harness({ comfy, ownerId: "instance-a" });
    // The process that leased the pool stopped before it claimed the submission.
    a.store.transitionRun({ runId: a.run.id, from: "PREPARING", to: "VALIDATING", principal: "controller", reason: "leased", at: clock });
    const b = harness({ comfy, store: openStore(), seed: false, ownerId: "instance-b", uuids: [SECOND_ID] });
    const [ra, rb] = await Promise.all([a.controller.resumeAll(), b.controller.resumeAll()]);
    expect(comfy.submitted).toHaveLength(1);
    // The loser returns the run as stored, without a second attempt.
    expect([ra[0].state, rb[0].state].sort()).toEqual(["QUEUED", "VALIDATING"]);
    expect(a.store.listRunEvents(a.run.id).filter((e) => e.kind === "submit_attempt")).toHaveLength(1);
    expect(a.store.getRun(a.run.id)?.state).toBe("QUEUED");
  });
});

describe("interrupting on a ComfyUI that ignores the prompt ID (before 0.3.57)", () => {
  it("doesn't interrupt for a budget stop while another prompt runs", async () => {
    const h = harness({ maxWallTimeSeconds: 120 });
    h.comfy.globalInterrupt = true;
    await h.controller.advance(h.run.id);
    h.comfy.start(OUR_ID);
    await h.controller.reconcile(h.run.id);
    // The run's prompt left the queue unseen; an unrelated job runs now.
    h.comfy.running = [OTHER_RUNNING];
    later(61);
    const r = await h.controller.reconcile(h.run.id);
    expect(h.comfy.interrupted).toEqual([]);
    expect(h.comfy.stopped).toEqual([]);
    expect(h.comfy.running).toEqual([OTHER_RUNNING]);
    // In neither queue nor history: the outcome is unknown, not a budget failure.
    expect(r.state).toBe("OUTCOME_UNKNOWN");
  });

  it("interrupts for a budget stop when its own prompt is the one running", async () => {
    const h = harness({ maxWallTimeSeconds: 120 });
    h.comfy.globalInterrupt = true;
    await h.controller.advance(h.run.id);
    h.comfy.start(OUR_ID);
    await h.controller.reconcile(h.run.id);
    later(61);
    expect(await h.controller.reconcile(h.run.id)).toMatchObject({ state: "FAILED", error: { code: "BUDGET_EXCEEDED" } });
    expect(h.comfy.stopped).toEqual([OUR_ID]);
  });

  it("sends no interrupt when /queue can't be read right before it, records why and leaves the state", async () => {
    const h = harness();
    h.comfy.globalInterrupt = true;
    await h.controller.advance(h.run.id);
    h.comfy.start(OUR_ID);
    await h.controller.reconcile(h.run.id);
    h.comfy.queueFails = true;
    const r = await h.controller.cancel(h.run.id, "user");
    expect(r.state).toBe("RUNNING");
    expect(h.comfy.interrupted).toEqual([]);
    const note = h.store.listRunEvents(h.run.id).at(-1);
    expect(note).toMatchObject({ kind: "note", data: { promptId: OUR_ID } });
    expect(note?.reason).toMatch(/didn't interrupt.*\/queue couldn't be read/);
    // The cancel request stands: once the queue reads again, the poll interrupts.
    h.comfy.queueFails = false;
    await h.controller.reconcile(h.run.id);
    expect(h.comfy.interrupted).toEqual([OUR_ID]);
    expect((await h.controller.reconcile(h.run.id)).state).toBe("CANCELLED");
  });

  it("sends no interrupt while another prompt shares the running slot", async () => {
    const h = harness();
    h.comfy.globalInterrupt = true;
    await h.controller.advance(h.run.id);
    h.comfy.start(OUR_ID);
    await h.controller.reconcile(h.run.id);
    h.comfy.running = [OTHER_RUNNING, OUR_ID];
    expect((await h.controller.cancel(h.run.id, "user")).state).toBe("RUNNING");
    expect(h.comfy.interrupted).toEqual([]);
    expect(h.store.listRunEvents(h.run.id).at(-1)?.reason).toMatch(/another prompt is running beside it/);
  });
});

describe("output checks", () => {
  it("fails readability for a PNG whose header parses but whose data is truncated", async () => {
    const h = harness();
    await h.controller.advance(h.run.id);
    h.comfy.finish(OUR_ID);
    const whole = await png(1024, 1024);
    h.comfy.files.set("architect_00001_.png", whole.subarray(0, Math.floor(whole.length / 2)));
    const r = await h.controller.reconcile(h.run.id);
    expect(r).toMatchObject({ state: "COMPLETED", acceptance: "failed" });
    const evals = Object.fromEntries(h.store.listEvaluations(h.run.id).map((e) => [e.criterionId, e]));
    expect(evals.output_readable.verdict).toBe("fail");
    expect(evals.output_readable.explanation).toMatch(/doesn't decode/);
    // Format and size are the header's, which did parse.
    expect(evals.output_format.verdict).toBe("pass");
    expect(evals.output_dimensions.verdict).toBe("pass");
  });

  it("keeps readability unknown, not failed, when no decoder can be loaded", async () => {
    const h = harness();
    h.comfy.decoderMissing = true;
    await h.controller.advance(h.run.id);
    h.comfy.finish(OUR_ID);
    h.comfy.files.set("architect_00001_.png", await png(1024, 1024));
    const r = await h.controller.reconcile(h.run.id);
    expect(r).toMatchObject({ state: "COMPLETED", acceptance: "pending" });
    const readable = h.store.listEvaluations(h.run.id).find((e) => e.criterionId === "output_readable");
    expect(readable).toMatchObject({ verdict: "unknown" });
    expect(readable?.explanation).toMatch(/not decoded: sharp is switched off/);
  });

  it("counts entries under keys other than images as outputs it couldn't read, never a short count", async () => {
    const h = harness();
    await h.controller.advance(h.run.id);
    h.comfy.pending = [];
    h.comfy.history.set(OUR_ID, {
      prompt: {},
      outputs: {
        "2": {
          images: [{ filename: "architect_00001_.png", subfolder: "", type: "output" }],
          animated: [false],
          gifs: [{ filename: "architect_00001_.mp4", subfolder: "", type: "output", format: "video/h264-mp4" }],
        },
      },
      status: { status_str: "success", completed: true, messages: [["execution_success", {}]] },
    });
    h.comfy.files.set("architect_00001_.png", await png(1024, 1024));
    const r = await h.controller.reconcile(h.run.id);
    expect(r).toMatchObject({ state: "COMPLETED", acceptance: "pending" });
    expect(r.outputs.map((o) => o.filename)).toEqual(["architect_00001_.png"]);
    const v = Object.fromEntries(h.store.listEvaluations(h.run.id).map((e) => [e.criterionId, e.verdict]));
    expect(v).toMatchObject({ output_count: "unknown", output_readable: "unknown" });
    const entered = h.store.listRunEvents(h.run.id).find((e) => e.kind === "transition" && e.to === "EVALUATING");
    expect(entered?.data).toMatchObject({ unparsedOutputs: 1 });
  });
});

describe("revalidation after waiting for resources", () => {
  it("fails a run that waited and no longer validates, with the error's code and no POST", async () => {
    const revalidate = vi.fn(async () => {
      throw Object.assign(new Error("the checkpoint is gone from the fresh snapshot"), { code: "STALE_ENVIRONMENT" });
    });
    const h = harness({ revalidate });
    h.store.acquireLease({ pool: POOL, ownerId: "instance-b", now: clock, ttlMs: 60_000 });
    expect((await h.controller.advance(h.run.id)).state).toBe("WAITING_FOR_RESOURCE");
    h.store.releaseLease({ pool: POOL, ownerId: "instance-b" });
    const r = await h.controller.reconcile(h.run.id);
    expect(r).toMatchObject({ state: "FAILED", error: { code: "STALE_ENVIRONMENT" } });
    expect(r.error?.message).toMatch(/checkpoint is gone/);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(h.comfy.submitted).toEqual([]);
    expect(h.store.getLease(POOL)).toBeUndefined();
  });

  it("submits a run that waited and still validates, and doesn't revalidate one that never waited", async () => {
    const revalidate = vi.fn(async () => undefined);
    const waited = harness({ revalidate });
    waited.store.acquireLease({ pool: POOL, ownerId: "instance-b", now: clock, ttlMs: 60_000 });
    await waited.controller.advance(waited.run.id);
    waited.store.releaseLease({ pool: POOL, ownerId: "instance-b" });
    expect((await waited.controller.reconcile(waited.run.id)).state).toBe("QUEUED");
    expect(revalidate).toHaveBeenCalledTimes(1);

    const dir2 = mkdtempSync(join(tmpdir(), "architect-controller-direct-"));
    const other = ArchitectStore.open(dir2, { now: () => clock });
    stores.push(other);
    const direct = vi.fn(async () => undefined);
    const straight = harness({ revalidate: direct, store: other });
    expect((await straight.controller.advance(straight.run.id)).state).toBe("QUEUED");
    expect(direct).not.toHaveBeenCalled();
    rmSync(dir2, { recursive: true, force: true });
  });
});

describe("input files read again before a delayed submission (TODO 5.7.2)", () => {
  const CAT = Buffer.from("cat image bytes");
  const inputs = [{ assetId: "comfyui-input:pets/cat.png", sha256: sha256Hex(CAT), sizeBytes: CAT.length }];

  function waitedHarness(files: Map<string, Buffer>) {
    const reads: string[] = [];
    let h: Harness | undefined;
    const revalidate = vi.fn(async (r: RunRecord) => {
      if (!h) throw new Error("no harness");
      await requireInputsUnchanged(
        {
          store: h.store,
          readInputFile: async (name) => {
            reads.push(name);
            const bytes = files.get(name);
            if (!bytes) throw new Error(`ComfyUI /view returned 404 for "${name}" (input)`);
            return { bytes };
          },
        },
        r,
      );
    });
    h = harness({ revalidate, inputs });
    h.store.acquireLease({ pool: POOL, ownerId: "instance-b", now: clock, ttlMs: 60_000 });
    return { h, reads, revalidate };
  }

  it("submits a run that waited when its input is the approved one", async () => {
    const files = new Map([["pets/cat.png", CAT]]);
    const { h, reads } = waitedHarness(files);
    expect((await h.controller.advance(h.run.id)).state).toBe("WAITING_FOR_RESOURCE");
    h.store.releaseLease({ pool: POOL, ownerId: "instance-b" });
    expect((await h.controller.reconcile(h.run.id)).state).toBe("QUEUED");
    expect(reads).toEqual(["pets/cat.png"]);
  });

  it.each(["changed", "vanished"] as const)("fails a run that waited with APPROVAL_INVALIDATED when its input %s meanwhile, with no POST", async (change) => {
    const files = new Map([["pets/cat.png", CAT]]);
    const { h } = waitedHarness(files);
    expect((await h.controller.advance(h.run.id)).state).toBe("WAITING_FOR_RESOURCE");
    if (change === "changed") files.set("pets/cat.png", Buffer.from("another cat"));
    else files.delete("pets/cat.png");
    h.store.releaseLease({ pool: POOL, ownerId: "instance-b" });
    const r = await h.controller.reconcile(h.run.id);
    expect(r).toMatchObject({ state: "FAILED", error: { code: "APPROVAL_INVALIDATED" } });
    expect(r.error?.message).toContain("comfyui-input:pets/cat.png");
    expect(h.comfy.submitted).toEqual([]);
  });
});

describe("resources (AT-10)", () => {
  it("waits while another instance holds the pool, without an event per attempt, and starts after the release", async () => {
    const h = harness();
    h.store.acquireLease({ pool: POOL, ownerId: "instance-b", now: clock, ttlMs: 60_000 });
    expect((await h.controller.advance(h.run.id)).state).toBe("WAITING_FOR_RESOURCE");
    const events = h.store.listRunEvents(h.run.id).length;
    expect((await h.controller.reconcile(h.run.id)).state).toBe("WAITING_FOR_RESOURCE");
    expect(h.store.listRunEvents(h.run.id)).toHaveLength(events);
    h.store.releaseLease({ pool: POOL, ownerId: "instance-b" });
    expect((await h.controller.reconcile(h.run.id)).state).toBe("QUEUED");
    expect(h.comfy.submitted).toEqual([OUR_ID]);
  });

  it("waits with RESOURCE_BUSY while Ollama holds a model and residency isn't managed", async () => {
    const ps: FetchLike = async () => new Response(JSON.stringify({ models: [{ model: "qwen3:32b", size_vram: 2e10 }] }));
    const h = harness({ fetchImpl: ps });
    const r = await h.controller.advance(h.run.id);
    expect(r.state).toBe("WAITING_FOR_RESOURCE");
    const wait = h.store.listRunEvents(h.run.id).at(-1);
    expect(wait?.data).toEqual({ code: "RESOURCE_BUSY" });
    expect(wait?.reason).toMatch(/qwen3:32b.*ARCHITECT_MANAGE_RESIDENCY/);
    expect(h.store.getLease(POOL)).toBeUndefined();
    expect(h.comfy.submitted).toEqual([]);
  });

  it("fails with RESOURCE_ESTIMATE_UNKNOWN when Ollama doesn't answer: a hard unknown blocks", async () => {
    const hanging: FetchLike = (_u, init) => new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    const h = harness({ fetchImpl: hanging });
    const r = await h.controller.advance(h.run.id);
    expect(r).toMatchObject({ state: "FAILED", error: { code: "RESOURCE_ESTIMATE_UNKNOWN" } });
    expect(h.comfy.submitted).toEqual([]);
    expect(h.store.getLease(POOL)).toBeUndefined();
  });

  it("proceeds when Ollama refuses the connection", async () => {
    expect((await harness({ fetchImpl: refused }).controller.advance("run-1")).state).toBe("QUEUED");
  });
});

describe("Ollama residency (GAPS Q23)", () => {
  const restoredNotes = (store: ArchitectStore, runId: string) =>
    store.listRunEvents(runId).filter((e) => e.kind === "note" && e.data?.residency === "restored");

  function managed(extra: Parameters<typeof harness>[0] = {}) {
    const ollama = new FakeOllama().hold("A", new Date(clock.getTime() + 600_000).toISOString());
    return { ollama, ...harness({ ollama, manageResidency: true, release: releaseOf(["A"]), ...extra }) };
  }

  it("unloads the approved model, records it, and loads it back once the render is over, not before", async () => {
    const h = managed();
    expect((await h.controller.advance(h.run.id)).state).toBe("QUEUED");
    expect(h.ollama.posts.map((p) => p.body)).toEqual([{ model: "A", keep_alive: 0 }]);
    const entered = h.store.listRunEvents(h.run.id).find((e) => e.kind === "transition" && e.to === "VALIDATING");
    expect(entered?.data).toMatchObject({ unloadedOllamaModels: [{ name: "A", keepAlive: "600s" }], ollamaHost: "http://127.0.0.1:11434" });

    h.comfy.start(OUR_ID);
    expect((await h.controller.reconcile(h.run.id)).state).toBe("RUNNING");
    await h.controller.settled();
    expect(h.ollama.loads).toEqual([]);

    h.comfy.finish(OUR_ID);
    h.comfy.files.set("architect_00001_.png", await png(1024, 1024));
    const done = await h.controller.reconcile(h.run.id);
    expect(done).toMatchObject({ state: "COMPLETED", acceptance: "passed" });
    await h.controller.settled();
    expect(h.ollama.loads).toEqual([{ host: "http://127.0.0.1:11434", model: "A", keepAlive: "600s" }]);
    expect(restoredNotes(h.store, h.run.id).map((e) => e.data)).toEqual([
      { residency: "restored", ollamaHost: "http://127.0.0.1:11434", restored: ["A"], failed: [], unverified: [] },
    ]);

    // A restart finds the note and loads nothing again.
    await h.controller.resumeAll();
    await h.controller.settled();
    expect(h.ollama.loads).toHaveLength(1);
    expect(restoredNotes(h.store, h.run.id)).toHaveLength(1);
  });

  it("loads the model back after a failed render", async () => {
    const h = managed();
    await h.controller.advance(h.run.id);
    h.comfy.start(OUR_ID);
    h.comfy.fail(OUR_ID);
    expect((await h.controller.reconcile(h.run.id)).state).toBe("FAILED");
    await h.controller.settled();
    expect(h.ollama.loads.map((l) => l.model)).toEqual(["A"]);
  });

  it("loads the model back after a cancelled render", async () => {
    const h = managed();
    await h.controller.advance(h.run.id);
    expect((await h.controller.cancel(h.run.id, "user")).state).toBe("CANCELLED");
    await h.controller.settled();
    expect(h.ollama.loads.map((l) => l.model)).toEqual(["A"]);
  });

  it("doesn't unload or load anything for a run that never held the pool", async () => {
    const h = managed();
    h.store.acquireLease({ pool: POOL, ownerId: "instance-b", now: clock, ttlMs: 60_000 });
    expect((await h.controller.advance(h.run.id)).state).toBe("WAITING_FOR_RESOURCE");
    expect((await h.controller.cancel(h.run.id, "user")).state).toBe("CANCELLED");
    await h.controller.settled();
    expect(h.ollama.posts).toEqual([]);
    expect(h.ollama.loads).toEqual([]);
    expect(restoredNotes(h.store, h.run.id)).toEqual([]);
  });

  it("loads the model back once the prompt is taken as not live, though the run stays OUTCOME_UNKNOWN", async () => {
    const h = managed();
    h.comfy.onSubmit = () => ({ kind: "unknown", message: "timeout" });
    await h.controller.advance(h.run.id);
    for (let i = 0; i < 2; i++) {
      later(2);
      await h.controller.reconcile(h.run.id);
      await h.controller.settled();
      expect(h.ollama.loads).toEqual([]);
    }
    later(2);
    expect((await h.controller.reconcile(h.run.id)).state).toBe("OUTCOME_UNKNOWN");
    await h.controller.settled();
    expect(h.ollama.loads.map((l) => l.model)).toEqual(["A"]);
  });

  it("records a failed reload without changing the run's state or acceptance", async () => {
    const h = managed();
    h.ollama.loadFails.add("A");
    await h.controller.advance(h.run.id);
    h.comfy.finish(OUR_ID);
    h.comfy.files.set("architect_00001_.png", await png(1024, 1024));
    expect(await h.controller.reconcile(h.run.id)).toMatchObject({ state: "COMPLETED", acceptance: "passed" });
    await h.controller.settled();
    const [note] = restoredNotes(h.store, h.run.id);
    expect(note.data).toMatchObject({ restored: [], failed: [{ name: "A" }], unverified: [] });
    expect(h.store.getRun(h.run.id)).toMatchObject({ state: "COMPLETED", acceptance: "passed" });
  });

  it("routes a restore that rejects to onError and leaves the run as it is", async () => {
    const errors: string[] = [];
    const h = managed({
      restore: async () => {
        throw new Error("the store is locked");
      },
      onError: (err) => errors.push(err instanceof Error ? err.message : String(err)),
    });
    await h.controller.advance(h.run.id);
    expect((await h.controller.cancel(h.run.id, "user")).state).toBe("CANCELLED");
    await h.controller.settled();
    expect(errors).toEqual(["the store is locked"]);
    expect(h.store.getRun(h.run.id)?.state).toBe("CANCELLED");
  });

  it("loads back on resume what a process that stopped after the render left unloaded", async () => {
    const ollama = new FakeOllama().hold("A");
    const comfy = new FakeComfy();
    const first = harness({ ollama, comfy, manageResidency: true, release: releaseOf(["A"]), restore: async () => undefined });
    await first.controller.advance(first.run.id);
    comfy.finish(OUR_ID);
    comfy.files.set("architect_00001_.png", await png(1024, 1024));
    expect((await first.controller.reconcile(first.run.id)).state).toBe("COMPLETED");
    expect(ollama.loads).toEqual([]);

    const second = harness({ ollama, comfy, store: openStore(), seed: false, ownerId: "instance-restarted", uuids: [] });
    await second.controller.resumeAll();
    await second.controller.settled();
    expect(ollama.loads.map((l) => l.model)).toEqual(["A"]);
    expect(restoredNotes(second.store, first.run.id)).toHaveLength(1);
  });

  it("doesn't load back on resume while the run's render may be live", async () => {
    const ollama = new FakeOllama().hold("A");
    const comfy = new FakeComfy();
    const first = harness({ ollama, comfy, manageResidency: true, release: releaseOf(["A"]), restore: async () => undefined });
    expect((await first.controller.advance(first.run.id)).state).toBe("QUEUED");
    const second = harness({ ollama, comfy, store: openStore(), seed: false, ownerId: "instance-restarted", uuids: [] });
    await second.controller.resumeAll();
    await second.controller.settled();
    expect(ollama.loads).toEqual([]);
  });
});

describe("wall-time budget", () => {
  // The run was created at 12:01, the clock starts at 12:02: 120 s run out at 12:03.
  it("fails a run still waiting for resources past the budget, without submitting", async () => {
    const h = harness({ maxWallTimeSeconds: 120 });
    h.store.acquireLease({ pool: POOL, ownerId: "instance-b", now: clock, ttlMs: 600_000 });
    expect((await h.controller.advance(h.run.id)).state).toBe("WAITING_FOR_RESOURCE");
    later(61);
    expect(await h.controller.reconcile(h.run.id)).toMatchObject({ state: "FAILED", error: { code: "BUDGET_EXCEEDED" } });
    expect(h.comfy.submitted).toEqual([]);
  });

  it("interrupts its own running prompt and fails with BUDGET_EXCEEDED", async () => {
    const h = harness({ maxWallTimeSeconds: 120 });
    await h.controller.advance(h.run.id);
    h.comfy.start(OUR_ID);
    await h.controller.reconcile(h.run.id);
    later(61);
    const r = await h.controller.reconcile(h.run.id);
    expect(r).toMatchObject({ state: "FAILED", error: { code: "BUDGET_EXCEEDED" } });
    expect(h.comfy.interrupted).toEqual([OUR_ID]);
    expect(h.store.getLease(POOL)).toBeUndefined();
  });

  it("dequeues its own pending prompt past the budget", async () => {
    const h = harness({ maxWallTimeSeconds: 120 });
    h.comfy.running = [OTHER_RUNNING];
    await h.controller.advance(h.run.id);
    later(61);
    const r = await h.controller.reconcile(h.run.id);
    expect(r).toMatchObject({ state: "FAILED", error: { code: "BUDGET_EXCEEDED" } });
    expect(h.comfy.dequeued).toEqual([OUR_ID]);
    expect(h.comfy.interrupted).toEqual([]);
    expect(h.comfy.running).toEqual([OTHER_RUNNING]);
  });
});

describe("restart", () => {
  it("resumes a RUNNING run in a new controller on the same store and completes it", async () => {
    const comfy = new FakeComfy();
    const first = harness({ comfy });
    await first.controller.advance(first.run.id);
    comfy.start(OUR_ID);
    await first.controller.reconcile(first.run.id);
    expect(first.store.getRun(first.run.id)?.state).toBe("RUNNING");

    comfy.finish(OUR_ID);
    comfy.files.set("architect_00001_.png", await png(1024, 1024));
    later(30);
    const second = harness({ comfy, store: openStore(), seed: false, ownerId: "instance-restarted", uuids: [] });
    const resumed = await second.controller.resumeAll();
    expect(resumed.map((r) => r.state)).toEqual(["COMPLETED"]);
    expect(second.store.getRun(first.run.id)?.acceptance).toBe("passed");
    expect(comfy.submitted).toEqual([OUR_ID]);
  });
});

describe("polling", () => {
  it("starts once, reconciles on its interval, and stops", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const h = harness();
      await h.controller.advance(h.run.id);
      h.controller.startPolling();
      h.controller.startPolling();
      const reads = h.comfy.queueReads;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.comfy.queueReads).toBe(reads + 1);
      h.controller.stopPolling();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.comfy.queueReads).toBe(reads + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
