#!/usr/bin/env node
// ComfyUI Architect stdio smoke (TODO 1.10, 1.1.3): start the built server the way an
// external MCP client does, read the handshake, list the tools, and with the flag on call
// architect_inspect against the configured ComfyUI. Upstream's smoke-install checks the
// packed tarball; this checks what an MCP client sees, with the Architect flag off and on.
//
// Usage: node scripts/architect/stdio-smoke.mjs [off|on|both] [--offline]
//   both (default)  runs off, then on, and checks that on adds exactly the architect_* tools
//   --offline       accepts the STALE_ENVIRONMENT error when no ComfyUI answers, so the
//                   wiring can be checked without a running ComfyUI
// The target comes from the usual environment (COMFYUI_URL, COMFYUI_HOST/PORT, ...).
// Needs `npm run build` first. Exits 1 if any check fails.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const args = process.argv.slice(2);
const offline = args.includes("--offline");
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
    if (!flagOn) {
      check(architect.length === 0, `${label} no architect_* tools`);
      return { tools };
    }
    check(architect.includes("architect_inspect"), `${label} architect_inspect listed`);
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
    return { tools };
  } finally {
    await client.close();
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

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
