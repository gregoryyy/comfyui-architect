// Running the visual evaluators on a run (TODO 6.4.1; ARCH 2026-11-16, visual evaluators;
// GAPS A11): advisory records, acceptance that counts only accepted evaluators, the pool
// lease OCR takes in EVALUATING, the accepted evaluators in the action plan and its approval
// text, and the controller's EVALUATING step with OCR waiting for the pool.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeActionPlan, issueGrant } from "../../services/architect/admission.js";
import { sha256Hex } from "../../services/architect/hash.js";
import { RunController, type RunControllerDeps } from "../../services/architect/controller.js";
import { BUILT_IN_IMAGE_CRITERIA, acceptanceFrom, evaluateOutputs, evaluationId } from "../../services/architect/evaluation.js";
import { acceptEvaluatorChecks, acceptedEvaluatorsFor, evaluatorApprovalLines, quotedForApproval } from "../../services/architect/evaluators/catalog.js";
import type { EvaluatorIo, FetchedOutput, VisualEvaluator } from "../../services/architect/evaluators/contract.js";
import { type PoolLease, VisualEvaluation } from "../../services/architect/evaluators/registry.js";
import { type FetchLike, ResourceCoordinator, memoryPool } from "../../services/architect/resources.js";
import {
  type AcceptanceCriterion,
  type ActionPlan,
  Effect,
  EvaluationRecord,
  RunRecord,
  TaskSpec,
  actionPlanHash,
} from "../../services/architect/schemas.js";
import { ArchitectStore } from "../../services/architect/store.js";
import { createUpstreamFacade } from "../../services/architect/upstream.js";
import { setup, TASK } from "./fixtures/approval-harness.js";
import { BASE_URL, actionPlan as actionPlanFixture, approvalRequest, candidate, env, grant, plan, run as runFixture, task as taskFixture } from "./fixtures/execution-records.js";
import { GRAPH, GRAPH_FINGERPRINT, RUN_CREATED } from "./fixtures/run-harness.js";

const facade = createUpstreamFacade();
const AT = new Date("2026-11-15T12:05:00.000Z");
const SIGN: AcceptanceCriterion = { id: "sign", kind: "text_in_image", required: true, text: "Open now", match: "contains", caseSensitive: false };
const ACCEPTED = { criterionId: "sign", evaluatorId: "architect.ocr-glm", evaluatorVersion: "1" };

/** An Ollama on loopback whose glm-ocr reads `reading`. */
function ollamaIo(reading = "OPEN NOW", host = "http://127.0.0.1:11434"): EvaluatorIo & { posts: number } {
  const io = {
    posts: 0,
    readInputFile: async () => {
      throw new Error("no input files here");
    },
    decodePixels: facade.decodePixels,
    imageForModel: facade.imageForModel,
    ollamaHost: () => host,
    ollamaJson: async (_host: string, path: string) => {
      if (path === "/api/tags") return { status: 200, json: { models: [{ name: "glm-ocr:bf16", digest: "c".repeat(64) }] } };
      io.posts += 1;
      return { status: 200, json: { response: reading } };
    },
  };
  return io;
}

async function outputs(): Promise<FetchedOutput[]> {
  const bytes = await sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  return [{ ref: { node: "2", filename: "sign_00001_.png", subfolder: "", type: "output" }, bytes }];
}

function textTask(criterion: AcceptanceCriterion = SIGN): TaskSpec {
  return TaskSpec.parse({ ...taskFixture, acceptance: [criterion] });
}

function planWith(accepted?: (typeof ACCEPTED)[]): ActionPlan {
  const effects = [{ kind: "local_render" as const, graphFingerprint: "a".repeat(64), outputNodes: ["2"], ...(accepted ? { acceptedEvaluators: accepted } : {}) }];
  const binding = { ...actionPlanFixture, effects };
  return { ...binding, hash: actionPlanHash(binding) };
}

/** A lease that records what the evaluation did with it. */
function fakeLease(held = true): PoolLease & { taken: number; released: number } {
  const lease = {
    taken: 0,
    released: 0,
    take: () => {
      lease.taken += 1;
      return held ? { held: true as const } : { held: false as const, reason: "the memory pool is leased by instance-b for run-other" };
    },
    extend: () => undefined,
    release: () => {
      lease.released += 1;
    },
  };
  return lease;
}

