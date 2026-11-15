import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { issueGrant } from "../../services/architect/admission.js";
import { ARCHITECT_FLAG_ENV } from "../../services/architect/config.js";
import { ResultEnvelope } from "../../services/architect/schemas.js";
import { registerArchitectRunTool } from "../../tools/architect-run.js";
import { setup } from "./fixtures/approval-harness.js";

// AT-05: no unapproved effect succeeds on any route. The direct tool, the compact
// call_tool route and the panel agent's server all reach architect_run's one handler,
// and its gate; approval comes only from a dialog the user answers or the terminal.

const saved = { route: process.env.ARCHITECT_ROUTE, flag: process.env[ARCHITECT_FLAG_ENV] };
afterEach(() => {
  if (saved.route === undefined) delete process.env.ARCHITECT_ROUTE;
  else process.env.ARCHITECT_ROUTE = saved.route;
  if (saved.flag === undefined) delete process.env[ARCHITECT_FLAG_ENV];
  else process.env[ARCHITECT_FLAG_ENV] = saved.flag;
});

type Harness = Awaited<ReturnType<typeof setup>>;

/** A client connected to architect_run; `answer` is what its dialog returns, if it has one. */
async function connect(s: Harness, answer?: "approve" | "decline") {
  const server = new McpServer({ name: "t", version: "0" });
  registerArchitectRunTool(server, () => ({ execution: s.execution, store: s.store, now: s.now, newId: s.newId }));
  const client = new Client({ name: "test-client", version: "1" }, { capabilities: answer ? { elicitation: { form: {} } } : {} });
  const asked = vi.fn();
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked(req.params.message);
      return { action: "accept", content: { decision: answer } };
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

  it("compact route: call_tool reaches the same handler through upstream's catalog", async () => {
    process.env[ARCHITECT_FLAG_ENV] = "1";
    // The catalog's own context opens a store: keep it out of the user's data directory.
    const dataDir = mkdtempSync(join(tmpdir(), "architect-routes-"));
    const savedDir = process.env.ARCHITECT_DATA_DIR;
    process.env.ARCHITECT_DATA_DIR = dataDir;
    const { collectToolCatalog } = await import("../../tools/index.js");
    const tool = (await collectToolCatalog()).get("architect_run");
    expect(tool?.category).toBe("architect");
    // Without a store behind it the default context can't prepare; what matters here is
    // that the catalog entry is the policy-filtered registration of architect_run and
    // that a start without an action plan is refused, never executed.
    const res = await tool!.handler({ action: "start" });
    const envelope = ResultEnvelope.parse(JSON.parse((res.content as { type: string; text: string }[])[0].text));
    expect(envelope.error?.code).toBe("MISSING_INPUT");
    if (savedDir === undefined) delete process.env.ARCHITECT_DATA_DIR;
    else process.env.ARCHITECT_DATA_DIR = savedDir;
    rmSync(dataDir, { recursive: true, force: true });
  });
});
