import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { issueGrant } from "../../services/architect/admission.js";
import { ARCHITECT_FLAG_ENV } from "../../services/architect/config.js";
import { ResultEnvelope } from "../../services/architect/schemas.js";
import { registerArchitectRunTool } from "../../tools/architect-run.js";
import { ToolCatalog } from "../../tools/catalog.js";
import { setup } from "./fixtures/approval-harness.js";

// AT-05: no unapproved effect succeeds on any route. The direct tool, the compact
// call_tool route and the panel agent's server all reach architect_run's one handler,
// and its gate; approval comes only from a dialog the user answers or the terminal.

const saved = { route: process.env.ARCHITECT_ROUTE, flag: process.env[ARCHITECT_FLAG_ENV], panelRuns: process.env.ARCHITECT_PANEL_RUNS };
afterEach(() => {
  if (saved.route === undefined) delete process.env.ARCHITECT_ROUTE;
  else process.env.ARCHITECT_ROUTE = saved.route;
  if (saved.flag === undefined) delete process.env[ARCHITECT_FLAG_ENV];
  else process.env[ARCHITECT_FLAG_ENV] = saved.flag;
  if (saved.panelRuns === undefined) delete process.env.ARCHITECT_PANEL_RUNS;
  else process.env.ARCHITECT_PANEL_RUNS = saved.panelRuns;
});

type Harness = Awaited<ReturnType<typeof setup>>;

/** A client connected to architect_run; `answer` is what its dialog returns, if it has one. */
async function connect(s: Harness, answer?: "approve" | "decline" | "empty") {
  const server = new McpServer({ name: "t", version: "0" });
  registerArchitectRunTool(server, () => ({ execution: s.execution, store: s.store, now: s.now, newId: s.newId }));
  const client = new Client({ name: "test-client", version: "1" }, { capabilities: answer ? { elicitation: { form: {} } } : {} });
  const asked = vi.fn();
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked(req.params.message);
      // "empty" is Codex's automatic answer: accept with no content.
      return answer === "empty" ? { action: "accept", content: {} } : { action: "accept", content: { decision: answer } };
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name: "architect_run", arguments: args });
    const content = res.content as { type: string; text: string }[];
    return ResultEnvelope.parse(JSON.parse(content[0].text));
  };
  return { call, asked };
}