/** The built-in checks, all passed, so acceptance turns on the task's own criteria. */
function builtInsPassed(runId: string): EvaluationRecord[] {
  return BUILT_IN_IMAGE_CRITERIA.map((c) =>
    EvaluationRecord.parse({
      schemaVersion: 1,
      id: evaluationId(runId, c),
      runId,
      criterionId: c,
      evaluatorId: "architect.output-basic",
      evaluatorVersion: "2",
      verdict: "pass",
      source: "automatic",
      explanation: "passed",
      createdAt: AT.toISOString(),
    }),
  );
}

describe("visual evaluation of a run", () => {
  const run = RunRecord.parse(runFixture);

  it("records an OCR verdict the plan didn't accept as advisory, and acceptance ignores it", async () => {
    const lease = fakeLease();
    const result = await new VisualEvaluation({ io: ollamaIo() }).evaluate({ run, task: textTask(), outputs: await outputs(), actionPlan: planWith(), storedIds: new Set(), lease, at: AT });
    expect(result.records).toHaveLength(1);
    const record = EvaluationRecord.parse(result.records[0]);
    expect(record).toMatchObject({ criterionId: "sign", evaluatorId: "architect.ocr-glm", evaluatorVersion: "1", verdict: "pass", advisory: true });
    expect(result.criteria).toEqual(new Set(["sign"]));
    expect(lease).toMatchObject({ taken: 1, released: 1 });
    // A required criterion only an advisory record answers stays pending.
    expect(acceptanceFrom(textTask(), [...builtInsPassed(run.id), record])).toBe("pending");
  });

  it("counts an accepted evaluator's verdict, at the version the plan accepted", async () => {
    const accepted = await new VisualEvaluation({ io: ollamaIo() }).evaluate({ run, task: textTask(), outputs: await outputs(), actionPlan: planWith([ACCEPTED]), storedIds: new Set(), lease: fakeLease(), at: AT });
    const record = EvaluationRecord.parse(accepted.records[0]);
    expect(record.advisory).toBe(false);
    expect(acceptanceFrom(textTask(), [...builtInsPassed(run.id), record])).toBe("passed");

    const failing = await new VisualEvaluation({ io: ollamaIo("Closed for the season") }).evaluate({
      run,
      task: textTask({ ...SIGN, text: "Bakery" }),
      outputs: await outputs(),
      actionPlan: planWith([ACCEPTED]),
      storedIds: new Set(),
      lease: fakeLease(),
      at: AT,
    });
    expect(acceptanceFrom(textTask(), [...builtInsPassed(run.id), EvaluationRecord.parse(failing.records[0])])).toBe("failed");

    const otherVersion = await new VisualEvaluation({ io: ollamaIo() }).evaluate({
      run,
      task: textTask(),
      outputs: await outputs(),
      actionPlan: planWith([{ ...ACCEPTED, evaluatorVersion: "0" }]),
      storedIds: new Set(),
      lease: fakeLease(),
      at: AT,
    });
    expect(otherVersion.records[0].advisory).toBe(true);
  });

  it("waits while another run holds the pool, and gives up as unknown once the wall time is over", async () => {
    const io = ollamaIo();
    const busy = await new VisualEvaluation({ io }).evaluate({ run, task: textTask(), outputs: await outputs(), actionPlan: planWith([ACCEPTED]), storedIds: new Set(), lease: fakeLease(false), at: AT });
    expect(busy.records).toEqual([]);
    expect(busy.waiting).toEqual([{ criterionId: "sign", reason: expect.stringContaining("instance-b") }]);
    expect(io.posts).toBe(0);
    const over = await new VisualEvaluation({ io }).evaluate({
      run,
      task: textTask(),
      outputs: await outputs(),
      actionPlan: planWith([ACCEPTED]),
      storedIds: new Set(),
      lease: fakeLease(false),
      waitOver: "the run passed its 600 s",
      at: AT,
    });
    expect(over.waiting).toEqual([]);
    expect(over.records[0]).toMatchObject({ verdict: "unknown" });
    expect(over.records[0].explanation).toContain("stayed busy");
  });

  it("takes no lease and sends nothing for a non-loopback Ollama", async () => {
    const io = ollamaIo("OPEN NOW", "http://192.168.1.20:11434");
    const lease = fakeLease();
    const r = await new VisualEvaluation({ io }).evaluate({ run, task: textTask(), outputs: await outputs(), actionPlan: planWith([ACCEPTED]), storedIds: new Set(), lease, at: AT });
    expect(r.records[0]).toMatchObject({ verdict: "unknown", advisory: false });
    expect(lease.taken).toBe(0);
    expect(io.posts).toBe(0);
  });

  it("doesn't evaluate a criterion whose record is stored, and records an evaluator that throws as unknown", async () => {
    const io = ollamaIo();
    const stored = new Set([evaluationId(run.id, "sign", "architect.ocr-glm")]);
    const again = await new VisualEvaluation({ io }).evaluate({ run, task: textTask(), outputs: await outputs(), actionPlan: planWith(), storedIds: stored, lease: fakeLease(), at: AT });
    expect(again.records).toEqual([]);
    expect(again.criteria).toEqual(new Set(["sign"]));
    expect(io.posts).toBe(0);

    const broken: VisualEvaluator = {
      id: "architect.ocr-glm",
      version: "1",
      criterionKinds: ["text_in_image"],
      advisoryUnlessAccepted: true,
      usesPool: false,
      availability: async () => ({ available: true }),
      evaluate: async () => {
        throw new Error("boom");
      },
    };
    const r = await new VisualEvaluation({ io, evaluators: [broken] }).evaluate({ run, task: textTask(), outputs: await outputs(), actionPlan: planWith(), storedIds: new Set(), lease: fakeLease(), at: AT });
    expect(r.records[0]).toMatchObject({ verdict: "unknown", explanation: expect.stringContaining("boom") });
  });

  it("hands the protected-region evaluator the inputs the render's grant bound, and its record counts", async () => {
    const source = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
    const mask = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
    const files = new Map([
      ["src.png", source],
      ["mask.png", mask],
    ]);
    const io: EvaluatorIo = { ...ollamaIo(), readInputFile: async (name) => ({ bytes: files.get(name)! }) };
    const keep: AcceptanceCriterion = { id: "keep", kind: "protected_region_exact", required: true, sourceAssetId: "comfyui-input:src.png", maskAssetId: "comfyui-input:mask.png", coordinateSpace: "source_pixels" };
    const effects = [
      {
        kind: "local_render" as const,
        graphFingerprint: "a".repeat(64),
        outputNodes: ["2"],
        inputs: [...files].map(([name, bytes]) => ({ assetId: `comfyui-input:${name}`, sha256: sha256Hex(bytes), sizeBytes: bytes.length })),
      },
    ];
    const binding = { ...actionPlanFixture, effects };
    const lease = fakeLease();
    const r = await new VisualEvaluation({ io }).evaluate({
      run,
      task: textTask(keep),
      outputs: [{ ref: { node: "2", filename: "out.png", subfolder: "", type: "output" }, bytes: source }],
      actionPlan: { ...binding, hash: actionPlanHash(binding) },
      storedIds: new Set(),
      lease,
      at: AT,
    });
    expect(r.records[0]).toMatchObject({ criterionId: "keep", evaluatorId: "architect.protected-region", verdict: "pass", advisory: false });
    // It reads no model, so it takes no pool lease.
    expect(lease.taken).toBe(0);
  });

  it("leaves a criterion no visual evaluator ran on to the built-in step, as unknown", () => {
    const records = evaluateOutputs({ run: { ...run, state: "EVALUATING", promptId: "4f1c7a52-2d6b-4a8e-9a3f-0c2b7e5d9a10" }, task: textTask(), files: [], at: AT });
    expect(records.find((r) => r.criterionId === "sign")).toMatchObject({ verdict: "unknown", evaluatorId: "architect.output-basic" });
    const skipped = evaluateOutputs({ run: { ...run, state: "EVALUATING", promptId: "4f1c7a52-2d6b-4a8e-9a3f-0c2b7e5d9a10" }, task: textTask(), files: [], visualCriteria: new Set(["sign"]), at: AT });
    expect(skipped.find((r) => r.criterionId === "sign")).toBeUndefined();
  });
});

