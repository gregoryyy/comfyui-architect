#!/usr/bin/env node
// ComfyUI Architect live acceptance runner (spec §19.2; TODO 6.5.2; ARCH 2026-11-16,
// milestone 6, acceptance suite). Runs the fixtures of architect/acceptance/ whose `live` is
// `plan` or `render` through the built server over stdio, as an MCP client does, against the
// configured ComfyUI, and writes a report.
//
// Usage: node scripts/architect/acceptance.mjs [--plan-only] [--only at-01,at-04] [--out <dir>]
//   --plan-only   plans every selected fixture and renders none
//   --only        runs only the named fixtures; a fixture_only one is refused (CI only)
//   --out         where the report goes; default <Architect data dir>/acceptance/<timestamp>/
//
// What it does, in order:
//   1. Generates the synthetic inputs of inputs.json with sharp (deterministic SVG rendered
//      to PNG) and UPLOADS each missing one as `<prefix><name>` to the top level of the TARGET'S INPUT FOLDER
//      through ComfyUI's upload endpoint. A file of that name already there is used when it
//      has the same pixels and refused otherwise: nothing is ever uploaded over a file.
//   2. Starts the server with COMFYUI_ARCHITECT=1, its own ARCHITECT_DATA_DIR under the
//      output folder, none of the runner's ARCHITECT_* variables that widen what a run may
//      do (acceptance-judge.mjs `serverEnv`), and `node --import egress-guard.mjs`, which
//      records every outbound destination, DNS query and child process of the server (AT-09).
//   3. Plans each fixture (prepare; propose restricted to its recipeIds, with its proposals)
//      and checks the outcome against `expect`. A `render` fixture whose plan matched is then
//      selected, prepared and APPROVED IN THE TERMINAL CHANNEL'S CODE with the typed hash, as
//      the stdio smoke does (a runner has no person at a TTY), and RENDERED on the target. It
//      approves only an action plan whose one effect is a local render, read from the store
//      the approval reads; downloads and residency changes are never approved. It follows the
//      run, its smoke and repair attempts included, until the attempts stop, and finalizes it.
//      It never clears the queue and cancels only its own run, and only at its 45-minute
//      deadline. A render fixture passes when execution passed and acceptance passed or waits
//      only on the user's review.
//   4. Writes report.json and report.md: per fixture the outcome, the candidate, execution,
//      acceptance and evaluations, wall time, first attempt or repaired, smoke attempts apart,
//      and the egress check; AT-04 over the 20 feasible fixtures, on execution alone,
//      first-attempt and repaired apart; AT-09 over the whole session. A fixture fails when a
//      non-loopback destination was recorded between its start and end.
// The target comes from the usual environment (COMFYUI_URL, COMFYUI_HOST/PORT, ...) and must
// be localhost, ::1 or 127.0.0.0/8. Needs `npm run build` first. Exits 1 if a fixture fails or
// AT-09 isn't passed, 2 on a usage or setup error.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as judge from "./acceptance-judge.mjs";

const ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const GUARD = fileURLToPath(new URL("./egress-guard.mjs", import.meta.url));
const CALL_TIMEOUT = { timeout: 600_000 };
/** The slowest shipped recipe took 19 min for 1024 to 4096 (stdio smoke); a 512 source is far below. */
const RUN_DEADLINE_MS = 45 * 60 * 1000;
const POLL_MS = 3000;
const SETTLED = ["AWAITING_REVIEW", "COMPLETED", "FAILED", "CANCELLED"];

function usage(message) {
  console.error(message);
  console.error("usage: node scripts/architect/acceptance.mjs [--plan-only] [--only at-01,at-04] [--out <dir>]");
  process.exit(2);
}

const args = process.argv.slice(2);
const planOnly = args.includes("--plan-only");
const valueOf = (flag) => {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  const v = args[at + 1];
  if (v === undefined || v.startsWith("--")) usage(`${flag} needs a value`);
  return v;
};
const onlyArg = valueOf("--only");
const outArg = valueOf("--out");
const known = new Set(["--plan-only", "--only", "--out", onlyArg, outArg].filter(Boolean));
for (const a of args) if (!known.has(a)) usage(`unknown argument ${a}`);
if (!existsSync(ENTRY)) usage(`${ENTRY} is missing; run npm run build first`);