describe("architect_run across routes (AT-05)", () => {
  it("has no parameter through which a model could pass an approval", async () => {
    const s = await setup();
    const server = new McpServer({ name: "t", version: "0" });
    registerArchitectRunTool(server, () => ({ execution: s.execution, store: s.store, now: s.now, newId: s.newId }));
    const client = new Client({ name: "c", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    const tool = (await client.listTools()).tools.find((t) => t.name === "architect_run");
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(["action", "actionPlanId", "note", "planId", "reportedVerdict", "runId"]);
  });

  it("direct route, no dialog: start is APPROVAL_REQUIRED until the terminal grants, then runs once", async () => {
    const s = await setup();
    const { call } = await connect(s);
    const prepared = await call({ action: "prepare", planId: s.planId });
    const actionPlanId = (prepared.data.actionPlan as { id: string }).id;
    const refused = await call({ action: "start", actionPlanId });
    expect(refused.error?.code).toBe("APPROVAL_REQUIRED");
    expect(s.store.listRuns()).toEqual([]);
    const request = prepared.data.approvalRequest as { id: string };
    issueGrant(s, { requestId: request.id, channel: "terminal", issuer: "terminal", confirmHash: prepared.data.shortHash as string });
    const started = await call({ action: "start", actionPlanId });
    expect(started.status).toBe("ok");
    expect(s.store.listRuns()).toHaveLength(1);
  });

  it("direct route with a dialog: the user's approve grants through elicitation; a decline doesn't", async () => {
    const s = await setup();
    const declining = await connect(s, "decline");
    const p1 = await declining.call({ action: "prepare", planId: s.planId });
    expect((await declining.call({ action: "start", actionPlanId: (p1.data.actionPlan as { id: string }).id })).error?.code).toBe("APPROVAL_REQUIRED");
    expect(declining.asked).toHaveBeenCalledTimes(1);
    expect(s.store.listRuns()).toEqual([]);

    const approving = await connect(s, "approve");
    const p2 = await approving.call({ action: "prepare", planId: s.planId });
    const started = await approving.call({ action: "start", actionPlanId: (p2.data.actionPlan as { id: string }).id });
    expect(started.status).toBe("ok");
    expect(approving.asked.mock.calls[0][0]).toContain((p2.data.shortHash as string));
    const run = s.store.listRuns()[0];
    expect(s.store.getGrant(run.grantId!)).toMatchObject({ channel: "elicitation", issuer: "mcp-client:test-client@1" });
  });

  it("panel route: no dialog is shown even to a client that would approve, so nothing runs without the terminal", async () => {
    process.env.ARCHITECT_ROUTE = "panel";
    const s = await setup();
    const { call, asked } = await connect(s, "approve");
    const prepared = await call({ action: "prepare", planId: s.planId });
    const refused = await call({ action: "start", actionPlanId: (prepared.data.actionPlan as { id: string }).id });
    expect(refused.error?.code).toBe("APPROVAL_REQUIRED");
    expect(asked).not.toHaveBeenCalled();
    expect(s.store.listRuns()).toEqual([]);
  });

  it("panel route: even a grant the terminal issued doesn't start a run there", async () => {
    process.env.ARCHITECT_ROUTE = "panel";
    const s = await setup();
    const { call } = await connect(s);
    const prepared = await call({ action: "prepare", planId: s.planId });
    const request = prepared.data.approvalRequest as { id: string };
    issueGrant(s, { requestId: request.id, channel: "terminal", issuer: "terminal", confirmHash: prepared.data.shortHash as string });
    const refused = await call({ action: "start", actionPlanId: (prepared.data.actionPlan as { id: string }).id });
    expect(refused.error?.code).toBe("APPROVAL_REQUIRED");
    expect(refused.summary).toContain("panel");
    expect(s.store.listRuns()).toEqual([]);
  });

  it("panel route with ARCHITECT_PANEL_RUNS=terminal: a terminal grant starts the run, and still no dialog is shown", async () => {
    process.env.ARCHITECT_ROUTE = "panel";
    process.env.ARCHITECT_PANEL_RUNS = "terminal";
    const s = await setup();
    const { call, asked } = await connect(s, "approve");
    const prepared = await call({ action: "prepare", planId: s.planId });
    const actionPlanId = (prepared.data.actionPlan as { id: string }).id;
    expect((await call({ action: "start", actionPlanId })).error?.code).toBe("APPROVAL_REQUIRED");
    expect(asked).not.toHaveBeenCalled();
    expect(s.store.listRuns()).toEqual([]);
    issueGrant(s, { requestId: (prepared.data.approvalRequest as { id: string }).id, channel: "terminal", issuer: "terminal", confirmHash: prepared.data.shortHash as string });
    expect((await call({ action: "start", actionPlanId })).status).toBe("ok");
    expect(s.store.listRuns()).toHaveLength(1);
  });

  it("panel route: any other ARCHITECT_PANEL_RUNS value keeps start refused", async () => {
    process.env.ARCHITECT_ROUTE = "panel";
    process.env.ARCHITECT_PANEL_RUNS = "yes";
    const s = await setup();
    const { call } = await connect(s);
    const prepared = await call({ action: "prepare", planId: s.planId });
    issueGrant(s, { requestId: (prepared.data.approvalRequest as { id: string }).id, channel: "terminal", issuer: "terminal", confirmHash: prepared.data.shortHash as string });
    const refused = await call({ action: "start", actionPlanId: (prepared.data.actionPlan as { id: string }).id });
    expect(refused.error?.code).toBe("APPROVAL_REQUIRED");
    expect(refused.error?.nextStep).toContain("ARCHITECT_PANEL_RUNS=terminal");
    expect(s.store.listRuns()).toEqual([]);
  });

  it("a dialog accepted with empty content grants nothing", async () => {
    const s = await setup();
    const { call, asked } = await connect(s, "empty");
    const prepared = await call({ action: "prepare", planId: s.planId });
    const refused = await call({ action: "start", actionPlanId: (prepared.data.actionPlan as { id: string }).id });
    expect(asked).toHaveBeenCalledTimes(1);
    expect(refused.error?.code).toBe("APPROVAL_REQUIRED");
    expect(s.store.getApprovalRequest((prepared.data.approvalRequest as { id: string }).id)?.state).toBe("pending");
  });

  it("compact route: upstream's catalog captures the same handler; no dialog, and the gate holds with and without a grant", async () => {
    const s = await setup();
    const catalog = new ToolCatalog();
    registerArchitectRunTool(catalog.asRegistrar(), () => ({ execution: s.execution, store: s.store, now: s.now, newId: s.newId }));
    const tool = catalog.get("architect_run");
    const call = async (args: Record<string, unknown>) => {
      const res = await tool!.handler(args);
      return ResultEnvelope.parse(JSON.parse((res.content as { type: string; text: string }[])[0].text));
    };
    const prepared = await call({ action: "prepare", planId: s.planId });
    const actionPlanId = (prepared.data.actionPlan as { id: string }).id;
    expect((await call({ action: "start", actionPlanId })).error?.code).toBe("APPROVAL_REQUIRED");
    expect(s.store.listRuns()).toEqual([]);
    issueGrant(s, { requestId: (prepared.data.approvalRequest as { id: string }).id, channel: "terminal", issuer: "terminal", confirmHash: prepared.data.shortHash as string });
    expect((await call({ action: "start", actionPlanId })).status).toBe("ok");
    expect(s.store.listRuns()).toHaveLength(1);
  });
});