describe("accepted evaluators in the plan", () => {
  it("lists only a criterion whose acceptEvaluator names an evaluator for its kind, and nothing otherwise", () => {
    expect(acceptedEvaluatorsFor(textTask())).toBeUndefined();
    expect(acceptedEvaluatorsFor(textTask({ ...SIGN, acceptEvaluator: "architect.ocr-glm" }))).toEqual([ACCEPTED]);
    expect(acceptedEvaluatorsFor(textTask({ ...SIGN, acceptEvaluator: "architect.vision-rubric" }))).toBeUndefined();
    const checks = acceptEvaluatorChecks(textTask({ ...SIGN, acceptEvaluator: "architect.vision-rubric" }));
    expect(checks).toEqual([expect.objectContaining({ id: "contract.acceptance.sign.evaluator", verdict: "fail", hard: true })]);
    expect(acceptEvaluatorChecks(textTask({ ...SIGN, acceptEvaluator: "architect.ocr-glm" }))[0].verdict).toBe("pass");
    expect(acceptEvaluatorChecks(textTask())).toEqual([]);
  });

  it("keeps the hash of a render without accepted evaluators as it was", () => {
    const raw = { kind: "local_render", graphFingerprint: "a".repeat(64), outputNodes: ["2"] };
    const parsed = Effect.parse(raw);
    expect(Object.keys(parsed)).not.toContain("acceptedEvaluators");
    const binding = { ...actionPlanFixture, effects: [parsed] };
    expect(actionPlanHash(binding)).toBe(actionPlanFixture.hash);
    expect(Effect.safeParse({ ...raw, acceptedEvaluators: [] }).success).toBe(false);
    expect(Effect.safeParse({ ...raw, acceptedEvaluators: [ACCEPTED, ACCEPTED] }).success).toBe(false);
  });

  it("reads a stored evaluation without the advisory field as counted", () => {
    const old = { schemaVersion: 1, id: "eval-1", runId: "run-1", criterionId: "x", evaluatorId: "e", evaluatorVersion: "1", verdict: "pass", source: "automatic", explanation: "ok", createdAt: AT.toISOString() };
    expect(EvaluationRecord.parse(old).advisory).toBe(false);
  });

  it("binds the accepted evaluator in the action plan and says in the approval that the OCR verdict counts", async () => {
    const s = await setup();
    const prepared = await s.planning.prepare({ task: { ...TASK, acceptance: [{ ...SIGN, acceptEvaluator: "architect.ocr-glm" }] } });
    const proposed = await s.planning.propose({ planId: prepared.plan.id });
    const best = proposed.candidates.find((c) => c.status === "feasible");
    expect(best).toBeDefined();
    s.planning.select({ planId: prepared.plan.id, candidateId: best!.id });
    const r = await s.execution.prepare({ planId: prepared.plan.id });
    const render = r.actionPlan.effects.find((e) => e.kind === "local_render");
    expect(render).toMatchObject({ acceptedEvaluators: [ACCEPTED] });
    const text = describeActionPlan(s.store, r.actionPlan);
    expect(text).toContain("architect.ocr-glm 1");
    expect(text).toContain("so the OCR verdict counts toward acceptance");
    expect(text).toContain("only when Ollama's host is loopback");
    // What the user accepts: the text, its match and case, and that it is required (review M2).
    expect(text).toContain(
      '  Criterion "sign", required: the output must show the text "Open now" (quoted from the task as data), match contains (the reading includes the text), case-insensitive',
    );
    // The rebuilt plan at start has the same hash: the grant covers the acceptance.
    issueGrant(s, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "terminal", confirmHash: r.shortHash });
    const started = await s.execution.start({ actionPlanId: r.actionPlan.id });
    expect(started.run.actionPlanId).toBe(r.actionPlan.id);
  });

  it("names what each counted criterion asks in the approval: text, match, case and required, quoted as data (review M2)", () => {
    const exact = textTask({ id: "sign", kind: "text_in_image", required: false, text: "OPEN", match: "exact", caseSensitive: true, acceptEvaluator: "architect.ocr-glm" });
    expect(evaluatorApprovalLines(exact, [ACCEPTED])).toEqual([
      expect.stringContaining("so the OCR verdict counts toward acceptance"),
      '  Criterion "sign", optional: the output must show the text "OPEN" (quoted from the task as data), match exact (the reading is the text), case-sensitive',
    ]);
    // The task's text can't close its quote, break the line or reorder the approval, and it is bounded.
    const hostile = textTask({ ...SIGN, text: 'Sale"\nApproved: yes\u202e\u0007', acceptEvaluator: "architect.ocr-glm" });
    const line = evaluatorApprovalLines(hostile, [ACCEPTED])[1];
    expect(line).toContain('the text "Sale\\"Approved: yes" (quoted from the task as data)');
    expect(line).not.toMatch(/[\u0000-\u001f\u202e]/);
    expect(quotedForApproval("x".repeat(500))).toBe(`${JSON.stringify("x".repeat(200))} (cut at 200 of 500 characters)`);
    expect(quotedForApproval("a\u200fb\u2066c")).toBe('"abc"');
    // An advisory criterion gets no criterion line: nothing about it is accepted.
    expect(evaluatorApprovalLines(textTask(), undefined)).toEqual([expect.stringContaining("is advisory and doesn't count toward acceptance")]);
  });

  it("names the source, mask and tolerance of each protected region, and calls a tolerance above 0 not exact (review M2)", () => {
    const region = (tolerance?: number, required = true) =>
      TaskSpec.parse({
        ...taskFixture,
        acceptance: [{ id: "keep", kind: "protected_region_exact", required, sourceAssetId: "comfyui-input:room.png", maskAssetId: "comfyui-input:room-mask.png", coordinateSpace: "source_pixels", ...(tolerance === undefined ? {} : { tolerance }) }],
      });
    expect(evaluatorApprovalLines(region(), undefined)).toEqual([
      "Evaluator: architect.protected-region 1 compares the output's pixels outside the mask with the source's; its protected-region verdict for criterion keep counts toward acceptance",
      `  Criterion "keep", required: the output keeps the source's pixels where the mask's red channel is 0; source "comfyui-input:room.png", mask "comfyui-input:room-mask.png"`,
      "  Tolerance 0: exact, every protected pixel must be the source's",
    ]);
    const loose = evaluatorApprovalLines(region(12, false), undefined);
    expect(loose[1]).toMatch(/^  Criterion "keep", optional:/);
    expect(loose[2]).toBe("  Tolerance 12: not exact, a protected pixel may differ from the source's by up to 12 of 255 per channel and still pass");
  });

  it("says in the approval that an OCR verdict the task didn't accept is advisory", async () => {
    const s = await setup();
    const prepared = await s.planning.prepare({ task: { ...TASK, acceptance: [SIGN] } });
    const proposed = await s.planning.propose({ planId: prepared.plan.id });
    s.planning.select({ planId: prepared.plan.id, candidateId: proposed.candidates.find((c) => c.status === "feasible")!.id });
    const r = await s.execution.prepare({ planId: prepared.plan.id });
    expect(r.actionPlan.effects.find((e) => e.kind === "local_render")).not.toHaveProperty("acceptedEvaluators");
    const text = describeActionPlan(s.store, r.actionPlan);
    expect(text).toContain("is advisory and doesn't count toward acceptance");
    expect(text).not.toContain("counts toward acceptance once");
  });
});