const acceptance = await import("../../dist/services/architect/acceptance.js");
const { architectDataDir } = await import("../../dist/services/architect/store.js");
const { BUILT_IN_IMAGE_CRITERIA, NO_EVALUATOR_CRITERION } = await import("../../dist/services/architect/evaluation.js");
const { createUpstreamFacade } = await import("../../dist/services/architect/upstream.js");
const { FORK_IDENTITY } = await import("../../dist/fork-identity.js");

const loaded = acceptance.loadAcceptanceFixtures();
if (loaded.errors.length > 0 || !loaded.inputs) {
  for (const e of loaded.errors) console.error(`fixture ${e.file}: ${e.message}`);
  usage("the acceptance fixtures don't load; fix them first");
}
const inputs = loaded.inputs;
let selected = loaded.fixtures.filter((f) => f.live !== "fixture_only");
if (onlyArg) {
  const ids = onlyArg.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !loaded.fixtures.some((f) => f.id === id));
  if (unknown.length > 0) usage(`no fixture ${unknown.join(", ")}`);
  const ciOnly = ids.filter((id) => loaded.fixtures.find((f) => f.id === id)?.live === "fixture_only");
  if (ciOnly.length > 0) usage(`${ciOnly.join(", ")} change the environment and run in the CI test only`);
  selected = selected.filter((f) => ids.includes(f.id));
}

