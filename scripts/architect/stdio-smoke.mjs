#!/usr/bin/env node
// ComfyUI Architect stdio smoke (TODO 1.10, 1.1.3): start the built server the way an
// external MCP client does, read the handshake, list the tools, and with the flag on call
// architect_inspect against the configured ComfyUI. Upstream's smoke-install checks the
// packed tarball; this checks what an MCP client sees, with the Architect flag off and on.
//
// Usage: node scripts/architect/stdio-smoke.mjs [off|on|both] [--offline] [--plan]
//   both (default)  runs off, then on, and checks that on adds exactly the architect_* tools
//   --offline       accepts the STALE_ENVIRONMENT error when no ComfyUI answers, so the
//                   wiring can be checked without a running ComfyUI
//   --plan          with the flag on, also plans a 1024x1024 text-to-image task through
//                   architect_plan (prepare, propose, select, export) into a temporary
//                   ARCHITECT_DATA_DIR; needs a feasible candidate on the target
// The target comes from the usual environment (COMFYUI_URL, COMFYUI_HOST/PORT, ...).
// Needs `npm run build` first. Exits 1 if any check fails.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const args = process.argv.slice(2);
const offline = args.includes("--offline");
const plan = args.includes("--plan");
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
    const res = await client.callTool({ name: "architect_inspect", arguments: { action: "environment" } });
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

async function callPlan(client, args) {
  const res = await client.callTool({ name: "architect_plan", arguments: args });
  return JSON.parse(res.content?.[0]?.type === "text" ? res.content[0].text : "{}");
}

async function planTask(client, label) {
  const task = {
    intent: "A red bicycle leaning against a white wall, soft morning light.",
    media: { kind: "image", operation: "text_to_image", output: { width: 1024, height: 1024 } },
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
  const best = (proposed.data?.candidates ?? []).find((c) => c.status === "feasible");
  check(best !== undefined, `${label} a feasible candidate`);
  if (!best) return;
  const selected = await callPlan(client, { action: "select", planId, candidateId: best.id });
  check(selected.status === "ok", `${label} select: ${selected.summary}`);
  const exported = await callPlan(client, { action: "export", planId });
  check(exported.status === "ok" && exported.artifacts?.length === 5, `${label} export: ${exported.summary}`);
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