// ---------------------------------------------------------------------------------------
// The controller's EVALUATING step

const PROMPT = "11111111-2222-4333-8444-555555555555";
let dir: string;
let clock: Date;
const stores: ArchitectStore[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "architect-visual-"));
  clock = new Date(RUN_CREATED);
});
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

const refused: FetchLike = async () => {
  throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
};

/** A run in PREPARING whose task asks for text and whose plan accepts OCR for it. */
function seed(store: ArchitectStore): RunRecord {
  const budgets = { maxRuns: 1, maxWallTimeSeconds: 600 };
  const effects = [{ kind: "local_render" as const, graphFingerprint: GRAPH_FINGERPRINT, outputNodes: ["2"], acceptedEvaluators: [ACCEPTED] }];
  const binding = { planId: actionPlanFixture.planId, taskId: actionPlanFixture.taskId, taskRevision: 1, candidateId: actionPlanFixture.candidateId, target: actionPlanFixture.target, effects, budgets };
  const hash = actionPlanHash(binding);
  store.putTaskRevision({ ...taskFixture, acceptance: [SIGN] });
  store.putSnapshot(env);
  store.putPlan(plan);
  store.putCandidate({ ...candidate, graphFingerprint: GRAPH_FINGERPRINT });
  store.putActionPlan({ ...actionPlanFixture, effects, budgets, hash });
  store.putApprovalRequest({ ...approvalRequest, actionPlanHash: hash });
  store.resolveApprovalRequest(approvalRequest.id, "granted", new Date("2026-11-15T12:01:00.000Z"));
  store.putGrant({ ...grant, actionPlanHash: hash, limits: budgets });
  return store.createRunWithGrant({ run: { ...runFixture, graphFingerprint: GRAPH_FINGERPRINT }, grantId: grant.id, now: RUN_CREATED }).run;
}

