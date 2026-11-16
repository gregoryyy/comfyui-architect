#!/usr/bin/env node
// ComfyUI Architect stdio smoke (TODO 1.10, 1.1.3): start the built server the way an
// external MCP client does, read the handshake, list the tools, and with the flag on call
// architect_inspect against the configured ComfyUI. Upstream's smoke-install checks the
// packed tarball; this checks what an MCP client sees, with the Architect flag off and on.
//
// Usage: node scripts/architect/stdio-smoke.mjs [off|on|both] [--offline] [--plan] [--run] [--acquire]
//   both (default)  runs off, then on, and checks that on adds exactly the architect_* tools
//   --offline       accepts the STALE_ENVIRONMENT error when no ComfyUI answers, so the
//                   wiring can be checked without a running ComfyUI
//   --plan          with the flag on, also plans a 1024x1024 text-to-image task through
//                   architect_plan (prepare, propose, select, export) into a temporary
//                   ARCHITECT_DATA_DIR; needs a feasible candidate on the target
//   --run           implies --plan, then renders the selected candidate through architect_run
//                   (prepare, start, status until it settles, finalize). It RENDERS on the
//                   target. The approval stands in for the user: the script runs the terminal
//                   command's code with the typed hash, since a smoke has no person at a TTY
//   --acquire       implies --run with a 2048x2048 task and the candidate of recipe
//                   recipe-zimage-turbo.t2i-upscale2x (TODO 4.7). When that candidate is
//                   acquirable, the run DOWNLOADS its missing pinned file (RealESRGAN x4plus,
//                   about 64 MiB) from Hugging Face INTO THE TARGET'S MODEL FOLDER, then renders;
//                   the checks cover the acquire effect, the refused unapproved start, the
//                   placed file and its sha256 in the run's dependency lock. When the file is
//                   already installed, the candidate is feasible and the script runs it as --run
// The target comes from the usual environment (COMFYUI_URL, COMFYUI_HOST/PORT, ...).
// Needs `npm run build` first. Exits 1 if any check fails.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const args = process.argv.slice(2);
const offline = args.includes("--offline");
const acquire = args.includes("--acquire");
const run = args.includes("--run") || acquire;
const ACQUIRE_RECIPE = "recipe-zimage-turbo.t2i-upscale2x";
const side = acquire ? 2048 : 1024;
const plan = args.includes("--plan") || run;
const dataDir = mkdtempSync(join(tmpdir(), "architect-smoke-"));
const mode = args.find((a) => !a.startsWith("--")) ?? "both";
if (!["off", "on", "both"].includes(mode)) {
  console.error(`unknown mode "${mode}"; use off, on or both`);
  process.exit(2);
}
if (!existsSync(ENTRY)) {
  console.error(`${ENTRY} is missing; run npm run build first`);
  process.exit(2);
}

const failures = [];
function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
}

