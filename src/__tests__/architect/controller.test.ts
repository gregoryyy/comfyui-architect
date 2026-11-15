import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunController, type RunControllerDeps } from "../../services/architect/controller.js";
import { type FetchLike, ResourceCoordinator, memoryPool } from "../../services/architect/resources.js";
import type { ApiGraph, RunRecord, TaskSpec } from "../../services/architect/schemas.js";
import { ArchitectStore } from "../../services/architect/store.js";
import type { SubmitOutcome } from "../../services/architect/upstream.js";
import { BASE_URL } from "./fixtures/execution-records.js";
import { GRAPH, RUN_CREATED, seedRun } from "./fixtures/run-harness.js";

type HistoryEntry = NonNullable<Awaited<ReturnType<RunControllerDeps["upstream"]["history"]>>>;

const OUR_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_PENDING = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_RUNNING = "aaaaaaaa-0000-4000-8000-000000000002";
const POOL = memoryPool(BASE_URL);

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

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
  queueReads = 0;
  queueFails = false;
  historyFails = false;
  /** What a POST answers; by default ComfyUI queues the prompt under the requested ID. */
  onSubmit: (promptId: string) => SubmitOutcome = (id) => {
    this.pending.push(id);
    return { kind: "accepted", promptId: id };
  };

  facade(): RunControllerDeps["upstream"] {
    return {
      submitPrompt: async (_graph, promptId) => {
        this.submitted.push(promptId);
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
        // ComfyUI stops the running prompt only when it has this ID.
        if (this.running[0] === promptId) {
          this.running = [];
          this.history.set(promptId, {
            prompt: {},
            outputs: {},
            status: { status_str: "error", completed: false, messages: [["execution_interrupted", { prompt_id: promptId }]] },
          });
        }
      },
      outputFile: async (ref) => {
        const bytes = this.files.get(ref.filename);
        if (!bytes) throw new Error(`/view ${ref.filename}: 404`);
        return { bytes, mimeType: "image/png" };
      },
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
    manageResidency?: boolean;
    ownerId?: string;
    graph?: ApiGraph;
    comfy?: FakeComfy;
    store?: ArchitectStore;
    seed?: boolean;
    maxWallTimeSeconds?: number;
    uuids?: string[];
  } = {},
): Harness {
  const store = opts.store ?? openStore();
  const run = opts.seed === false ? undefined : seedRun(store, { task: opts.task, maxWallTimeSeconds: opts.maxWallTimeSeconds });
  const comfy = opts.comfy ?? new FakeComfy();
  const now = () => new Date(clock);
  const uuids = [...(opts.uuids ?? [OUR_ID])];
  const resources = new ResourceCoordinator({
    store,
    upstream: { ollamaHost: () => "http://127.0.0.1:11434", unloadOllama: async () => [] },
    ownerId: opts.ownerId ?? "instance-a",
    now,
    manageResidency: opts.manageResidency ?? false,
    fetchImpl: opts.fetchImpl ?? refused,
    probeTimeoutMs: 20,
  });
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
    graphFor: async () => opts.graph ?? GRAPH,
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
    h.comfy.files.set("architect_00001_.png", png(1024, 1024));
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
    h.comfy.files.set("small.png", png(512, 512));
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
    crashed.appendRunEvent({ runId: run.id, kind: "submit_attempt", principal: "controller", reason: "submitting", data: { promptId: OUR_ID }, at: clock });
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
    await h.controller.cancel(h.run.id, "user");
    expect(h.comfy.interrupted).toEqual([OUR_ID]);
    expect(h.comfy.running).toEqual([OTHER_RUNNING]);
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
    comfy.files.set("architect_00001_.png", png(1024, 1024));
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