async function controllerHarness() {
  const store = ArchitectStore.open(dir, { now: () => clock });
  stores.push(store);
  const run = seed(store);
  const now = () => new Date(clock);
  const pending: string[] = [];
  const history = new Map<string, unknown>();
  // The task asks for 1024×1024, so the built-in checks pass and acceptance turns on OCR.
  const image = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  const upstream: RunControllerDeps["upstream"] = {
    submitPrompt: async (_graph, promptId) => {
      pending.push(promptId);
      return { kind: "accepted", promptId };
    },
    queue: async () => ({ running: [], pending: [...pending] }),
    history: async (promptId) => history.get(promptId) as Awaited<ReturnType<RunControllerDeps["upstream"]["history"]>>,
    dequeue: async () => ({ removed: false, state: "absent", verified: true }),
    interruptPrompt: async () => undefined,
    outputFile: async () => ({ bytes: image, mimeType: "image/png" }),
    decodeImage: (bytes) => facade.decodeImage(bytes),
  };
  const coordinator = new ResourceCoordinator({
    store,
    upstream: { ollamaHost: () => "http://127.0.0.1:11434", loadOllama: async () => true, isOwnHostAddress: () => false },
    ownerId: "instance-a",
    now,
    manageResidency: false,
    fetchImpl: refused,
    probeTimeoutMs: 20,
  });
  const io = ollamaIo();
  const controller = new RunController({
    store,
    upstream,
    resources: coordinator,
    now,
    newUuid: () => PROMPT,
    graphFor: async () => GRAPH,
    taskFor: (r) => store.getTask(r.taskId, r.taskRevision)!,
    visualEvaluation: new VisualEvaluation({ io }),
  });
  const finish = () => {
    pending.splice(0);
    history.set(PROMPT, {
      prompt: {},
      outputs: { "2": { images: [{ filename: "sign_00001_.png", subfolder: "", type: "output" }] } },
      status: { status_str: "success", completed: true, messages: [["execution_success", {}]] },
    });
  };
  return { store, run, controller, finish, io };
}

