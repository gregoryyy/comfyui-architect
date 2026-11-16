// Attempts under one grant (TODO 6.1.3, 6.1.4, 6.2.1; ARCH 2026-11-16, milestone 6): the
// store's admission transaction for a child attempt with its negative cases, the smoke stage
// and the repair chain driven by the run controller against a fake ComfyUI, the approval
// text that names stages, transformations and limits, and the status that reports the
// chain. No ComfyUI, GPU or model: the fake answers through the facade's shape.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalError, describeActionPlan, issueGrant } from "../../services/architect/admission.js";
import { graphFingerprint } from "../../services/architect/compile.js";
import { RunController, type RunControllerDeps } from "../../services/architect/controller.js";
import { ArchitectExecution } from "../../services/architect/execution.js";
import { canonicalJson } from "../../services/architect/hash.js";
import { buildRevision, smokeStep, SMOKE_TRANSFORMATION } from "../../services/architect/repair.js";
import { ResourceCoordinator, type FetchLike, memoryPool } from "../../services/architect/resources.js";
import {
  type ApiGraph,
  type GraphRevision,
  type RunRecord,
  type TaskSpec,
  type TransformationStep,
  ActionPlan,
  StoredRecordError,
  actionPlanHash,
} from "../../services/architect/schemas.js";
import { ArchitectStore, StoreConflictError } from "../../services/architect/store.js";
import { createUpstreamFacade, type SubmitOutcome } from "../../services/architect/upstream.js";
import { TASK, setup } from "./fixtures/approval-harness.js";
import { RUN_CREATED, type SeedOptions, seedRun } from "./fixtures/run-harness.js";

/** A text-to-image graph like the fixture recipe's: a 20-step KSampler, a VAEDecode, a SaveImage. */
const CHAIN_GRAPH: ApiGraph = {
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "a.safetensors" } },
  "2": { class_type: "CLIPTextEncode", inputs: { text: "A red bicycle.", clip: ["1", 1] } },
  "4": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  "5": {
    class_type: "KSampler",
    inputs: { model: ["1", 0], seed: 7, steps: 20, cfg: 6, sampler_name: "euler", scheduler: "normal", positive: ["2", 0], negative: ["2", 0], latent_image: ["4", 0], denoise: 1 },
  },
  "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
  "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "architect" } },
};
const APPROVED = graphFingerprint(CHAIN_GRAPH);

const CHAIN: NonNullable<SeedOptions["chain"]> = {
  graph: CHAIN_GRAPH,
  outputNodes: ["7"],
  stages: [{ stage: "smoke", transformation: SMOKE_TRANSFORMATION }, { stage: "final" }],
  repair: {
    transformations: [
      { id: "vae.tiled_decode", version: 1 },
      { id: "vae.smaller_tiles", version: 1 },
      { id: "retry.unchanged", version: 1 },
    ],
  },
  limits: { maxPreviewRuns: 3, maxFinalRuns: 1, maxRepairRounds: 2 },
};

const SMOKE = smokeStep(SMOKE_TRANSFORMATION);
const TILED: TransformationStep = { id: "vae.tiled_decode", version: 1, node: "6", reason: "attempt 1 failed: memory", failureClass: "memory", failedRunId: "run-1" };

let dir: string;
let clock: Date;
const stores: ArchitectStore[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "architect-attempts-"));
  clock = new Date(RUN_CREATED);
});
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

function openStore(): ArchitectStore {
  const s = ArchitectStore.open(dir, { now: () => clock });
  stores.push(s);
  return s;
}

const later = (seconds: number) => (clock = new Date(clock.getTime() + seconds * 1000));

/** Move a run to FAILED with `error`, through the states a submitted run passes. */
function failRun(store: ArchitectStore, run: RunRecord, error: NonNullable<RunRecord["error"]>): RunRecord {
  const at = clock;
  store.transitionRun({ runId: run.id, from: "PREPARING", to: "VALIDATING", principal: "controller", reason: "t", at });
  return store.transitionRun({ runId: run.id, from: "VALIDATING", to: "FAILED", principal: "controller", reason: "t", patch: { error }, at }).run;
}

/** Move a run to COMPLETED with `acceptance`. */
function completeRun(store: ArchitectStore, run: RunRecord, acceptance: "passed" | "failed", promptId: string): RunRecord {
  const at = clock;
  store.transitionRun({ runId: run.id, from: "PREPARING", to: "VALIDATING", principal: "controller", reason: "t", at });
  store.transitionRun({ runId: run.id, from: "VALIDATING", to: "QUEUED", principal: "controller", reason: "t", patch: { promptId }, at });
  store.transitionRun({ runId: run.id, from: "QUEUED", to: "EVALUATING", principal: "controller", reason: "t", at });
  return store.transitionRun({ runId: run.id, from: "EVALUATING", to: "COMPLETED", principal: "controller", reason: "t", patch: { acceptance }, at }).run;
}

const OOM = { code: "EXECUTION_FAILED" as const, message: "oom", detail: { nodeId: "6", nodeType: "VAEDecode", exceptionMessage: "out of memory" } };

