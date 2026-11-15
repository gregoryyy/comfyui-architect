// The terminal approval channel (GAPS Q20, TODO 3.3.2, 3.7): `comfyui-mcp architect …`.
//
//   architect pending             list approval requests waiting for the user
//   architect approve <request>   show the action plan; typing its short hash grants it
//   architect review <run>        show the run's outputs and checks; accept or reject
//
// Run by the user in their own terminal, never by the agent: it needs a TTY on stdin and
// stdout, which an agent's shell tool doesn't give, and the user confirms by typing what
// the plan shows. That raises the bar; it isn't a boundary against an agent that has a
// shell on the user's account, which README and SEC state (spec §14.3). Dispatched from
// boot.ts only while the Architect flag is on, so with the flag off the command line is
// upstream's (AT-12).

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { ApprovalError, describeActionPlan, issueGrant, printable, shortHash } from "./admission.js";
import { recordUserVerdict } from "./execution.js";
import { ArchitectStore } from "./store.js";

export interface CliIo {
  interactive: boolean;
  write: (text: string) => void;
  ask: (question: string) => Promise<string>;
}

function processIo(): CliIo {
  return {
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    write: (text) => process.stdout.write(text),
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

const USAGE = [
  "Usage: comfyui-mcp architect <command>",
  "  pending              list approval requests waiting for you",
  "  approve <request-id> show an action plan and approve it",
  "  review <run-id>      accept or reject a run's outputs",
  "",
].join("\n");

export interface CliDeps {
  store: ArchitectStore;
  io: CliIo;
  now: () => Date;
  newId: () => string;
}

/** Runs one command; returns the process exit code. */
export async function runArchitectCli(argv: readonly string[], injected?: Partial<CliDeps>): Promise<number> {
  const io = injected?.io ?? processIo();
  const [command, id] = argv;
  if (!command || command === "help" || command === "--help") {
    io.write(USAGE);
    return command ? 0 : 1;
  }
  if (!["pending", "approve", "review"].includes(command)) {
    io.write(`Unknown command "${command}".\n${USAGE}`);
    return 1;
  }
  if (!io.interactive) {
    io.write("This command must be run by you in an interactive terminal; it reads your confirmation from the keyboard.\n");
    return 2;
  }
  const store = injected?.store ?? ArchitectStore.open();
  const deps: CliDeps = { store, io, now: injected?.now ?? (() => new Date()), newId: injected?.newId ?? (() => randomUUID()) };
  try {
    if (command === "pending") return pending(deps);
    if (!id) {
      io.write(`Missing ID.\n${USAGE}`);
      return 1;
    }
    return command === "approve" ? await approve(deps, id) : await review(deps, id);
  } catch (err) {
    io.write(`${err instanceof Error ? err.message : String(err)}${err instanceof ApprovalError ? `\n${err.nextStep}` : ""}\n`);
    return 1;
  } finally {
    if (!injected?.store) store.close();
  }
}

function pending({ store, io, now }: CliDeps): number {
  const requests = store.listPendingRequests(now());
  if (requests.length === 0) {
    io.write("No approval request is waiting.\n");
    return 0;
  }
  for (const r of requests) {
    const plan = store.getActionPlan(r.actionPlanId);
    io.write(`${r.id}  hash ${shortHash(r.actionPlanHash)}  expires ${r.expiresAt}${plan ? `  ${plan.effects.map((e) => e.kind).join(", ")}` : ""}\n`);
  }
  io.write("\nApprove one with: comfyui-mcp architect approve <request-id>\n");
  return 0;
}

async function approve({ store, io, now, newId }: CliDeps, requestId: string): Promise<number> {
  const request = store.getApprovalRequest(requestId);
  if (!request) throw new ApprovalError("MISSING_INPUT", `No approval request ${requestId}.`, "List them with: comfyui-mcp architect pending");
  const actionPlan = store.getActionPlan(request.actionPlanId);
  if (!actionPlan) throw new ApprovalError("MISSING_INPUT", `Action plan ${request.actionPlanId} is missing.`, "Prepare the run again.");
  io.write(`\n${describeActionPlan(store, actionPlan)}\n\n`);
  if (request.state !== "pending") {
    io.write(`This request is ${request.state}; nothing to approve.\n`);
    return 1;
  }
  const typed = await io.ask(`To approve, type the hash ${shortHash(actionPlan.hash)} (anything else cancels): `);
  if (typed.trim().toLowerCase() !== shortHash(actionPlan.hash)) {
    io.write("Not approved. The request stays open.\n");
    return 1;
  }
  const grant = issueGrant({ store, now, newId }, { requestId, channel: "terminal", issuer: "terminal", confirmHash: typed });
  io.write(`Approved: grant ${grant.id}, valid until ${grant.expiresAt}, for one run. The agent can start it now.\n`);
  return 0;
}

async function review({ store, io, now, newId }: CliDeps, runId: string): Promise<number> {
  const run = store.getRun(runId);
  if (!run) throw new ApprovalError("MISSING_INPUT", `No run ${runId}.`, "Check the run ID.");
  io.write(`\nRun ${run.id}: ${run.state}\n`);
  // File names and explanations come from ComfyUI and the records: no control characters
  // reach the terminal, so nothing can redraw what the user is asked to judge.
  for (const o of run.outputs) io.write(`  output: ${printable(`${o.type}/${o.subfolder ? `${o.subfolder}/` : ""}${o.filename}`)}\n`);
  for (const r of store.listEvaluations(run.id).filter((e) => e.source === "automatic")) io.write(`  ${printable(`${r.criterionId}: ${r.verdict} (${r.explanation})`)}\n`);
  const answer = (await io.ask("\nAccept these outputs? Type accept or reject (anything else cancels): ")).trim().toLowerCase();
  if (answer !== "accept" && answer !== "reject") {
    io.write("No verdict recorded.\n");
    return 1;
  }
  const note = (await io.ask("Note (optional): ")).trim();
  const r = recordUserVerdict({ store, now, newId }, { runId, verdict: answer, channel: "terminal", issuer: "terminal", ...(note ? { note } : {}) });
  io.write(`Recorded: ${answer}. Run ${r.run.id} is ${r.run.state}, acceptance ${r.run.acceptance}.\n`);
  return 0;
}