describe("the controller's evaluation with OCR", () => {
  it("waits in EVALUATING while another run holds the pool, then reads with the lease and counts the accepted verdict", async () => {
    const h = await controllerHarness();
    expect((await h.controller.advance(h.run.id)).state).toBe("QUEUED");
    h.finish();
    // Another instance takes the pool the moment the render is done.
    const pool = memoryPool(BASE_URL);
    const queued = h.store.getRun(h.run.id)!;
    h.store.releaseLease({ pool, ownerId: "instance-a" });
    h.store.acquireLease({ pool, ownerId: "instance-b", now: clock, ttlMs: 60_000 });
    const waiting = await h.controller.reconcile(queued.id);
    expect(waiting.state).toBe("EVALUATING");
    expect(h.io.posts).toBe(0);
    const notes = h.store.listRunEvents(h.run.id).filter((e) => e.kind === "note" && e.data?.waitingForPool === true);
    expect(notes).toHaveLength(1);
    expect(h.store.listEvaluations(h.run.id).map((e) => e.criterionId)).toEqual([]);

    // A second pass while it is still busy adds no second note.
    await h.controller.reconcile(h.run.id);
    expect(h.store.listRunEvents(h.run.id).filter((e) => e.kind === "note" && e.data?.waitingForPool === true)).toHaveLength(1);

    h.store.releaseLease({ pool, ownerId: "instance-b" });
    clock = new Date(clock.getTime() + 5_000);
    const done = await h.controller.reconcile(h.run.id);
    expect(done).toMatchObject({ state: "COMPLETED", acceptance: "passed" });
    expect(h.io.posts).toBe(1);
    const ocr = h.store.listEvaluations(h.run.id).find((e) => e.criterionId === "sign");
    expect(ocr).toMatchObject({ evaluatorId: "architect.ocr-glm", verdict: "pass", advisory: false });
    expect(h.store.getLease(pool)).toBeUndefined();
  });
});
