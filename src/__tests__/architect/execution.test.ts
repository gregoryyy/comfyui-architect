import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalError, declineRequest, issueGrant, printable, shortHash } from "../../services/architect/admission.js";
import { runArchitectCli, type CliIo } from "../../services/architect/cli.js";
import { acceptanceOf, recordUserVerdict } from "../../services/architect/execution.js";
import { ActionPlan, type EvaluationRecord } from "../../services/architect/schemas.js";
import type { ArchitectStore } from "../../services/architect/store.js";
import { setup } from "./fixtures/approval-harness.js";

async function expectApprovalError(p: Promise<unknown>, code: ApprovalError["code"]) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApprovalError);
  expect((err as ApprovalError).code).toBe(code);
  return err as ApprovalError;
}

describe("action plans and grants (SEC T1)", () => {
  it("prepare stores an action plan and a pending request; nothing runs", async () => {
    const s = await setup();
    const r = await s.execution.prepare({ planId: s.planId });
    expect(r.approvalRequest.state).toBe("pending");
    expect(r.approvalRequest.actionPlanHash).toBe(r.actionPlan.hash);
    expect(r.shortHash).toBe(shortHash(r.actionPlan.hash));
    expect(r.approval.terminal).toContain(`architect approve ${r.approvalRequest.id}`);
    expect(s.store.listRuns()).toEqual([]);
    expect(s.driver.advance).not.toHaveBeenCalled();
  });

  it("start without a grant is APPROVAL_REQUIRED, names the terminal command and creates no run", async () => {
    const s = await setup();
    const r = await s.execution.prepare({ planId: s.planId });
    const err = await expectApprovalError(s.execution.start({ actionPlanId: r.actionPlan.id }), "APPROVAL_REQUIRED");
    expect(err.nextStep).toContain(`architect approve ${r.approvalRequest.id}`);
    expect(err.data).toEqual({ approvalRequestId: r.approvalRequest.id, shortHash: r.shortHash });
    expect(s.store.listRuns()).toEqual([]);
    expect(s.driver.advance).not.toHaveBeenCalled();
  });

  it("a terminal grant needs the plan's short hash", async () => {
    const s = await setup();
    const r = await s.execution.prepare({ planId: s.planId });
    expect(() => issueGrant(s, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "terminal", confirmHash: "00000000" })).toThrow(ApprovalError);
    expect(() => issueGrant(s, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "terminal" })).toThrow(ApprovalError);
    expect(s.store.getApprovalRequest(r.approvalRequest.id)?.state).toBe("pending");
  });

  it("an approved plan starts one run; starting again returns that run without a second render", async () => {
    const s = await setup();
    const r = await s.execution.prepare({ planId: s.planId });
    const grant = issueGrant(s, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "terminal", confirmHash: r.shortHash });
    const first = await s.execution.start({ actionPlanId: r.actionPlan.id });
    expect(first.resumed).toBe(false);
    expect(first.run.state).toBe("PREPARING");
    expect(first.run.grantId).toBe(grant.id);
    expect(s.store.getGrant(grant.id)?.consumedByRunId).toBe(first.run.id);
    const second = await s.execution.start({ actionPlanId: r.actionPlan.id });
    expect(second.resumed).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    expect(s.driver.advance).toHaveBeenCalledTimes(1);
    expect(s.store.listRuns()).toHaveLength(1);
  });

  it("a grant for one action plan doesn't start another", async () => {
    const s = await setup();
    const a = await s.execution.prepare({ planId: s.planId });
    const b = await s.execution.prepare({ planId: s.planId });
    issueGrant(s, { requestId: a.approvalRequest.id, channel: "terminal", issuer: "terminal", confirmHash: a.shortHash });
    await expectApprovalError(s.execution.start({ actionPlanId: b.actionPlan.id }), "APPROVAL_REQUIRED");
    expect(s.store.listRuns()).toEqual([]);
  });

  it("an expired action plan or request can't be granted or started", async () => {
    const s = await setup();
    const r = await s.execution.prepare({ planId: s.planId });
    s.advance(31 * 60 * 1000);
    expect(() => issueGrant(s, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "terminal", confirmHash: r.shortHash })).toThrow(/expired/);
    expect(s.store.getApprovalRequest(r.approvalRequest.id)?.state).toBe("expired");
    await expectApprovalError(s.execution.start({ actionPlanId: r.actionPlan.id }), "APPROVAL_INVALIDATED");
  });

  it("a declined request can't be granted later", async () => {
    const s = await setup();
    const r = await s.execution.prepare({ planId: s.planId });
    declineRequest(s, r.approvalRequest.id);
    expect(() => issueGrant(s, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "terminal", confirmHash: r.shortHash })).toThrow(/declined/);
  });

  it("a changed environment between grant and start invalidates the approval and keeps the grant unconsumed", async () => {
    const s = await setup();
    const r = await s.execution.prepare({ planId: s.planId });
    const grant = issueGrant(s, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "terminal", confirmHash: r.shortHash });
    // The bound model file disappears from the target.
    s.setModels({ folders: { checkpoints: [] }, unanswered: [], absent: [] });
    await expectApprovalError(s.execution.start({ actionPlanId: r.actionPlan.id }), "APPROVAL_INVALIDATED");
    expect(s.store.getGrant(grant.id)?.consumedAt).toBeUndefined();
    expect(s.store.listRuns()).toEqual([]);
  });

  it("a grant for another target doesn't start a run on this one", async () => {
    const s = await setup();
    const r = await s.execution.prepare({ planId: s.planId });
    issueGrant(s, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "terminal", confirmHash: r.shortHash });
    s.setBaseUrl("http://127.0.0.1:8190");
    await expectApprovalError(s.execution.start({ actionPlanId: r.actionPlan.id }), "APPROVAL_INVALIDATED");
    expect(s.store.listRuns()).toEqual([]);
  });

  it("refuses a target that isn't on this machine (no remote or cloud render in this milestone)", async () => {
    const s = await setup();
    s.setBaseUrl("http://192.168.1.20:8188");
    // The task's renderLocation is local, so planning's policy check refuses it first;
    // admission refuses it again for a task that would allow a remote render.
    await expectApprovalError(s.execution.prepare({ planId: s.planId }), "APPROVAL_INVALIDATED");
    expect(s.store.listRuns()).toEqual([]);
  });

  it("refuses a ComfyUI that can't interrupt by prompt id, or that doesn't report its version", async () => {
    for (const version of ["0.3.56", undefined]) {
      const s = await setup();
      s.setVersion(version);
      const r = await s.execution.prepare({ planId: s.planId });
      issueGrant(s, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "terminal", confirmHash: r.shortHash });
      await expectApprovalError(s.execution.start({ actionPlanId: r.actionPlan.id }), "APPROVAL_INVALIDATED");
      expect(s.store.listRuns()).toEqual([]);
    }
  });

  it("won't prepare a plan again while it has an unfinished run, so a lost outcome can't render twice", async () => {
    const s = await setup();
    const r = await s.execution.prepare({ planId: s.planId });
    issueGrant(s, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "terminal", confirmHash: r.shortHash });
    const { run } = await s.execution.start({ actionPlanId: r.actionPlan.id });
    const err = await expectApprovalError(s.execution.prepare({ planId: s.planId }), "GRAPH_CONFLICT");
    expect(err.message).toContain(run.id);
  });

  it("names the Ollama models it would unload in the approval, with their sizes, and binds them in the hash (GAPS Q23)", async () => {
    const s = await setup();
    const plain = await s.execution.prepare({ planId: s.planId });
    expect(plain.actionPlan.effects.map((e) => e.kind)).toEqual(["local_render"]);
    s.setReleasable({ kind: "release_residency", host: "http://127.0.0.1:11434", models: [{ name: "qwen3:32b", sizeBytes: 21_500_000_000 }], reload: true });
    declineRequest(s, plain.approvalRequest.id);
    const r = await s.execution.prepare({ planId: s.planId });
    expect(r.actionPlan.effects.map((e) => e.kind)).toEqual(["local_render", "release_residency"]);
    expect(r.actionPlan.hash).not.toBe(plain.actionPlan.hash);
    const text = (await import("../../services/architect/admission.js")).describeActionPlan(s.store, r.actionPlan);
    expect(text).toContain("unload from Ollama at http://127.0.0.1:11434 before the render, and load back after it: qwen3:32b (21.5 GB)");
  });

  it("starts with the models the user approved even when Ollama's residency changed since; the approved list is what runs", async () => {
    const s = await setup();
    s.setReleasable({ kind: "release_residency", host: "http://127.0.0.1:11434", models: [{ name: "qwen3:32b", sizeBytes: 1 }], reload: true });
    const r = await s.execution.prepare({ planId: s.planId });
    issueGrant(s, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "terminal", confirmHash: r.shortHash });
    // Another model arrived: the approval isn't widened to it, and isn't invalidated either;
    // the resource coordinator blocks on the unapproved model at run time.
    s.setReleasable({ kind: "release_residency", host: "http://127.0.0.1:11434", models: [{ name: "llama3:70b", sizeBytes: 2 }], reload: true });
    const started = await s.execution.start({ actionPlanId: r.actionPlan.id });
    const plan = s.store.getActionPlan(started.run.actionPlanId)!;
    expect(plan.effects.find((e) => e.kind === "release_residency")).toMatchObject({ models: [{ name: "qwen3:32b" }] });
  });

  it("a stored action plan whose unload list was edited doesn't parse against its hash", async () => {
    const s = await setup();
    s.setReleasable({ kind: "release_residency", host: "http://127.0.0.1:11434", models: [{ name: "qwen3:32b", sizeBytes: 1 }], reload: true });
    const r = await s.execution.prepare({ planId: s.planId });
    const edited = { ...r.actionPlan, effects: r.actionPlan.effects.map((e) => (e.kind === "release_residency" ? { ...e, models: [...e.models, { name: "other:7b", sizeBytes: 1 }] } : e)) };
    expect(ActionPlan.safeParse(edited).success).toBe(false);
  });

  it("the approval text has no control characters and names the run a bounded probe", async () => {
    expect(printable("a\u001b[2Jb\u0007c")).toBe("a?[2Jb?c");
    const s = await setup();
    const r = await s.execution.prepare({ planId: s.planId });
    const { describeActionPlan } = await import("../../services/architect/admission.js");
    const text = describeActionPlan(s.store, r.actionPlan);
    expect(text).toContain("bounded probe");
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
  });

  it("a dialog the user approves grants through elicitation; a declined dialog leaves the request for the terminal", async () => {
    const s = await setup();
    const declined = await s.execution.prepare({ planId: s.planId });
    await expectApprovalError(
      s.execution.start({ actionPlanId: declined.actionPlan.id }, async () => undefined),
      "APPROVAL_REQUIRED",
    );
    expect(s.store.getApprovalRequest(declined.approvalRequest.id)?.state).toBe("pending");

    const approved = await s.execution.prepare({ planId: s.planId });
    const started = await s.execution.start({ actionPlanId: approved.actionPlan.id }, async (_plan, request) =>
      issueGrant(s, { requestId: request.id, channel: "elicitation", issuer: "mcp-client:test" }),
    );
    expect(started.grant).toEqual({ id: expect.any(String), channel: "elicitation" });
  });
});