const baseUrl = createUpstreamFacade().comfyuiBaseUrl().replace(/\/+$/, "");
const target = new URL(baseUrl);
// Stricter than validate.ts's isLoopbackHostname, which also accepts the bind addresses
// 0.0.0.0 and ::.
if (!judge.strictLoopbackHost(target.hostname)) {
  usage(`the target ${target.host} isn't localhost, ::1 or 127.0.0.0/8; the suite runs on the local reference target only (EVAL, test matrix)`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = outArg ? resolve(outArg) : join(architectDataDir(), "acceptance", stamp);
const dataDir = join(outDir, "data");
const egressFile = join(outDir, "egress.jsonl");
// The guard's record of failed writes (egress-guard.mjs).
const egressErrors = `${egressFile}.errors`;
mkdirSync(dataDir, { recursive: true });
if (existsSync(egressFile) || existsSync(egressErrors)) usage(`${egressFile} exists; give a new --out`);

// ---------------------------------------------------------------------------------------
// 1. Inputs

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function renderInput(sharp, file) {
  const svg = Buffer.from(acceptance.inputSvg(file));
  let img = sharp(svg, { density: 72 }).flatten({ background: "#000000" });
  img = file.pattern === "mask-disc" ? img.toColourspace("b-w") : img.removeAlpha();
  // No metadata: an embedded ICC profile would make the protected-region check unknown.
  return img.png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

async function samePixels(sharp, a, b) {
  const [x, y] = await Promise.all([a, b].map((bytes) => sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true })));
  return x.info.width === y.info.width && x.info.height === y.info.height && x.info.channels === y.info.channels && x.data.equals(y.data);
}

async function viewInput(name) {
  const res = await fetch(`${baseUrl}/view?type=input&filename=${encodeURIComponent(name)}`);
  if (res.status === 404) return { state: "absent" };
  if (!res.ok) return { state: "unknown", reason: `/view answered HTTP ${res.status}` };
  return { state: "present", bytes: Buffer.from(await res.arrayBuffer()) };
}

async function prepareInputs() {
  const { default: sharp } = await import("sharp");
  const { uploadImageHttp } = await import("../../dist/comfyui/client.js");
  const out = [];
  for (const file of inputs.files) {
    const bytes = await renderInput(sharp, file);
    const name = acceptance.inputName(inputs, file);
    const there = await viewInput(name);
    if (there.state === "unknown") throw new Error(`whether ${name} is in the input folder is unknown: ${there.reason}`);
    if (there.state === "present") {
      if (there.bytes.equals(bytes) || (await samePixels(sharp, there.bytes, bytes))) {
        out.push({ name, sha256: sha256(there.bytes), state: "present" });
        continue;
      }
      throw new Error(`${name} is already in the target's input folder with other content; refusing to upload over it. Move it away and run again`);
    }
    // overwrite=false: should a file of that name appear in the meantime, ComfyUI renames the
    // upload instead of replacing the file, and the check below sees the other name.
    const uploaded = await uploadImageHttp(name, bytes, "image/png", false);
    const landed = typeof uploaded?.name === "string" ? uploaded.name : undefined;
    if (landed !== undefined && landed !== name) throw new Error(`${name} was stored as ${landed}: a file of that name appeared during the upload`);
    const check = await viewInput(name);
    if (check.state !== "present" || !check.bytes.equals(bytes)) throw new Error(`${name} doesn't read back as uploaded`);
    out.push({ name, sha256: sha256(bytes), state: "uploaded" });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// 2.-3. The session and the fixtures

async function call(client, name, toolArgs) {
  try {
    return judge.parseReply(await client.callTool({ name, arguments: toolArgs }, undefined, CALL_TIMEOUT));
  } catch (err) {
    return { status: "error", summary: err instanceof Error ? err.message : String(err), isError: true, error: { code: "CALL_FAILED" }, thrown: true };
  }
}

const recipeOf = (c) => String(c.recipe ?? "").split(" ")[0];

/** Whether planning met the fixture's expectation, and what it came to. */
function judgePlan(f, proposed) {
  const candidates = proposed.data?.candidates ?? [];
  const blockers = proposed.data?.plan?.blockers ?? {};
  const categories = Object.entries(blockers).filter(([, v]) => Array.isArray(v) && v.length > 0).map(([k]) => k);
  const usable = candidates.filter((c) => c.status === "feasible" || c.status === "acquirable");
  const outcome = {
    status: candidates.some((c) => c.status === "feasible") ? "feasible" : usable.length > 0 ? "acquirable" : "blocked",
    planState: proposed.data?.plan?.state,
    categories,
    candidates: candidates.map((c) => ({ id: c.id, recipe: c.recipe, status: c.status, blocking: (c.blocking ?? []).slice(0, 5) })),
  };
  if (f.expect.outcome === "feasible") {
    const chosen = candidates.find((c) => c.status === "feasible" && f.expect.recipes.includes(recipeOf(c)));
    return chosen
      ? { ok: true, outcome, chosen }
      : { ok: false, outcome, reason: `no feasible candidate of ${f.expect.recipes.join(", ")}` };
  }
  if (usable.length > 0) return { ok: false, outcome, reason: `expected blocked, but ${usable.map((c) => `${recipeOf(c)} is ${c.status}`).join(", ")}` };
  // AT-02: each expected check, and no reason the fixture didn't name. The raw blockers, not a
  // default: blockers that don't parse are unreadable, never an empty set (#796).
  const j = acceptance.judgeBlockers(f, proposed.data?.plan?.blockers);
  return j.passed
    ? { ok: true, outcome }
    : { ok: false, outcome, reason: j.unreadable ?? [...j.missing.map((m) => `missing ${m}`), ...j.unexpected.map((u) => `unexpected ${u}`)].join("; ") };
}

/**
 * Approve in the terminal channel's code, after checking the action plan that approval reads:
 * the store's, for the request the server named. The typed hash is the stored plan's, so the
 * approval can't confirm a plan other than the one checked.
 */
async function approve(prepared) {
  const { runArchitectCli } = await import("../../dist/services/architect/cli.js");
  const { ArchitectStore } = await import("../../dist/services/architect/store.js");
  const { shortHash } = await import("../../dist/services/architect/admission.js");
  const store = ArchitectStore.open(dataDir);
  try {
    const requestId = prepared.data?.approvalRequest?.id;
    const request = typeof requestId === "string" ? store.getApprovalRequest(requestId) : undefined;
    const stored = request ? store.getActionPlan(request.actionPlanId) : undefined;
    const judged = judge.approvalJudgement({ reply: prepared.data, request, stored, shortHash });
    if (!judged.ok) return { approved: false, effects: judged.effects, reason: judged.reason };
    const code = await runArchitectCli(["approve", requestId], {
      store,
      io: { interactive: true, write: () => undefined, ask: async () => judged.typed },
    });
    return code === 0 ? { approved: true, effects: judged.effects } : { approved: false, effects: judged.effects, reason: `the terminal approval returned ${code}` };
  } finally {
    store.close();
  }
}

/** Whether a status reply says the run, or its attempts, came to rest. */
function settled(status) {
  const chain = status.data?.chain;
  if (chain) return chain.state === "stopped";
  return SETTLED.includes(status.data?.run?.state);
}

function attemptView(a) {
  return {
    runId: a.runId,
    index: a.index,
    stage: a.stage,
    repairRound: a.repairRound,
    state: a.state,
    execution: a.execution,
    acceptance: a.acceptance,
    steps: (a.graph?.transformations ?? []).map((t) => t.id),
    ...(a.error ? { error: { code: a.error.code, failureClass: a.error.failureClass } } : {}),
  };
}

function evaluationView(e) {
  return { criterion: e.criterion, verdict: e.verdict, source: e.source, ...(e.advisory ? { advisory: true } : {}), explanation: String(e.explanation ?? "").slice(0, 300) };
}

async function render(client, f, planId, chosen, task) {
  const selected = await call(client, "architect_plan", { action: "select", planId, candidateId: chosen.id });
  if (selected.status !== "ok") return { ok: false, reason: `select: ${selected.summary}` };
  const prepared = await call(client, "architect_run", { action: "prepare", planId });
  const actionPlan = prepared.data?.actionPlan;
  if (!actionPlan) return { ok: false, reason: `run prepare: ${prepared.error?.code ?? ""} ${prepared.summary}` };
  // A single local render only: the feasible fixtures download nothing, and a residency
  // change or any later effect kind needs a person's approval (spec §14.2).
  const approval = await approve(prepared);
  const effects = approval.effects ?? judge.effectKinds(actionPlan) ?? [];
  if (!approval.approved) return { ok: false, effects, reason: `not approved: ${approval.reason}` };
  const startedAt = Date.now();
  const started = await call(client, "architect_run", { action: "start", actionPlanId: actionPlan.id });
  const runId = started.data?.run?.id;
  if (!runId) return { ok: false, effects, reason: `start: ${started.error?.code ?? ""} ${started.summary}` };
  console.log(`      run ${runId} started (${effects.join(", ")})`);
  let status;
  let timedOut = false;
  let lastLine = "";
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    status = await call(client, "architect_run", { action: "status", runId });
    const line = `${status.data?.run?.state ?? status.summary}${status.data?.attempts ? `, ${status.data.attempts.length} attempt(s)` : ""}`;
    if (line !== lastLine) console.log(`      ${line}`);
    lastLine = line;
    if (settled(status)) break;
    if (Date.now() - startedAt > RUN_DEADLINE_MS) {
      // Only this run's own job; the controller never touches another (spec §14.5).
      timedOut = true;
      await call(client, "architect_run", { action: "cancel", runId });
      status = await call(client, "architect_run", { action: "status", runId });
      break;
    }
  }
  const wallSeconds = Math.round((Date.now() - startedAt) / 1000);
  const chain = status.data?.chain;
  const summary = judge.attemptSummary(status.data?.attempts, (a) => acceptance.StatusAttempt.safeParse(a), acceptance.summariseAttempts);
  const resultRunId = chain?.resultRunId ?? runId;
  // The evaluations of the attempt that stands for the result, not of a smoke attempt.
  const resultStatus = resultRunId === runId ? status : await call(client, "architect_run", { action: "status", runId: resultRunId });
  const finalized = await call(client, "architect_run", { action: "finalize", runId });
  const verdicts = status.data?.verdicts ?? {};
  const evaluations = resultStatus.data?.evaluations ?? [];
  const accepted = judge.acceptanceJudgement({
    acceptance: verdicts.acceptance,
    evaluations,
    required: task ? judge.requiredCriteria(task, { builtInImage: BUILT_IN_IMAGE_CRITERIA, noEvaluator: NO_EVALUATOR_CRITERION }) : [],
  });
  const verdict = judge.renderVerdict(verdicts.execution, accepted);
  return {
    ok: verdict.ok,
    runId,
    resultRunId,
    state: resultStatus.data?.run?.state ?? status.data?.run?.state,
    ...(resultStatus.data?.run?.error ? { error: { code: resultStatus.data.run.error.code, message: String(resultStatus.data.run.error.message ?? "").slice(0, 300) } } : {}),
    verdicts,
    evaluations: evaluations.map(evaluationView),
    acceptancePendingOn: accepted.pendingOn,
    path: summary.path,
    smokeAttempts: summary.smokeAttempts,
    finalAttempts: summary.finalAttempts,
    chainReported: summary.chainReported,
    ...(summary.unparsed ? { unparsedAttempts: summary.unparsed } : {}),
    ...(chain ? { chain: { state: chain.state, stopRule: chain.stopRule, stopReason: chain.stopReason } } : {}),
    attempts: (status.data?.attempts ?? []).map(attemptView),
    wallSeconds,
    timedOut,
    finalize: finalized.status,
    effects,
    ...(verdict.ok ? {} : { reason: `${verdict.reason}${timedOut ? " (deadline reached; the run was cancelled)" : ""}` }),
  };
}

async function runFixture(client, f) {
  const startedAt = Date.now();
  const entry = { id: f.id, title: f.title, live: f.live, expected: f.expect };
  const prepared = await call(client, "architect_plan", { action: "prepare", task: f.task });
  const planId = prepared.data?.plan?.id;
  if (f.expect.outcome === "refused") {
    // AT-01: only the validation refusal counts, never a failed call or another error.
    const refusal = judge.refusalJudgement(prepared);
    const status = refusal.refused ? "refused" : planId ? "accepted" : "error";
    return { ...entry, outcome: { status, error: prepared.error?.code, summary: String(prepared.summary ?? "").slice(0, 300) }, passed: refusal.refused, ...(refusal.refused ? {} : { reason: refusal.reason }), wallSeconds: Math.round((Date.now() - startedAt) / 1000) };
  }
  if (!planId) return { ...entry, outcome: { status: "error", summary: String(prepared.summary ?? "").slice(0, 300) }, passed: false, reason: `prepare: ${prepared.error?.code ?? ""} ${prepared.summary}` };
  const proposed = await call(client, "architect_plan", {
    action: "propose",
    planId,
    ...(f.recipeIds ? { recipeIds: f.recipeIds } : {}),
    ...(f.proposals ? { proposals: f.proposals } : {}),
  });
  if (!proposed.data?.plan) return { ...entry, outcome: { status: "error", summary: String(proposed.summary ?? "").slice(0, 300) }, passed: false, reason: `propose: ${proposed.error?.code ?? ""} ${proposed.summary}` };
  const judged = judgePlan(f, proposed);
  const base = { ...entry, outcome: judged.outcome, ...(judged.chosen ? { candidate: { id: judged.chosen.id, recipe: judged.chosen.recipe, status: judged.chosen.status } } : {}) };
  if (!judged.ok) return { ...base, passed: false, reason: judged.reason, wallSeconds: Math.round((Date.now() - startedAt) / 1000) };
  if (f.live !== "render" || planOnly) return { ...base, passed: true, wallSeconds: Math.round((Date.now() - startedAt) / 1000) };
  const run = await render(client, f, planId, judged.chosen, prepared.data?.task);
  return { ...base, run, passed: run.ok, ...(run.ok ? {} : { reason: run.reason }), wallSeconds: Math.round((Date.now() - startedAt) / 1000) };
}

// ---------------------------------------------------------------------------------------
// 4. The report

function scrub(text) {
  // No personal paths in the report: the home directory is written as ~.
  return text.split(homedir()).join("~");
}

function markdown(report) {
  const lines = [
    `# Acceptance suite, ${report.startedAt.slice(0, 16).replace("T", " ")} UTC`,
    "",
    `${report.fork} on ${report.target}; ${report.fixtures.length} fixture(s)${report.planOnly ? ", planned only" : ""}. ${report.passed} passed, ${report.failed} failed; AT-09 ${report.at09.verdict}.`,
    "",
    "| Fixture | Expected | Outcome | Candidate | Execution | Acceptance | Attempts | Wall | Egress | Result |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of report.fixtures) {
    const expected = r.expected.outcome === "blocked" ? `blocked: ${r.expected.category}` : r.expected.outcome;
    const outcome = r.outcome?.status === "blocked" ? `blocked: ${(r.outcome.categories ?? []).join(", ")}` : (r.outcome?.status ?? "");
    const path = { repaired: "repaired", first_attempt: "first", unknown: `unknown (${r.run?.unparsedAttempts ?? 0} unread)` }[r.run?.path] ?? "";
    const attempts = r.run ? `${path}; ${r.run.smokeAttempts} smoke, ${r.run.finalAttempts} final` : "";
    const pendingOn = r.run?.acceptancePendingOn ?? [];
    const acceptance = r.run?.verdicts ? `${r.run.verdicts.acceptance ?? "unknown"}${pendingOn.length > 0 ? ` (on ${pendingOn.join(", ")})` : ""}` : "";
    const egress = r.egress.checked ? (r.egress.violations.length === 0 ? "loopback only" : r.egress.violations.join(", ")) : `not checked: ${r.egress.reason}`;
    lines.push(
      `| ${r.id} | ${expected} | ${outcome} | ${r.candidate?.recipe ?? ""} | ${r.run?.verdicts?.execution ?? ""} | ${acceptance} | ${attempts} | ${r.wallSeconds ?? ""} s | ${egress} | ${r.passed ? "pass" : `FAIL: ${String(r.reason ?? "").replace(/\|/g, "/")}`} |`,
    );
  }
  const a = report.at04;
  lines.push("", "## AT-04", "");
  if (a.rendered === 0) {
    lines.push("Not measured: no feasible fixture was rendered.");
  } else {
    lines.push(
      `${a.executable} of ${a.feasible} feasible fixtures executable (${(a.share * 100).toFixed(0)}%, target ${(a.target * 100).toFixed(0)}%): ${a.firstAttempt} on the first attempt, ${a.repaired} after repair` +
        (a.executable - a.firstAttempt - a.repaired > 0 ? `, ${a.executable - a.firstAttempt - a.repaired} with attempts that couldn't be read.` : ".") +
        " Counted on execution alone; acceptance is in the table." +
        (a.complete ? "" : ` Incomplete: ${a.notRendered.length} not rendered (${a.notRendered.join(", ")}).`) +
        (a.notExecutable.length > 0 ? ` Not executable: ${a.notExecutable.join(", ")}.` : "") +
        ` ${a.passed ? "Passed." : "Not passed."}`,
    );
  }
  const n = report.at09;
  lines.push("", "## AT-09", "");
  lines.push(
    `${{ passed: "Passed", failed: "Failed", unknown: "Unknown" }[n.verdict]}${n.reasons.length > 0 ? `: ${n.reasons.join("; ")}` : ""}. ` +
      `${report.egress.records} record(s): ${report.egress.destinations} destination(s), ${report.egress.spawnRecords} child process(es) (${n.spawns.join(", ") || "none"}); ${report.egress.unreadable} unreadable line(s). ` +
      `Fixtures with a non-loopback destination: ${report.fixtures.filter((r) => r.egress.violations.length > 0).map((r) => r.id).join(", ") || "none"}. ` +
      `Outside every fixture: ${report.egress.outsideFixtures.join(", ") || "loopback only"}. ComfyUI's own traffic isn't covered.`,
  );
  lines.push("", "## Inputs", "");
  for (const i of report.inputs) lines.push(`- ${i.name}: ${i.state}, sha256 ${i.sha256.slice(0, 12)}`);
  return `${lines.join("\n")}\n`;
}

let preparedInputs;
try {
  preparedInputs = await prepareInputs();
} catch (err) {
  console.error(`inputs: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
for (const i of preparedInputs) console.log(`input ${i.name}: ${i.state}`);

const startedAt = new Date().toISOString();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", pathToFileURL(GUARD).href, ENTRY, "--full"],
  // Not the runner's whole environment: ARCHITECT_MANAGE_RESIDENCY, for one, would put a
  // release_residency effect into the action plans (which the runner then refuses), and an
  // ARCHITECT_* variable it doesn't know may widen what a run may do (acceptance-judge.mjs).
  env: judge.serverEnv(process.env, { COMFYUI_ARCHITECT: "1", ARCHITECT_DATA_DIR: dataDir, [acceptance.EGRESS_LOG_ENV]: egressFile }),
  stderr: "ignore",
});
const client = new Client({ name: "architect-acceptance", version: "0.0.0" });
const sessionFrom = Date.now();
await client.connect(transport);
const results = [];
const windows = [];
try {
  for (const f of selected) {
    console.log(`\n${f.id} (${f.live}): ${f.title}`);
    const from = Date.now();
    let r;
    try {
      r = await runFixture(client, f);
    } catch (err) {
      r = { id: f.id, title: f.title, live: f.live, expected: f.expect, passed: false, reason: `the runner threw: ${err instanceof Error ? err.message : String(err)}` };
    }
    const to = Date.now();
    windows.push({ id: f.id, from, to });
    results.push(r);
    console.log(`  ${r.passed ? "pass" : "FAIL"}${r.reason ? `: ${r.reason}` : ""}`);
  }
} finally {
  await client.close();
}
const sessionTo = Date.now();

const logExists = existsSync(egressFile);
const log = logExists ? acceptance.parseEgressLog(readFileSync(egressFile, "utf-8")) : { records: [], unreadable: 0 };
// Startup lines and child processes name no destination; only the rest is checked for one.
const { destinations, spawns } = judge.classifyEgress(log.records);
for (const r of results) {
  const w = windows.find((x) => x.id === r.id);
  // No exemption for downloads: the runner never approves one, so nothing may leave.
  const violations = w ? acceptance.egressViolations(destinations, w.from, w.to) : [];
  if (!logExists) {
    // No log at all: the guard didn't run, so egress is unknown, never "none" (#796).
    r.egress = { checked: false, reason: "the egress guard wrote no log", violations: [] };
    r.passed = false;
    r.reason = [r.reason, "egress unknown: the guard wrote no log"].filter(Boolean).join("; ");
  } else {
    r.egress = { checked: true, violations };
    if (violations.length > 0) {
      r.passed = false;
      r.reason = [r.reason, `non-loopback destinations: ${violations.join(", ")}`].filter(Boolean).join("; ");
    }
  }
}
const inside = (at) => windows.some((w) => at >= w.from && at <= w.to);
const outsideFixtures = acceptance.egressViolations(destinations.filter((r) => !inside(r.at)), 0, Number.MAX_SAFE_INTEGER);
// The whole log, not only [sessionFrom, sessionTo]: the server wrote every line within the
// session, so a line outside it would be a clock oddity, and still not a reason to ignore it.
const at09 = judge.at09Verdict({
  logExists,
  log,
  sidecarExists: existsSync(egressErrors),
  violations: (records) => acceptance.egressViolations(records, 0, Number.MAX_SAFE_INTEGER),
});

const feasibleIds = loaded.fixtures.filter((f) => f.expect.outcome === "feasible").map((f) => f.id);
const rendered = results.filter((r) => r.run && r.run.runId).map((r) => ({ id: r.id, execution: r.run.verdicts?.execution, path: r.run.path }));
const report = {
  schemaVersion: 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  fork: `${FORK_IDENTITY.product} ${FORK_IDENTITY.version}`,
  target: `${target.protocol}//${target.host}`,
  planOnly,
  only: onlyArg ?? null,
  passed: results.filter((r) => r.passed).length,
  failed: results.filter((r) => !r.passed).length,
  inputs: preparedInputs,
  fixtures: results,
  at04: acceptance.at04(feasibleIds, rendered),
  egress: { records: log.records.length, destinations: destinations.length, spawnRecords: spawns.length, unreadable: log.unreadable, outsideFixtures, session: { from: sessionFrom, to: sessionTo } },
  at09,
};
writeFileSync(join(outDir, "report.json"), scrub(`${JSON.stringify(report, null, 2)}\n`));
writeFileSync(join(outDir, "report.md"), scrub(markdown(report)));
console.log(`\n${report.passed} passed, ${report.failed} failed; report in ${outDir}`);
if (report.at04.rendered > 0) console.log(`AT-04: ${report.at04.executable}/${report.at04.feasible} executable, ${report.at04.firstAttempt} first attempt, ${report.at04.repaired} repaired`);
console.log(`AT-09: ${at09.verdict}${at09.reasons.length > 0 ? ` (${at09.reasons.join("; ")})` : ""}`);
process.exit(report.failed > 0 || at09.verdict !== "passed" ? 1 : 0);