async function session(flagOn) {
  const env = { ...process.env };
  if (flagOn) env.COMFYUI_ARCHITECT = "1";
  else delete env.COMFYUI_ARCHITECT;
  env.ARCHITECT_DATA_DIR = dataDir;
  // --full lists every tool directly; compact mode would hide them behind call_tool.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY, "--full"],
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "architect-stdio-smoke", version: "0.0.0" });
  await client.connect(transport);
  try {
    const info = client.getServerVersion();
    const forkLine = (client.getInstructions() ?? "").split("\n").find((l) => l.startsWith("Fork: ")) ?? "";
    const tools = (await client.listTools()).tools.map((t) => t.name);
    const label = flagOn ? "[on] " : "[off]";
    console.log(`${label} ${info?.title ?? info?.name} ${info?.version}; ${tools.length} tools`);
    check(info?.title?.startsWith("ComfyUI Architect") === true, `${label} serverInfo.title names the fork`);
    check(forkLine.includes(flagOn ? "Architect tools on" : "Architect tools off"), `${label} handshake line: ${forkLine || "missing"}`);
    const architect = tools.filter((n) => n.startsWith("architect_"));
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    if (!flagOn) {
      check(architect.length === 0, `${label} no architect_* tools`);
      check(prompts.length === 0, `${label} prompt list empty, as upstream's (${prompts.join(", ") || "none"})`);
      return { tools };
    }
    check(architect.includes("architect_inspect"), `${label} architect_inspect listed`);
    check(prompts.includes("architect") && prompts.includes("architect_skill"), `${label} prompts: ${prompts.join(", ") || "none"}`);
    const res = await client.callTool({ name: "architect_inspect", arguments: { action: "environment" } }, undefined, CALL_TIMEOUT);
    const text = res.content?.[0]?.type === "text" ? res.content[0].text : "";
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      check(false, `${label} architect_inspect returns a JSON envelope`);
      return { tools };
    }
    console.log(`${label} architect_inspect: ${envelope.status}: ${envelope.summary}`);
    const reachable = envelope.status === "ok" || envelope.status === "partial";
    const acceptedOffline = offline && envelope.error?.code === "STALE_ENVIRONMENT";
    check(reachable || acceptedOffline, `${label} architect_inspect status ${envelope.status}${acceptedOffline ? " (offline accepted)" : ""}`);
    for (const w of envelope.warnings ?? []) console.log(`      warning: ${w}`);
    if (plan) await planTask(client, label);
    return { tools };
  } finally {
    await client.close();
  }
}

// The SDK's default request timeout is 60 s. On a slow target (upstream's live-server
// probes can take many seconds each) a call may need longer; the smoke waits up to 10 min.
const CALL_TIMEOUT = { timeout: 600_000 };

async function callPlan(client, args) {
  const res = await client.callTool({ name: "architect_plan", arguments: args }, undefined, CALL_TIMEOUT);
  return JSON.parse(res.content?.[0]?.type === "text" ? res.content[0].text : "{}");
}

async function planTask(client, label) {
  const task = {
    intent: "A red bicycle leaning against a white wall, soft morning light.",
    media: { kind: "image", operation: "text_to_image", output: { width: side, height: side } },
  };
  const prepared = await callPlan(client, { action: "prepare", task });
  console.log(`${label} prepare: ${prepared.status}: ${prepared.summary}`);
  check(prepared.status !== "error", `${label} prepare stored the task`);
  const planId = prepared.data?.plan?.id;
  if (!planId) return;
  const proposed = await callPlan(client, { action: "propose", planId });
  console.log(`${label} propose: ${proposed.status}: ${proposed.summary}`);
  for (const c of proposed.data?.candidates ?? []) {
    console.log(`      ${c.status.padEnd(10)} ${c.recipe} ${JSON.stringify(c.bindings)}`);
    for (const b of c.blocking) console.log(`        blocking: ${b}`);
  }
  const candidates = proposed.data?.candidates ?? [];
  let best;
  let acquiring = false;
  if (acquire) {
    best = candidates.find((c) => c.recipe.startsWith(`${ACQUIRE_RECIPE} r`));
    check(best !== undefined, `${label} a candidate of ${ACQUIRE_RECIPE}`);
    if (!best) return;
    if (best.status === "feasible") {
      console.log(`${label} ${ACQUIRE_RECIPE} is already feasible (its files are installed, perhaps by an earlier run); running it as --run does`);
    } else {
      check(best.status === "acquirable", `${label} ${ACQUIRE_RECIPE} is acquirable: ${best.status}`);
      if (best.status !== "acquirable") return;
      acquiring = true;
      for (const f of best.acquisition?.files ?? []) console.log(`      to acquire: ${f.folder}/${f.file} ${f.size} from ${f.source}`);
    }
  } else {
    best = candidates.find((c) => c.status === "feasible");
    check(best !== undefined, `${label} a feasible candidate`);
    if (!best) return;
  }
  const selected = await callPlan(client, { action: "select", planId, candidateId: best.id });
  check(selected.status === "ok", `${label} select: ${selected.summary}`);
  const exported = await callPlan(client, { action: "export", planId });
  check(exported.status === "ok" && exported.artifacts?.length === 6, `${label} export: ${exported.summary}`);
  if (run) {
    // A thrown call (a timeout, a closed connection) is reported as a failed check, with the
    // run id when there is one, so the run can be followed or cancelled by hand.
    const progress = { runId: undefined };
    try {
      await runTask(client, label, planId, acquiring, progress);
    } catch (err) {
      check(false, `${label} run steps threw: ${err instanceof Error ? err.message : String(err)}${progress.runId ? `; run ${progress.runId}` : "; no run was created"}`);
    }
  }
}

