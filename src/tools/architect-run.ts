// `architect_run` (spec §16.1; TODO 3.3-3.9): runs a selected candidate under the user's
// approval. Registered with the other Architect tools, through upstream's registrar, so the
// direct, compact and panel routes reach this one handler and its one gate (spec §14.3).
//
// No parameter carries an approval or a verdict that counts as the user's. Approvals and
// verdicts come from a client dialog only the user answers (MCP form elicitation) or from
// the terminal command; on the panel route there is no dialog, because upstream's panel
// Codex agent accepts every elicitation (GAPS Q20, ARCH 2026-11-15).

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ARCHITECT_SCHEMA_VERSION } from "../fork-identity.js";
import { ApprovalError, describeActionPlan, issueGrant } from "../services/architect/admission.js";
import { onPanelRoute } from "../services/architect/config.js";
import type { ApprovalDialog, ArchitectExecution, VerdictDialog } from "../services/architect/execution.js";
import { PlanningError } from "../services/architect/planning.js";
import type { ResultEnvelope } from "../services/architect/schemas.js";
import type { ArchitectStore } from "../services/architect/store.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** How long a dialog may wait for the user before the call returns without an answer. */
const DIALOG_TIMEOUT_MS = 5 * 60 * 1000;

export interface RunToolContext {
  execution: ArchitectExecution;
  store: ArchitectStore;
  now: () => Date;
  newId: () => string;
}

function envelope(status: ResultEnvelope["status"], summary: string, data: Record<string, unknown>, extra: Partial<ResultEnvelope> = {}): ToolResult {
  const e: ResultEnvelope = { schemaVersion: ARCHITECT_SCHEMA_VERSION, operationId: `op-${randomUUID()}`, status, summary, data, warnings: [], artifacts: [], ...extra };
  return { content: [{ type: "text", text: JSON.stringify(e, null, 2) }], ...(status === "error" ? { isError: true } : {}) };
}

function errorReply(err: unknown): ToolResult {
  if (err instanceof ApprovalError) {
    return envelope("error", err.message, err.data ?? {}, { error: { code: err.code, retryable: err.code === "APPROVAL_REQUIRED", nextStep: err.nextStep } });
  }
  if (err instanceof PlanningError) {
    return envelope("error", err.message, {}, { error: { code: err.code, retryable: err.retryable, nextStep: err.nextStep } });
  }
  return envelope("error", err instanceof Error ? err.message : String(err), {}, {
    // Not OUTCOME_UNKNOWN for the caller to act on: a run whose submission is in doubt is
    // recorded as such on the run itself, and status reports it.
    error: { code: "INTERNAL_ERROR", retryable: false, nextStep: "Call status for the run before doing anything else; never start the same plan twice." },
  });
}

/**
 * The protocol connection behind the registrar. On the compact route the tools are captured
 * by upstream's catalog through a registrar that has no connection, so there is no dialog
 * there and approval goes through the terminal.
 */
function connection(server: McpServer): McpServer["server"] | undefined {
  const inner: unknown = (server as { server?: unknown }).server;
  return inner !== null && typeof inner === "object" && typeof (inner as { elicitInput?: unknown }).elicitInput === "function"
    ? (inner as McpServer["server"])
    : undefined;
}

function clientIssuer(server: McpServer): string {
  const client = connection(server)?.getClientVersion();
  return `mcp-client:${client?.name ?? "unknown"}${client?.version ? `@${client.version}` : ""}`;
}

/** Whether this connection can show the user a form dialog. */
function canAsk(server: McpServer): boolean {
  return !onPanelRoute() && connection(server)?.getClientCapabilities()?.elicitation?.form !== undefined;
}

/**
 * The approval dialog. Only an explicit "approve" grants. A decline or cancel leaves the
 * request pending, because some clients answer elicitations without showing them (the VS
 * Code extension was reported to decline every one), and the terminal command must still
 * work after that.
 */
function approvalDialog(server: McpServer, ctx: RunToolContext): ApprovalDialog | undefined {
  if (!canAsk(server)) return undefined;
  return async (actionPlan, request) => {
    try {
      const result = await connection(server)!.elicitInput(
        {
          mode: "form",
          message: `ComfyUI Architect asks you to approve a run.\n\n${describeActionPlan(ctx.store, actionPlan)}\n\nOnly you can answer this.`,
          requestedSchema: {
            type: "object",
            // Decline first: a client that pre-fills the first option must not approve.
            properties: { decision: { type: "string", title: "Decision", enum: ["decline", "approve"] } },
            required: ["decision"],
          },
        },
        { timeout: DIALOG_TIMEOUT_MS },
      );
      if (result.action !== "accept" || result.content?.decision !== "approve") return undefined;
      return issueGrant(ctx, { requestId: request.id, channel: "elicitation", issuer: clientIssuer(server) });
    } catch {
      // No answer (timeout, a client that can't render it): no grant; the terminal remains.
      return undefined;
    }
  };
}

function verdictDialog(server: McpServer): VerdictDialog | undefined {
  if (!canAsk(server)) return undefined;
  return async (_run, summary) => {
    try {
      const result = await connection(server)!.elicitInput(
        {
          mode: "form",
          message: `ComfyUI Architect asks for your verdict on a run's outputs.\n\n${summary}`,
          requestedSchema: {
            type: "object",
            properties: {
              verdict: { type: "string", title: "Verdict", enum: ["reject", "accept"] },
              note: { type: "string", title: "Note (optional)" },
            },
            required: ["verdict"],
          },
        },
        { timeout: DIALOG_TIMEOUT_MS },
      );
      const verdict = result.content?.verdict;
      if (result.action !== "accept" || (verdict !== "accept" && verdict !== "reject")) return undefined;
      const note = typeof result.content?.note === "string" && result.content.note.trim() ? result.content.note.trim() : undefined;
      return { verdict, issuer: clientIssuer(server), ...(note ? { note } : {}) };
    } catch {
      return undefined;
    }
  };
}