/** The child attempt the controller would create after `predecessor`, with a revision for `steps`. */
function child(
  root: RunRecord,
  predecessor: RunRecord,
  a: { index: number; stage: "smoke" | "final"; repairRound: number; steps: TransformationStep[]; id?: string },
): { run: Parameters<ArchitectStore["createChildAttempt"]>[0]["run"]; revision?: GraphRevision } {
  const id = a.id ?? `run-child${a.index}`;
  const revision =
    a.steps.length > 0
      ? buildRevision({
          id: `grev-${id.slice(4)}`,
          rootRunId: root.id,
          actionPlanId: root.actionPlanId,
          candidateId: root.candidateId,
          approved: CHAIN_GRAPH,
          approvedFingerprint: APPROVED,
          ...(predecessor.attempt?.revisionId ? { parentRevisionId: predecessor.attempt.revisionId } : {}),
          steps: a.steps,
          at: clock,
        }).revision
      : undefined;
  return {
    run: {
      ...root,
      id,
      idempotencyKey: `${root.idempotencyKey}#${a.index}`,
      state: "PREPARING",
      outputs: [],
      timings: {},
      acceptance: "pending",
      error: undefined,
      promptId: undefined,
      attempt: { rootRunId: root.id, index: a.index, stage: a.stage, repairRound: a.repairRound, ...(revision ? { revisionId: revision.id } : {}) },
      createdAt: clock.toISOString(),
      updatedAt: clock.toISOString(),
    },
    ...(revision ? { revision } : {}),
  };
}

function create(store: ArchitectStore, predecessor: RunRecord, c: ReturnType<typeof child>) {
  return store.createChildAttempt({ run: c.run, predecessorRunId: predecessor.id, ...(c.revision ? { revision: c.revision } : {}), now: clock, reason: "test" });
}

describe("the root attempt (TODO 6.2.1)", () => {
  it("starts a chained plan's run as attempt 1 rendering the smoke revision of the approved graph", () => {
    const store = openStore();
    const root = seedRun(store, { chain: CHAIN });
    expect(root.attempt).toEqual({ rootRunId: root.id, index: 1, stage: "smoke", repairRound: 0, revisionId: "grev-smoke" });
    // The run keeps the approved graph's fingerprint; the revision has the submitted one's.
    expect(root.graphFingerprint).toBe(APPROVED);
    const revision = store.getGraphRevision("grev-smoke");
    expect(revision).toMatchObject({ rootRunId: root.id, baseFingerprint: APPROVED, steps: [SMOKE] });
    expect(revision?.diff.map((c) => [c.node, c.classType?.to ?? null])).toEqual([
      ["5", null],
      ["7", "PreviewImage"],
    ]);
    expect(store.getGrant(root.grantId ?? "")?.consumedByRunId).toBe(root.id);
    expect(store.listAttempts(root.id).map((r) => r.id)).toEqual([root.id]);
  });

  it("refuses a chained plan's run without its attempt, and a smoke revision with other steps", () => {
    const store = openStore();
    expect(() => seedRunBroken(store, (r) => ({ ...r, attempt: undefined }))).toThrow(/starts as attempt 1/);
    const store2 = ArchitectStore.open(mkdtempSync(join(tmpdir(), "architect-attempts-b-")));
    stores.push(store2);
    expect(() => seedRunBroken(store2, (r) => r, [SMOKE, TILED])).toThrow(/and nothing else/);
  });
});

/**
 * Seed the chain's records but create the root with `edit` applied to it (and the smoke
 * revision with `steps`), to see what createRunWithGrant refuses.
 */
function seedRunBroken(store: ArchitectStore, edit: (r: RunRecord) => Partial<RunRecord>, steps: TransformationStep[] = [SMOKE]): void {
  const seeded = seedRunWithoutRun(store);
  const revision = buildRevision({
    id: "grev-x",
    rootRunId: "run-1",
    actionPlanId: seeded.actionPlanId,
    candidateId: "cand-1",
    approved: CHAIN_GRAPH,
    approvedFingerprint: APPROVED,
    steps,
    at: RUN_CREATED,
  }).revision;
  const base = seeded.run;
  store.createRunWithGrant({ run: { ...base, ...edit(base) }, grantId: seeded.grantId, now: RUN_CREATED, revision });
}

/** The chain's action plan and grant without the run, and the root run it would start. */
function seedRunWithoutRun(store: ArchitectStore): { run: RunRecord; grantId: string; actionPlanId: string } {
  // seedRun creates the run in its last step; a throwaway store gives the records it would.
  const scratch = ArchitectStore.open(mkdtempSync(join(tmpdir(), "architect-attempts-s-")));
  try {
    const root = seedRun(scratch, { chain: CHAIN });
    const ap = scratch.getActionPlan(root.actionPlanId);
    const grant = scratch.getGrant(root.grantId ?? "");
    const task = scratch.getTask(root.taskId, root.taskRevision);
    const env = scratch.getSnapshot("env-1");
    const plan = scratch.getPlan(root.planId);
    const cand = scratch.getCandidate(root.candidateId);
    const request = scratch.getApprovalRequest(grant?.approvalRequestId ?? "");
    if (!ap || !grant || !task || !env || !plan || !cand || !request) throw new Error("seed incomplete");
    store.putTaskRevision(task);
    store.putSnapshot(env);
    store.putPlan(plan);
    store.putCandidate(cand);
    store.putActionPlan(ap);
    store.putApprovalRequest({ ...request, state: "pending", resolvedAt: undefined });
    store.resolveApprovalRequest(request.id, "granted", new Date("2026-11-15T12:01:00.000Z"));
    store.putGrant({ ...grant, consumedAt: undefined, consumedByRunId: undefined });
    return { run: { ...root, attempt: { ...root.attempt!, revisionId: "grev-x" } }, grantId: grant.id, actionPlanId: ap.id };
  } finally {
    scratch.close();
  }
}