/** Walk a run to AWAITING_REVIEW with automatic checks of the given verdicts. */
async function runAwaitingReview(s: Awaited<ReturnType<typeof setup>>, automatic: EvaluationRecord["verdict"][]) {
  const r = await s.execution.prepare({ planId: s.planId });
  issueGrant(s, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "terminal", confirmHash: r.shortHash });
  const { run } = await s.execution.start({ actionPlanId: r.actionPlan.id });
  const step = (from: Parameters<ArchitectStore["transitionRun"]>[0]["from"], to: typeof from, patch = {}) =>
    s.store.transitionRun({ runId: run.id, from, to, principal: "controller", reason: "test", patch, at: s.now() });
  step("PREPARING", "VALIDATING");
  step("VALIDATING", "QUEUED", { promptId: "4f1c7a52-2d6b-4a8e-9a3f-0c2b7e5d9a10" });
  step("QUEUED", "EVALUATING", { outputs: [{ node: "9", filename: "out_00001_.png", subfolder: "architect", type: "output" }] });
  // The built-in criteria, in order; those the caller doesn't name pass.
  const builtIn = ["run_completion", "output_count", "output_readable", "output_format", "output_dimensions"];
  builtIn.map((criterionId, i) => ({ criterionId, verdict: automatic[i] ?? ("pass" as const) })).forEach(({ criterionId, verdict }, i) =>
    s.store.putEvaluation({
      schemaVersion: 1,
      id: `eval-auto${i}`,
      runId: run.id,
      criterionId,
      evaluatorId: "architect.output-basic",
      evaluatorVersion: "1",
      verdict,
      source: "automatic",
      explanation: "test",
      createdAt: s.now().toISOString(),
    }),
  );
  step("EVALUATING", "AWAITING_REVIEW");
  return run.id;
}