function need<T>(value: T | undefined, name: string, action: string): T {
  if (value === undefined) throw new PlanningError("MISSING_INPUT", `action "${action}" needs \`${name}\``, `Call architect_run again with ${name}.`);
  return value;
}

export function registerArchitectRunTool(server: McpServer, context: () => RunToolContext): void {
  server.tool(
    "architect_run",
    "ComfyUI Architect: run a selected candidate locally under the user's approval, follow it and record its outcome. " +
      'action:"prepare" with `planId` (a plan with a selected candidate) validates it again and returns an action plan, its short hash ' +
      "and an approval request; tell the user what will run. For an acquirable candidate the action plan also downloads its missing " +
      "model files first, each from the source its recipe pins (Hugging Face, a fixed commit), checked against its sha256 before it is " +
      "placed: tell the user each file, its size and where it goes. You never supply a URL or a file. " +
      'action:"start" with `actionPlanId` starts the run when the user has approved: where the client supports it, the user is asked ' +
      "in a dialog; otherwise the reply says APPROVAL_REQUIRED and names a terminal command the user runs themselves. You can't " +
      "approve for the user, and you must not run that command. From the ComfyUI panel's agent, start is refused unless the operator allowed it: plan there, run from an external client. " +
      "Starting the same action plan again returns the same run, never a second render. " +
      'action:"status" with `runId` reconciles with ComfyUI and returns the state, the downloads\' progress (PREPARING while they run), outputs, checks and three separate verdicts: ' +
      "execution, acceptance and the user's. OUTCOME_UNKNOWN means a submission's result was lost: never prepare and start the same plan " +
      "again to retry; report it and keep calling status. " +
      'action:"cancel" with `runId` cancels this run\'s own job and downloads only. ' +
      'action:"evaluate" with `runId` asks the user for their verdict on the outputs; `reportedVerdict` records only what the user told ' +
      "you in chat, stored as your report and never as the user's verdict. " +
      'action:"finalize" with `runId` writes run.json, evaluation.json and the dependency lock, with each downloaded file\'s commit and sha256, next to the plan\'s exported files.',
    {
      action: z.enum(["prepare", "start", "status", "cancel", "evaluate", "finalize"]).describe("The run step; see the tool description for each one's fields."),
      planId: z.string().optional().describe("prepare: a plan with a selected candidate."),
      actionPlanId: z.string().optional().describe("start: the action plan prepare returned."),
      runId: z.string().optional().describe("status, cancel, evaluate, finalize: the run."),
      reportedVerdict: z
        .enum(["accept", "reject"])
        .optional()
        .describe("evaluate: what the user told you in chat. Stored as your report, not as the user's verdict."),
      note: z.string().max(2000).optional().describe("evaluate: the user's words with the reported verdict."),
    },
    async (args) => {
      try {
        // Arguments first: a malformed call never builds the run context or touches a store.
        const required = { prepare: "planId", start: "actionPlanId", status: "runId", cancel: "runId", evaluate: "runId", finalize: "runId" } as const;
        const field = required[args.action];
        need(args[field], field, args.action);
        const ctx = context();
        const x = ctx.execution;
        switch (args.action) {
          case "prepare": {
            const r = await x.prepare({ planId: need(args.planId, "planId", "prepare") });
            return envelope("ok", `Action plan ${r.actionPlan.id} (hash ${r.shortHash}) is ready; approval request ${r.approvalRequest.id} waits for the user. Nothing has run.`, r);
          }
          case "start": {
            const r = await x.start({ actionPlanId: need(args.actionPlanId, "actionPlanId", "start") }, approvalDialog(server, ctx));
            return envelope("ok", `Run ${r.run.id} is ${r.run.state}${r.resumed ? " (started earlier; no second render)" : ""}.`, r);
          }
          case "status": {
            const r = await x.status({ runId: need(args.runId, "runId", "status") });
            const status = r.run.state === "OUTCOME_UNKNOWN" || r.run.state === "FAILED" ? "partial" : "ok";
            return envelope(status, `Run ${r.run.id} is ${r.run.state}; acceptance ${r.run.acceptance}.`, r, status === "partial" && r.run.error ? { warnings: [`${r.run.error.code}: ${r.run.error.message}`] } : {});
          }
          case "cancel": {
            const r = await x.cancel({ runId: need(args.runId, "runId", "cancel") });
            return envelope("ok", `Run ${r.run.id} is ${r.run.state}.`, r);
          }
          case "evaluate": {
            const r = await x.evaluate(
              { runId: need(args.runId, "runId", "evaluate"), ...(args.reportedVerdict ? { reportedVerdict: args.reportedVerdict } : {}), ...(args.note ? { note: args.note } : {}) },
              verdictDialog(server),
            );
            return envelope(r.userVerdict === "none" ? "partial" : "ok", `Run ${r.run.id}: user verdict ${r.userVerdict}; acceptance ${r.run.acceptance}.`, r);
          }
          case "finalize": {
            const r = x.finalize({ runId: need(args.runId, "runId", "finalize") });
            return envelope("ok", `Wrote ${r.files.length} files to ${r.dir}.`, r, { artifacts: r.files });
          }
        }
      } catch (err) {
        return errorReply(err);
      }
    },
  );
}