describe("createChildAttempt: the store's admission of a further attempt (TODO 6.1.3)", () => {
  it("creates a repaired smoke after a failed one, under the root's grant, with the revision and its diff", () => {
    const store = openStore();
    const root = failRun(store, seedRun(store, { chain: CHAIN }), OOM);
    const c = child(root, root, { index: 2, stage: "smoke", repairRound: 1, steps: [SMOKE, TILED] });
    const made = create(store, root, c);
    expect(made.created).toBe(true);
    expect(made.run).toMatchObject({ state: "PREPARING", grantId: root.grantId, idempotencyKey: `${root.idempotencyKey}#2` });
    expect(store.listAttempts(root.id).map((r) => r.attempt?.index)).toEqual([1, 2]);
    const revision = store.getGraphRevision(c.revision?.id ?? "");
    expect(revision?.parentRevisionId).toBe("grev-smoke");
    expect(revision?.diff.find((d) => d.node === "6")?.classType).toEqual({ from: "VAEDecode", to: "VAEDecodeTiled" });
    // The grant is still the root's: one grant, one consumed run.
    expect(store.getGrant(root.grantId ?? "")?.consumedByRunId).toBe(root.id);
  });

  it("finds the child it made when the creation is retried, and refuses another attempt under that index", () => {
    const store = openStore();
    const root = failRun(store, seedRun(store, { chain: CHAIN }), OOM);
    const first = create(store, root, child(root, root, { index: 2, stage: "smoke", repairRound: 1, steps: [SMOKE, TILED] }));
    const again = create(store, root, child(root, root, { index: 2, stage: "smoke", repairRound: 1, steps: [SMOKE, TILED], id: "run-other" }));
    expect(again).toEqual({ run: first.run, created: false });
    expect(() => create(store, root, child(root, root, { index: 2, stage: "smoke", repairRound: 1, steps: [SMOKE, { id: "retry.unchanged", version: 1, reason: "x", failureClass: "transport" }], id: "run-other2" }))).toThrow(
      /already run .*, another attempt/,
    );
    expect(store.listAttempts(root.id)).toHaveLength(2);
  });

  it("refuses a further attempt once the grant's previews are used", () => {
    const store = openStore();
    const root = failRun(store, seedRun(store, { chain: { ...CHAIN, limits: { ...CHAIN.limits, maxPreviewRuns: 1 } } }), OOM);
    expect(() => create(store, root, child(root, root, { index: 2, stage: "smoke", repairRound: 1, steps: [SMOKE, TILED] }))).toThrow(/allows 1 preview run/);
  });

  it("refuses a repair round beyond the grant's", () => {
    const store = openStore();
    const root = failRun(store, seedRun(store, { chain: { ...CHAIN, limits: { ...CHAIN.limits, maxRepairRounds: 0 } } }), OOM);
    expect(() => create(store, root, child(root, root, { index: 2, stage: "smoke", repairRound: 1, steps: [SMOKE, TILED] }))).toThrow(StoreConflictError);
    expect(store.listAttempts(root.id)).toHaveLength(1);
  });

  it("refuses a second final when the grant allows one", () => {
    const store = openStore();
    const root = completeRun(store, seedRun(store, { chain: CHAIN }), "passed", "11111111-2222-4333-8444-555555555555");
    const final = create(store, root, child(root, root, { index: 2, stage: "final", repairRound: 0, steps: [] })).run;
    const failed = failRun(store, final, OOM);
    expect(() => create(store, failed, child(root, failed, { index: 3, stage: "final", repairRound: 1, steps: [TILED] }))).toThrow(/allows 1 final run/);
  });

  it("refuses a transformation outside the effect's repair scope, and the smoke step on a final", () => {
    const store = openStore();
    const root = failRun(store, seedRun(store, { chain: CHAIN }), OOM);
    const seed: TransformationStep = { id: "seed.next", version: 1, reason: "x", failureClass: "quality" };
    expect(() => create(store, root, child(root, root, { index: 2, stage: "smoke", repairRound: 1, steps: [SMOKE, seed] }))).toThrow(/outside the repair scope/);
    const otherVersion: TransformationStep = { ...TILED, version: 2 };
    expect(() => buildRevision({ id: "grev-v2", rootRunId: root.id, actionPlanId: root.actionPlanId, candidateId: root.candidateId, approved: CHAIN_GRAPH, approvedFingerprint: APPROVED, steps: [SMOKE, otherVersion], at: clock })).toThrow(
      /isn't known/,
    );
    expect(() => create(store, root, child(root, root, { index: 2, stage: "final", repairRound: 0, steps: [SMOKE] }))).toThrow(/start of a smoke attempt only/);
  });

  it("refuses an attempt that repeats the failed one's graph, or adds more than one step", () => {
    const store = openStore();
    const root = failRun(store, seedRun(store, { chain: CHAIN }), OOM);
    expect(() => create(store, root, child(root, root, { index: 2, stage: "smoke", repairRound: 1, steps: [SMOKE] }))).toThrow(/adds one/);
    const smaller: TransformationStep = { ...TILED, id: "vae.smaller_tiles" };
    expect(() => create(store, root, child(root, root, { index: 2, stage: "smoke", repairRound: 1, steps: [SMOKE, TILED, smaller] }))).toThrow(/adds one/);
  });

  it("refuses to follow a predecessor in OUTCOME_UNKNOWN or CANCELLED", () => {
    const store = openStore();
    const root = seedRun(store, { chain: CHAIN });
    store.transitionRun({ runId: root.id, from: "PREPARING", to: "VALIDATING", principal: "controller", reason: "t", at: clock });
    const unknown = store.transitionRun({
      runId: root.id,
      from: "VALIDATING",
      to: "OUTCOME_UNKNOWN",
      principal: "controller",
      reason: "lost",
      patch: { promptId: "11111111-2222-4333-8444-555555555555", error: { code: "OUTCOME_UNKNOWN", message: "lost" } },
      at: clock,
    }).run;
    expect(() => create(store, unknown, child(unknown, unknown, { index: 2, stage: "smoke", repairRound: 1, steps: [SMOKE, TILED] }))).toThrow(/OUTCOME_UNKNOWN/);
    const cancelled = store.transitionRun({ runId: root.id, from: "OUTCOME_UNKNOWN", to: "CANCELLED", principal: "user", reason: "t", at: clock }).run;
    expect(() => create(store, cancelled, child(cancelled, cancelled, { index: 2, stage: "smoke", repairRound: 1, steps: [SMOKE, TILED] }))).toThrow(/CANCELLED/);
  });

  it("refuses an attempt once the deadline from the root's start has passed", () => {
    const store = openStore();
    const root = failRun(store, seedRun(store, { chain: CHAIN }), OOM);
    clock = new Date(Date.parse(root.createdAt) + 600 * 1000);
    expect(() => create(store, root, child(root, root, { index: 2, stage: "smoke", repairRound: 1, steps: [SMOKE, TILED] }))).toThrow(/have passed/);
  });

  it("refuses an attempt when the action plan changed since the grant bound it", () => {
    const store = openStore();
    const root = failRun(store, seedRun(store, { chain: CHAIN }), OOM);
    store.close();
    // Another action plan written under the same id, with a hash that covers it: the grant's hash is the old one's.
    const db = new BetterSqlite3(join(dir, "architect.db"));
    const stored = ActionPlan.parse(JSON.parse(String((db.prepare("SELECT payload FROM action_plans WHERE id = ?").get(root.actionPlanId) as { payload: string }).payload)));
    const widened = { ...stored, budgets: { ...stored.budgets, maxWallTimeSeconds: 9999 } };
    db.prepare("UPDATE action_plans SET payload = ? WHERE id = ?").run(canonicalJson({ ...widened, hash: actionPlanHash(widened) }), root.actionPlanId);
    db.close();
    const reopened = openStore();
    expect(() => create(reopened, root, child(root, root, { index: 2, stage: "smoke", repairRound: 1, steps: [SMOKE, TILED] }))).toThrow(/doesn't bind action plan/);
    // An edit that leaves the old hash in place doesn't even read back.
    reopened.close();
    const db2 = new BetterSqlite3(join(dir, "architect.db"));
    db2.prepare("UPDATE action_plans SET payload = ? WHERE id = ?").run(canonicalJson({ ...widened, hash: stored.hash }), root.actionPlanId);
    db2.close();
    const third = openStore();
    expect(() => create(third, root, child(root, root, { index: 2, stage: "smoke", repairRound: 1, steps: [SMOKE, TILED] }))).toThrow(StoredRecordError);
  });

  it("refuses an attempt after a cancel request on the root, or after anything but the latest attempt", () => {
    const store = openStore();
    const root = failRun(store, seedRun(store, { chain: CHAIN }), OOM);
    const second = failRun(store, create(store, root, child(root, root, { index: 2, stage: "smoke", repairRound: 1, steps: [SMOKE, TILED] })).run, OOM);
    expect(() => create(store, root, child(root, root, { index: 3, stage: "smoke", repairRound: 2, steps: [SMOKE, TILED, { ...TILED, id: "vae.smaller_tiles" }] }))).toThrow(/isn't the latest attempt/);
    store.appendRunEvent({ runId: root.id, kind: "cancel", principal: "agent", reason: "stop", at: clock });
    expect(() => create(store, second, child(root, second, { index: 3, stage: "smoke", repairRound: 2, steps: [SMOKE, TILED, { ...TILED, id: "vae.smaller_tiles" }] }))).toThrow(/was cancelled/);
  });

  it("refuses a final after a smoke that didn't pass, and a child of a run that isn't a chain's root", () => {
    const store = openStore();
    const root = completeRun(store, seedRun(store, { chain: CHAIN }), "failed", "11111111-2222-4333-8444-555555555555");
    expect(() => create(store, root, child(root, root, { index: 2, stage: "final", repairRound: 0, steps: [] }))).toThrow(/once the smoke passed/);
    const store2 = ArchitectStore.open(mkdtempSync(join(tmpdir(), "architect-attempts-p-")));
    stores.push(store2);
    const plain = failRun(store2, seedRun(store2), OOM);
    const c = child({ ...plain, attempt: { rootRunId: plain.id, index: 1, stage: "final", repairRound: 0 } }, plain, { index: 2, stage: "final", repairRound: 1, steps: [] });
    expect(() => create(store2, plain, c)).toThrow(/isn't the root of an attempt chain/);
  });
});

// ---------------------------------------------------------------------------------------
// The controller drives the chain

type HistoryEntry = NonNullable<Awaited<ReturnType<RunControllerDeps["upstream"]["history"]>>>;
const { decodeImage } = createUpstreamFacade();
const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();
const refused: FetchLike = async () => {
  throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
};

/** ComfyUI as the facade shows it: it records each submitted graph. No queue clearing exists here. */
class FakeComfy {
  pending: string[] = [];
  history = new Map<string, HistoryEntry>();
  files = new Map<string, Buffer>();
  submitted: { promptId: string; graph: ApiGraph }[] = [];
  interrupted: string[] = [];
  onSubmit: (promptId: string) => SubmitOutcome = (id) => {
    this.pending.push(id);
    return { kind: "accepted", promptId: id };
  };

  facade(): RunControllerDeps["upstream"] {
    return {
      submitPrompt: async (graph, promptId) => {
        this.submitted.push({ promptId, graph: structuredClone(graph) as ApiGraph });
        return this.onSubmit(promptId);
      },
      queue: async () => ({ running: [], pending: [...this.pending] }),
      history: async (promptId) => this.history.get(promptId),
      dequeue: async (promptId) => {
        if (!this.pending.includes(promptId)) return { removed: false, state: "absent", verified: true };
        this.pending = this.pending.filter((p) => p !== promptId);
        return { removed: true, state: "removed", verified: true };
      },
      interruptPrompt: async (promptId) => {
        this.interrupted.push(promptId);
      },
      outputFile: async (ref) => {
        const bytes = this.files.get(ref.filename);
        if (!bytes) throw new Error(`/view ${ref.filename}: 404`);
        return { bytes, mimeType: "image/png" };
      },
      decodeImage,
    };
  }

  finish(promptId: string, filename: string, type: "output" | "temp"): void {
    this.pending = this.pending.filter((p) => p !== promptId);
    this.history.set(promptId, {
      prompt: {},
      outputs: { "7": { images: [{ filename, subfolder: "", type }] } },
      status: { status_str: "success", completed: true, messages: [["execution_success", {}]] },
    });
  }

  fail(promptId: string, error: Record<string, unknown>): void {
    this.pending = this.pending.filter((p) => p !== promptId);
    this.history.set(promptId, { prompt: {}, outputs: {}, status: { status_str: "error", completed: false, messages: [["execution_error", error]] } });
  }
}

function chainHarness(opts: { chain?: SeedOptions["chain"]; task?: Record<string, unknown>; visualEvaluation?: RunControllerDeps["visualEvaluation"] } = {}) {
  const store = openStore();
  const root = seedRun(store, { chain: opts.chain ?? CHAIN, ...(opts.task ? { task: opts.task } : {}) });
  const comfy = new FakeComfy();
  const now = () => new Date(clock);
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const controller = new RunController({
    store,
    upstream: comfy.facade(),
    resources: new ResourceCoordinator({ store, upstream: { ollamaHost: () => "http://127.0.0.1:11434", loadOllama: async () => true, isOwnHostAddress: () => false }, ownerId: "instance-a", now, manageResidency: false, fetchImpl: refused, probeTimeoutMs: 20 }),
    now,
    newUuid: uuid,
    graphFor: async () => CHAIN_GRAPH,
    taskFor: (r): TaskSpec => {
      const t = store.getTask(r.taskId, r.taskRevision);
      if (!t) throw new Error("task missing");
      return t;
    },
    ...(opts.visualEvaluation ? { visualEvaluation: opts.visualEvaluation } : {}),
  });
  const notUsed = () => {
    throw new Error("not used by status");
  };
  const execution = new ArchitectExecution({
    store,
    planning: { selectedForRun: notUsed, validate: async () => notUsed(), store },
    baseUrl: () => "http://127.0.0.1:8188",
    now,
    newId: () => `x${++n}`,
    driver: controller,
    dataDir: dir,
    dependencyLock: () => undefined,
  });
  return { store, comfy, controller, execution, root };
}

describe("the controller's attempts (TODO 6.1.3, 6.2.1)", () => {
  it("smoke, a memory failure at VAEDecode, the tiled-decode repair, a passing smoke, then the final", async () => {
    const h = chainHarness();
    // Attempt 1: the smoke revision, one step and a preview.
    const queued = await h.controller.advance(h.root.id);
    expect(queued.state).toBe("QUEUED");
    const smoke1 = h.comfy.submitted[0];
    expect(smoke1.graph["5"].inputs.steps).toBe(1);
    expect(smoke1.graph["7"]).toEqual({ class_type: "PreviewImage", inputs: { images: ["6", 0] } });
    expect(smoke1.graph["6"].class_type).toBe("VAEDecode");

    // ComfyUI runs out of memory in the VAE decode.
    h.comfy.fail(smoke1.promptId, { node_id: "6", node_type: "VAEDecode", exception_type: "torch.OutOfMemoryError", exception_message: "MPS backend out of memory (MPS allocated: 18 GB)" });
    later(5);
    const failed = await h.controller.reconcile(h.root.id);
    expect(failed.state).toBe("FAILED");
    expect(failed.error?.detail).toEqual({ nodeId: "6", nodeType: "VAEDecode", exceptionType: "torch.OutOfMemoryError", exceptionMessage: "MPS backend out of memory (MPS allocated: 18 GB)" });

    // Attempt 2: the controller repaired it, within the grant, and submitted the tiled smoke.
    let attempts = h.store.listAttempts(h.root.id);
    expect(attempts.map((a) => [a.attempt?.index, a.attempt?.stage, a.attempt?.repairRound, a.state])).toEqual([
      [1, "smoke", 0, "FAILED"],
      [2, "smoke", 1, "QUEUED"],
    ]);
    const smoke2 = h.comfy.submitted[1];
    expect(smoke2.graph["6"]).toMatchObject({ class_type: "VAEDecodeTiled", inputs: { samples: ["5", 0], vae: ["1", 2], tile_size: 512 } });
    expect(smoke2.graph["5"].inputs.steps).toBe(1);
    expect(smoke2.promptId).not.toBe(smoke1.promptId);
    expect(h.store.getLease(memoryPool("http://127.0.0.1:8188"))?.runId).toBe(attempts[1].id);
    const revision2 = h.store.getGraphRevision(attempts[1].attempt?.revisionId ?? "");
    expect(revision2?.steps.map((s) => s.id)).toEqual(["preview.min_steps", "vae.tiled_decode"]);
    expect(revision2?.steps[1]).toMatchObject({ node: "6", failureClass: "memory", failedRunId: h.root.id });
    expect(revision2?.fingerprint).toBe(graphFingerprint(smoke2.graph));

    // The repaired smoke passes its built-in checks; the smoke's output is in temp.
    h.comfy.files.set("smoke.png", await png(1024, 1024));
    h.comfy.finish(smoke2.promptId, "smoke.png", "temp");
    later(5);
    const smokeDone = await h.controller.reconcile(attempts[1].id);
    expect(smokeDone).toMatchObject({ state: "COMPLETED", acceptance: "passed" });

    // Attempt 3: the final, full steps and SaveImage, the repair kept.
    attempts = h.store.listAttempts(h.root.id);
    expect(attempts.map((a) => [a.attempt?.stage, a.attempt?.repairRound, a.state])).toEqual([
      ["smoke", 0, "FAILED"],
      ["smoke", 1, "COMPLETED"],
      ["final", 1, "QUEUED"],
    ]);
    const final = h.comfy.submitted[2];
    expect(final.graph["5"].inputs.steps).toBe(20);
    expect(final.graph["7"]).toEqual(CHAIN_GRAPH["7"]);
    expect(final.graph["6"].class_type).toBe("VAEDecodeTiled");
    const revision3 = h.store.getGraphRevision(attempts[2].attempt?.revisionId ?? "");
    expect(revision3?.steps.map((s) => s.id)).toEqual(["vae.tiled_decode"]);
    expect(revision3?.diff.map((d) => d.node)).toEqual(["6"]);

    h.comfy.files.set("final.png", await png(1024, 1024));
    h.comfy.finish(final.promptId, "final.png", "output");
    later(5);
    const done = await h.controller.reconcile(attempts[2].id);
    expect(done).toMatchObject({ state: "COMPLETED", acceptance: "passed" });
    expect(h.comfy.submitted).toHaveLength(3);
    expect(h.comfy.interrupted).toEqual([]);

    // The root records the stop: passed, with the final as the result.
    const stop = h.store.listRunEvents(h.root.id).find((e) => e.data?.chain === "stopped");
    expect(stop?.data).toMatchObject({ rule: "passed", resultRunId: attempts[2].id, attempts: 3 });

    // Status reports the final's verdicts and each attempt with its transformations and diff.
    const status = await h.execution.status({ runId: h.root.id });
    expect(status.verdicts).toEqual({ execution: "passed", acceptance: "passed", userVerdict: "none" });
    expect(status.chain).toMatchObject({ state: "stopped", stopRule: "passed", resultRunId: attempts[2].id });
    expect(status.attempts?.map((a) => [a.index, a.stage, a.state, a.execution])).toEqual([
      [1, "smoke", "FAILED", "failed"],
      [2, "smoke", "COMPLETED", "passed"],
      [3, "final", "COMPLETED", "passed"],
    ]);
    expect(status.attempts?.[0].error).toMatchObject({ code: "EXECUTION_FAILED", failureClass: "memory" });
    expect(status.attempts?.[2].graph).toMatchObject({ transformations: [{ id: "vae.tiled_decode", node: "6", failureClass: "memory" }] });
  });

  it("evaluates a smoke on the built-in checks only, runs no visual evaluator on it, and never reports it as the result", async () => {
    const visualRuns: string[] = [];
    const visualEvaluation: NonNullable<RunControllerDeps["visualEvaluation"]> = {
      evaluate: async (input) => {
        visualRuns.push(input.run.id);
        throw new Error("a visual evaluator ran");
      },
    };
    const h = chainHarness({ visualEvaluation, task: { acceptance: [{ id: "looks-right", kind: "user_review", required: true, rubric: "A red bicycle?" }, { id: "size", kind: "dimensions", required: true, expected: [512, 512] }] } });
    await h.controller.advance(h.root.id);
    const smoke = h.comfy.submitted[0];
    h.comfy.files.set("smoke.png", await png(1024, 1024));
    h.comfy.finish(smoke.promptId, "smoke.png", "temp");
    const r = await h.controller.reconcile(h.root.id);
    // Passed on the built-in checks; the task's criteria wait for the final, and no review is asked.
    expect(r).toMatchObject({ state: "COMPLETED", acceptance: "passed" });
    const evals = new Map(h.store.listEvaluations(h.root.id).map((e) => [e.criterionId, e.verdict]));
    expect(evals.get("size")).toBe("not_applicable");
    expect(evals.get("looks-right")).toBe("not_applicable");
    expect(evals.get("output_dimensions")).toBe("pass");
    expect(visualRuns).toEqual([]);
    // The final is underway, and the result isn't the smoke's.
    const status = await h.execution.status({ runId: h.root.id });
    expect(status.verdicts.acceptance).toBe("pending");
    expect(status.chain?.resultRunId).toBe(h.store.listAttempts(h.root.id)[1].id);
    await expect(h.execution.evaluate({ runId: h.root.id })).rejects.toThrow(ApprovalError);
  });

  it("stops without a further attempt on a failure no transformation answers, and never after OUTCOME_UNKNOWN", async () => {
    const h = chainHarness();
    await h.controller.advance(h.root.id);
    h.comfy.fail(h.comfy.submitted[0].promptId, { node_id: "5", node_type: "KSampler", exception_type: "RuntimeError", exception_message: "Expected all tensors to be on the same device" });
    await h.controller.reconcile(h.root.id);
    expect(h.store.listAttempts(h.root.id)).toHaveLength(1);
    expect(h.store.listRunEvents(h.root.id).find((e) => e.data?.chain === "stopped")?.data).toMatchObject({ rule: "not_repairable" });
    expect(h.comfy.submitted).toHaveLength(1);

    // A lost submission response: the run stays OUTCOME_UNKNOWN and nothing follows it.
    const u = chainHarnessAgain();
    u.comfy.onSubmit = () => ({ kind: "unknown", message: "socket hang up" });
    const unknown = await u.controller.advance(u.root.id);
    expect(unknown.state).toBe("OUTCOME_UNKNOWN");
    await u.controller.pollOnce();
    expect(u.store.listAttempts(u.root.id)).toHaveLength(1);
    expect(u.comfy.submitted).toHaveLength(1);
  });

  it("stops at the grant's limits: a failed final has no second final to repair into", async () => {
    const h = chainHarness({ chain: { ...CHAIN, stages: [{ stage: "final" }], limits: { maxPreviewRuns: 0, maxFinalRuns: 1, maxRepairRounds: 2 } } });
    expect(h.root.attempt?.stage).toBe("final");
    await h.controller.advance(h.root.id);
    expect(h.comfy.submitted[0].graph).toEqual(CHAIN_GRAPH);
    h.comfy.fail(h.comfy.submitted[0].promptId, { node_id: "6", node_type: "VAEDecode", exception_type: "torch.OutOfMemoryError", exception_message: "out of memory" });
    await h.controller.reconcile(h.root.id);
    expect(h.store.listAttempts(h.root.id)).toHaveLength(1);
    expect(h.store.listRunEvents(h.root.id).find((e) => e.data?.chain === "stopped")?.data).toMatchObject({ rule: "budget_exhausted" });
  });

  it("cancels the attempt in flight and creates none after it", async () => {
    const h = chainHarness();
    await h.controller.advance(h.root.id);
    h.comfy.fail(h.comfy.submitted[0].promptId, { node_id: "6", node_type: "VAEDecode", exception_type: "torch.OutOfMemoryError", exception_message: "out of memory" });
    await h.controller.reconcile(h.root.id);
    const second = h.store.listAttempts(h.root.id)[1];
    expect(second.state).toBe("QUEUED");
    const r = await h.execution.cancel({ runId: h.root.id });
    expect(h.store.getRun(second.id)?.state).toBe("CANCELLED");
    expect(r.chain).toMatchObject({ state: "stopped", stopRule: "cancelled" });
    expect(h.store.listAttempts(h.root.id)).toHaveLength(2);
    expect(h.comfy.submitted).toHaveLength(2);
  });

  it("refuses to submit an attempt whose stored revision no longer gives its fingerprint", async () => {
    const h = chainHarness();
    h.store.close();
    const db = new BetterSqlite3(join(dir, "architect.db"));
    const row = db.prepare("SELECT payload FROM graph_revisions WHERE id = 'grev-smoke'").get() as { payload: string };
    const edited = JSON.parse(row.payload) as GraphRevision;
    edited.fingerprint = "f".repeat(64);
    db.prepare("UPDATE graph_revisions SET payload = ? WHERE id = 'grev-smoke'").run(canonicalJson(edited));
    db.close();
    const store = openStore();
    const controller = new RunController({
      store,
      upstream: h.comfy.facade(),
      resources: { acquire: async (run) => ({ ok: true, lease: { pool: "p", ownerId: "o", runId: run.id, acquiredAt: clock.toISOString(), heartbeatAt: clock.toISOString(), expiresAt: clock.toISOString() } }), heartbeat: () => ({ held: true }), release: () => undefined, restore: async () => undefined },
      now: () => clock,
      newUuid: () => "00000000-0000-4000-8000-000000000099",
      graphFor: async () => CHAIN_GRAPH,
      taskFor: (r) => {
        const t = store.getTask(r.taskId, r.taskRevision);
        if (!t) throw new Error("task missing");
        return t;
      },
    });
    const r = await controller.advance(h.root.id);
    expect(r.state).toBe("FAILED");
    expect(r.error).toMatchObject({ code: "APPROVAL_INVALIDATED" });
    expect(h.comfy.submitted).toEqual([]);
  });
});

/** A second chain harness in the same test, on its own data directory. */
function chainHarnessAgain() {
  dir = mkdtempSync(join(tmpdir(), "architect-attempts-2-"));
  return chainHarness();
}

// ---------------------------------------------------------------------------------------
// Prepare, approval text and start (TODO 6.1.4)

describe("the action plan with stages (TODO 6.1.4)", () => {
  const DEFAULT_TASK = { ...TASK, budgets: {} };

  it("plans a smoke stage and the repairs for the fixture KSampler recipe, and the approval text names them with the limits", async () => {
    const s = await setup(DEFAULT_TASK);
    const r = await s.execution.prepare({ planId: s.planId });
    const render = r.actionPlan.effects.find((e) => e.kind === "local_render");
    expect(render).toMatchObject({
      stages: [{ stage: "smoke", transformation: { id: "preview.min_steps", version: 1 } }, { stage: "final" }],
      repair: { transformations: [{ id: "vae.tiled_decode", version: 1 }, { id: "vae.smaller_tiles", version: 1 }, { id: "retry.unchanged", version: 1 }] },
    });
    expect(r.actionPlan.budgets).toEqual({ maxRuns: 4, maxWallTimeSeconds: 1800, maxPreviewRuns: 3, maxFinalRuns: 1, maxRepairRounds: 2 });
    const text = describeActionPlan(s.store, r.actionPlan);
    expect(text).toContain("Stages: smoke, then final");
    expect(text).toMatch(/Smoke render first \(preview\.min_steps 1: sampler steps set to 1 .*PreviewImage.*\); its result is never reported as the final's/);
    expect(text).toContain("Repairs the controller may apply on its own to a failed attempt");
    expect(text).toMatch(/vae\.tiled_decode 1: the failing VAEDecode becomes VAEDecodeTiled/);
    expect(text).toMatch(/vae\.smaller_tiles 1: .*halved, at least 256/);
    expect(text).toMatch(/retry\.unchanged 1: .*before ComfyUI accepted the prompt/);
    expect(text).toContain("Limits: at most 4 runs in all (3 smoke render(s), 1 final render(s)), 2 repair round(s), at most 1800 s from the first attempt's start for every attempt together");
    // The grant carries the stage limits, never more than the plan's.
    const grant = issueGrant(s, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "terminal", confirmHash: r.shortHash });
    expect(grant.limits).toEqual(r.actionPlan.budgets);
  });

  it("starts the root as a smoke attempt rendering the smoke revision of the approved graph", async () => {
    const s = await setup(DEFAULT_TASK);
    const r = await s.execution.prepare({ planId: s.planId });
    issueGrant(s, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "terminal", confirmHash: r.shortHash });
    const started = await s.execution.start({ actionPlanId: r.actionPlan.id });
    const render = r.actionPlan.effects.find((e) => e.kind === "local_render");
    expect(started.run.graphFingerprint).toBe(render?.kind === "local_render" ? render.graphFingerprint : "");
    expect(started.run.attempt).toMatchObject({ rootRunId: started.run.id, index: 1, stage: "smoke", repairRound: 0 });
    const revision = s.store.getGraphRevision(started.run.attempt?.revisionId ?? "");
    expect(revision?.steps.map((x) => x.id)).toEqual(["preview.min_steps"]);
    expect(revision?.diff.map((d) => d.node)).toEqual(["5", "7"]);
  });

  it("keeps a plan approved with one render as one render: a plan without stages still starts, as before", async () => {
    const s = await setup(DEFAULT_TASK);
    const r = await s.execution.prepare({ planId: s.planId });
    // The plan as milestone 5 built it: no stages, one run.
    const effects = r.actionPlan.effects.map((e) => (e.kind === "local_render" ? { kind: e.kind, graphFingerprint: e.graphFingerprint, outputNodes: e.outputNodes } : e));
    const old = { ...r.actionPlan, id: "actions-old", effects, budgets: { maxRuns: 1, maxWallTimeSeconds: 1800 } };
    const stored = s.store.putActionPlan({ ...old, hash: actionPlanHash(old) });
    const request = s.store.putApprovalRequest({ ...r.approvalRequest, id: "approval-old", actionPlanId: stored.id, actionPlanHash: stored.hash });
    const grant = issueGrant(s, { requestId: request.id, channel: "terminal", issuer: "terminal", confirmHash: stored.hash.slice(0, 8) });
    const started = await s.execution.start({ actionPlanId: stored.id });
    expect(started.run.attempt).toBeUndefined();
    expect(started.run.grantId).toBe(grant.id);
    expect(describeActionPlan(s.store, stored)).toContain("Limits: 1 run, at most 1800 s");
  });

  it("refuses a task whose budgets allow no final render", async () => {
    const s = await setup({ ...TASK, budgets: { maxFinalRuns: 0 } });
    await expect(s.execution.prepare({ planId: s.planId })).rejects.toThrow(/no final render/);
  });
});