async function callRun(client, args) {
  const res = await client.callTool({ name: "architect_run", arguments: args }, undefined, CALL_TIMEOUT);
  return JSON.parse(res.content?.[0]?.type === "text" ? res.content[0].text : "{}");
}

async function runTask(client, label, planId, acquiring, progress) {
  const prepared = await callRun(client, { action: "prepare", planId });
  console.log(`${label} run prepare: ${prepared.status}: ${prepared.summary}`);
  const actionPlanId = prepared.data?.actionPlan?.id;
  const requestId = prepared.data?.approvalRequest?.id;
  if (!actionPlanId || !requestId) return check(false, `${label} run prepare returned an action plan${prepared.error ? `: ${prepared.error.code}: ${prepared.summary}` : ""}`);
  const effects = prepared.data.actionPlan.effects ?? [];
  const acquireEffect = effects.find((e) => e.kind === "acquire_models");
  if (acquiring) {
    check(effects[0]?.kind === "acquire_models", `${label} the action plan downloads first: ${effects.map((e) => e.kind).join(", ")}`);
    for (const f of acquireEffect?.files ?? []) {
      console.log(`      download: ${f.destinationRoot}/${f.folder}/${f.file} from ${f.source.repo}@${f.source.revision.slice(0, 12)} (${f.source.sizeBytes} bytes)`);
    }
  } else {
    check(acquireEffect === undefined, `${label} a feasible candidate's action plan downloads nothing`);
  }
  const refused = await callRun(client, { action: "start", actionPlanId });
  check(refused.error?.code === "APPROVAL_REQUIRED", `${label} start without approval is refused: ${refused.error?.code}`);
  if (acquiring) {
    const nothing = (acquireEffect?.files ?? []).every((f) => !existsSync(join(f.destinationRoot, f.folder, f.file)));
    check(nothing, `${label} nothing was downloaded before the approval`);
  }
  // The stand-in for the user: the terminal command's code, with the hash the plan shows.
  const { runArchitectCli } = await import("../../dist/services/architect/cli.js");
  const { ArchitectStore } = await import("../../dist/services/architect/store.js");
  const store = ArchitectStore.open(dataDir);
  const out = [];
  const code = await runArchitectCli(["approve", requestId], {
    store,
    io: { interactive: true, write: (t) => out.push(t), ask: async () => prepared.data.shortHash },
  });
  store.close();
  check(code === 0, `${label} approved in the terminal channel (${prepared.data.shortHash})`);
  const started = await callRun(client, { action: "start", actionPlanId });
  console.log(`${label} run start: ${started.status}: ${started.summary}`);
  const runId = started.data?.run?.id;
  if (!runId) return check(false, `${label} start created a run`);
  progress.runId = runId;
  console.log(`${label} run id: ${runId}`);
  const again = await callRun(client, { action: "start", actionPlanId });
  check(again.data?.run?.id === runId && again.data?.resumed === true, `${label} a second start returns the same run`);
  let status;
  let lastProgress = "";
  // A render on the reference target has taken from 85 s to almost 6 min for the same graph,
  // depending on what ComfyUI held in memory; the limit leaves room for that.
  const deadline = Date.now() + 20 * 60 * 1000;
  do {
    await new Promise((r) => setTimeout(r, 2000));
    status = await callRun(client, { action: "status", runId });
    const progress = (status.data?.acquisitions ?? []).map((a) => `${a.file} ${a.state}${a.bytesSoFar !== undefined ? ` ${a.bytesSoFar}/${a.sizeBytes}` : ""}`).join(", ");
    if (progress && progress !== lastProgress) console.log(`      ${status.data?.run?.state}: ${progress}`);
    lastProgress = progress;
  } while (!["AWAITING_REVIEW", "COMPLETED", "FAILED", "CANCELLED"].includes(status.data?.run?.state) && Date.now() < deadline);
  const r = status.data?.run;
  console.log(`${label} run status: ${status.summary}`);
  for (const e of status.data?.evaluations ?? []) console.log(`      ${e.criterion.padEnd(18)} ${e.verdict.padEnd(8)} ${e.explanation}`);
  check(r?.state === "COMPLETED" || r?.state === "AWAITING_REVIEW", `${label} run finished: ${r?.state}${r?.error ? ` (${r.error.code}: ${r.error.message})` : ""}`);
  check((r?.outputs?.length ?? 0) > 0, `${label} run outputs: ${(r?.outputs ?? []).map((o) => `${o.subfolder}/${o.filename}`).join(", ")}`);
  check(status.data?.verdicts?.execution === "passed", `${label} verdicts: ${JSON.stringify(status.data?.verdicts)}`);
  if (acquire) {
    const dims = (status.data?.evaluations ?? []).find((e) => e.criterion === "output_dimensions");
    check(dims?.verdict === "pass", `${label} output is ${side}x${side}: ${dims?.verdict} (${dims?.explanation ?? "no check"})`);
  }
  const acquisitions = status.data?.acquisitions ?? [];
  if (acquiring) {
    check(acquisitions.length > 0 && acquisitions.every((a) => a.state === "placed"), `${label} every download placed: ${acquisitions.map((a) => `${a.file} ${a.state}`).join(", ")}`);
    for (const a of acquisitions) check(typeof a.placedPath === "string" && existsSync(a.placedPath), `${label} installed: ${a.placedPath}`);
  }
  const finalized = await callRun(client, { action: "finalize", runId });
  const written = (finalized.artifacts ?? []).map((f) => String(f).split("/").pop()).sort();
  check(
    finalized.status === "ok" && JSON.stringify(written) === JSON.stringify(["dependencies.lock.json", "evaluation.json", "run.json"]),
    `${label} finalize: ${finalized.summary}`,
  );
  if (acquiring) {
    const lockFile = (finalized.artifacts ?? []).find((f) => String(f).endsWith("dependencies.lock.json"));
    const lock = lockFile ? JSON.parse(readFileSync(lockFile, "utf-8")) : {};
    for (const f of acquireEffect?.files ?? []) {
      const entry = (lock.acquired ?? []).find((a) => a.folder === f.folder && a.file === f.file);
      check(
        entry?.sha256 === f.source.sha256 && entry?.commit === f.source.revision && entry?.repo === f.source.repo,
        `${label} the lock lists ${f.folder}/${f.file} with commit ${f.source.revision.slice(0, 12)} and sha256 ${entry?.sha256?.slice(0, 12) ?? "missing"}`,
      );
    }
  }
}

const off = mode === "on" ? undefined : await session(false);
const on = mode === "off" ? undefined : await session(true);
if (off && on) {
  const added = on.tools.filter((n) => !off.tools.includes(n));
  const removed = off.tools.filter((n) => !on.tools.includes(n));
  // Spec AT-12: the flag adds Architect tools and changes nothing else.
  check(removed.length === 0 && added.every((n) => n.startsWith("architect_")), `flag on adds only architect_* tools (${added.join(", ") || "none"})`);
}

rmSync(dataDir, { recursive: true, force: true });
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
