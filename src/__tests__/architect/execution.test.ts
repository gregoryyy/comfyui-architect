import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { ApprovalError, declineRequest, issueGrant, shortHash } from "../../services/architect/admission.js";
import { runArchitectCli, type CliIo } from "../../services/architect/cli.js";
import { acceptanceOf, recordUserVerdict } from "../../services/architect/execution.js";
import type { EvaluationRecord } from "../../services/architect/schemas.js";
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

  it("finalize writes run.json with the lineage and evaluation.json", async () => {
    const s = await setup();
    const runId = await runAwaitingReview(s, ["pass"]);
    recordUserVerdict(s, { runId, verdict: "accept", channel: "terminal", issuer: "terminal" });
    const r = s.execution.finalize({ runId });
    expect(r.files.map((f) => f.split("/").pop())).toEqual(["run.json", "evaluation.json"]);
    const written = JSON.parse(readFileSync(r.files[0], "utf-8"));
    expect(written.lineage).toMatchObject({ plan: s.planId, promptId: "4f1c7a52-2d6b-4a8e-9a3f-0c2b7e5d9a10", grant: { channel: "terminal" } });
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