describe("verdicts (AT-08)", () => {
  it("acceptance keeps machine checks and the user's verdict apart", () => {
    const task = { media: { kind: "image" }, acceptance: [] } as unknown as Parameters<typeof acceptanceOf>[0];
    const builtIn = ["run_completion", "output_count", "output_readable", "output_format", "output_dimensions"];
    const auto = (verdict: EvaluationRecord["verdict"], failOne = false) =>
      builtIn.map((criterionId, i) => ({ criterionId, source: "automatic", verdict: failOne && i === 1 ? verdict : "pass", createdAt: "2026-11-15T12:00:00.000Z" }) as EvaluationRecord);
    const user = (verdict: EvaluationRecord["verdict"], source: EvaluationRecord["source"] = "user") =>
      ({ criterionId: "user_review", source, verdict, createdAt: "2026-11-15T12:01:00.000Z" }) as EvaluationRecord;
    expect(acceptanceOf(task, [...auto("pass"), user("pass")])).toBe("passed");
    expect(acceptanceOf(task, [...auto("fail", true), user("pass")])).toBe("waived_by_user");
    expect(acceptanceOf(task, [...auto("unknown", true), user("pass")])).toBe("waived_by_user");
    expect(acceptanceOf(task, [...auto("pass"), user("fail")])).toBe("failed");
    expect(acceptanceOf(task, auto("pass"))).toBe("passed");
    expect(acceptanceOf(task, auto("fail", true))).toBe("failed");
    expect(acceptanceOf(task, [...auto("unknown", true), user("pass", "agent_reported")])).toBe("pending");
  });

  it("a verdict the agent relays is the agent's report and doesn't complete the run", async () => {
    const s = await setup();
    const runId = await runAwaitingReview(s, ["pass"]);
    const r = await s.execution.evaluate({ runId, reportedVerdict: "accept", note: "user said it looks good" });
    expect(r.userVerdict).toBe("none");
    expect(r.run.state).toBe("AWAITING_REVIEW");
    expect(r.run.acceptance).toBe("pending");
    expect(r.verdicts).toMatchObject({ execution: "passed", acceptance: "pending", userVerdict: "none", agentReported: ["pass"] });
    expect(r.nextStep).toContain(`architect review ${runId}`);
  });

  it("the user's verdict from a dialog completes the run with its acceptance", async () => {
    const s = await setup();
    const runId = await runAwaitingReview(s, ["pass", "fail"]);
    const r = await s.execution.evaluate({ runId }, async () => ({ verdict: "accept", issuer: "mcp-client:test" }));
    expect(r.run.state).toBe("COMPLETED");
    expect(r.run.acceptance).toBe("waived_by_user");
    expect(r.verdicts).toMatchObject({ execution: "passed", acceptance: "waived_by_user", userVerdict: "accepted" });
    const user = s.store.listEvaluations(runId).filter((e) => e.source === "user");
    expect(user).toEqual([expect.objectContaining({ channel: "elicitation", verdict: "pass", criterionId: "user_review" })]);
  });

  it("a later verdict on a completed run updates its acceptance and records why", async () => {
    const s = await setup();
    const runId = await runAwaitingReview(s, ["pass"]);
    expect((await s.execution.evaluate({ runId }, async () => ({ verdict: "accept", issuer: "mcp-client:test" }))).run.acceptance).toBe("passed");
    const r = await s.execution.evaluate({ runId }, async () => ({ verdict: "reject", issuer: "mcp-client:test", note: "hands look wrong" }));
    expect(r.run).toMatchObject({ state: "COMPLETED", acceptance: "failed" });
    expect(s.store.listRunEvents(runId).filter((e) => e.kind === "note").at(-1)?.data).toMatchObject({ previousAcceptance: "passed", acceptance: "failed" });
  });

  it("an agent-relayed verdict doesn't change a completed run's acceptance", async () => {
    const s = await setup();
    const runId = await runAwaitingReview(s, ["pass"]);
    await s.execution.evaluate({ runId }, async () => ({ verdict: "accept", issuer: "mcp-client:test" }));
    const r = await s.execution.evaluate({ runId, reportedVerdict: "reject" });
    expect(r.run.acceptance).toBe("passed");
  });

  it("a run stopped before submission reads not_run, not failed", async () => {
    const s = await setup();
    const r = await s.execution.prepare({ planId: s.planId });
    issueGrant(s, { requestId: r.approvalRequest.id, channel: "terminal", issuer: "terminal", confirmHash: r.shortHash });
    const { run } = await s.execution.start({ actionPlanId: r.actionPlan.id });
    s.store.transitionRun({
      runId: run.id,
      from: "PREPARING",
      to: "FAILED",
      principal: "controller",
      reason: "test",
      patch: { error: { code: "RESOURCE_ESTIMATE_UNKNOWN", message: "Ollama didn't answer" } },
      at: s.now(),
    });
    const status = await s.execution.status({ runId: run.id });
    expect(status.verdicts.execution).toBe("not_run");
  });

  it("finalize refuses to write through a symbolic link under artifacts/", async () => {
    const s = await setup();
    const runId = await runAwaitingReview(s, ["pass"]);
    const run = s.store.getRun(runId)!;
    const outside = join(tmpdir(), `architect-outside-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(s.dataDir, "artifacts", run.taskId), { recursive: true });
    symlinkSync(outside, join(s.dataDir, "artifacts", run.taskId, run.planId));
    expect(() => s.execution.finalize({ runId })).toThrow(/not a plain directory/);
    expect(existsSync(join(outside, "runs"))).toBe(false);
  });

  it("finalize writes run.json with the lineage and evaluation.json", async () => {
    const s = await setup();
    const runId = await runAwaitingReview(s, ["pass"]);
    recordUserVerdict(s, { runId, verdict: "accept", channel: "terminal", issuer: "terminal" });
    const r = s.execution.finalize({ runId });
    expect(r.files.map((f) => f.split("/").pop())).toEqual(["run.json", "evaluation.json", "dependencies.lock.json"]);
    const written = JSON.parse(readFileSync(r.files[0], "utf-8"));
    expect(written.lineage).toMatchObject({
      plan: s.planId,
      promptId: "4f1c7a52-2d6b-4a8e-9a3f-0c2b7e5d9a10",
      grant: { channel: "terminal" },
      dependencyLock: { file: "dependencies.lock.json", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(JSON.parse(readFileSync(r.files[2], "utf-8")).graphFingerprint).toBe(written.lineage.graphFingerprint);
    expect(written.verdicts).toMatchObject({ execution: "passed", acceptance: "passed", userVerdict: "accepted" });
    expect(existsSync(r.files[1])).toBe(true);
  });
});

describe("the terminal channel (cli.ts)", () => {
  function io(answers: string[], interactive = true): CliIo & { out: string[] } {
    const out: string[] = [];
    return { interactive, out, write: (t) => out.push(t), ask: async (q) => (out.push(q), answers.shift() ?? "") };
  }

  it("refuses without an interactive terminal, so an agent's shell tool can't answer it", async () => {
    const s = await setup();
    const r = await s.execution.prepare({ planId: s.planId });
    const t = io([r.shortHash], false);
    expect(await runArchitectCli(["approve", r.approvalRequest.id], { store: s.store, io: t, now: s.now, newId: s.newId })).toBe(2);
    expect(s.store.getApprovalRequest(r.approvalRequest.id)?.state).toBe("pending");
  });

  it("approves with the typed short hash and not with anything else", async () => {
    const s = await setup();
    const r = await s.execution.prepare({ planId: s.planId });
    const wrong = io(["yes"]);
    expect(await runArchitectCli(["approve", r.approvalRequest.id], { store: s.store, io: wrong, now: s.now, newId: s.newId })).toBe(1);
    expect(s.store.getApprovalRequest(r.approvalRequest.id)?.state).toBe("pending");
    const right = io([r.shortHash.toUpperCase()]);
    expect(await runArchitectCli(["approve", r.approvalRequest.id], { store: s.store, io: right, now: s.now, newId: s.newId })).toBe(0);
    expect(right.out.join("")).toContain(r.actionPlan.id);
    expect(s.store.getApprovalRequest(r.approvalRequest.id)?.state).toBe("granted");
  });

  it("lists pending requests and records a review", async () => {
    const s = await setup();
    const runId = await runAwaitingReview(s, ["pass"]);
    const pendingPlan = await s.execution.prepare({ planId: s.planId });
    const listing = io([]);
    expect(await runArchitectCli(["pending"], { store: s.store, io: listing, now: s.now, newId: s.newId })).toBe(0);
    expect(listing.out.join("")).toContain(pendingPlan.approvalRequest.id);
    const t = io(["accept", "fine"]);
    expect(await runArchitectCli(["review", runId], { store: s.store, io: t, now: s.now, newId: s.newId })).toBe(0);
    expect(s.store.getRun(runId)).toMatchObject({ state: "COMPLETED", acceptance: "passed" });
  });
});
