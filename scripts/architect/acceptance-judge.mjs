// The live acceptance runner's judgements (scripts/architect/acceptance.mjs; spec §19.2;
// TODO 6.5.2), kept apart from the runner so a unit test can check them without a server,
// ComfyUI or a build. Everything here takes values and returns values; what the runner
// reads from dist/ (the egress parser, the attempt schema, the criteria constants) is passed
// in. No imports: the module loads in a test as it does in the runner.

// ---------------------------------------------------------------------------------------
// The target and the server's environment

/**
 * Whether a hostname is loopback in the strict sense the runner needs for its target:
 * `localhost`, `::1` or 127.0.0.0/8. validate.ts's `isLoopbackHostname` also accepts
 * `0.0.0.0` and `::`, which are bind addresses: as a target they say nothing about which
 * machine answers, so the runner refuses them (EVAL, test matrix: the local target only).
 */
export function strictLoopbackHost(hostname) {
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m !== null && m.slice(1).every((x) => Number(x) <= 255);
}

/**
 * The ARCHITECT_* variables the runner passes on from its own environment. Every other one
 * is dropped: ARCHITECT_MANAGE_RESIDENCY would let a run unload Ollama models, ARCHITECT_PANEL_RUNS
 * and ARCHITECT_ROUTE change who may start a run, and a variable added later may widen what a
 * run may do, so it stays out until it is listed here. These two only tune checks.
 */
export const KEPT_ARCHITECT_ENV = ["ARCHITECT_OCR_MODEL", "ARCHITECT_ENV_MAX_AGE_SECONDS"];

/**
 * The environment of the server the runner starts: the runner's own, without the ARCHITECT_*
 * variables KEPT_ARCHITECT_ENV doesn't list, and with `set` on top.
 */
export function serverEnv(base, set) {
  const out = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key.startsWith("ARCHITECT_") && !KEPT_ARCHITECT_ENV.includes(key)) continue;
    out[key] = value;
  }
  return { ...out, ...set };
}

// ---------------------------------------------------------------------------------------
// Tool replies

/** The MCP SDK's refusal of arguments that fail a tool's input schema (`validateToolInput`). */
const SDK_VALIDATION = /^MCP error -32602: Input validation error\b/;

/**
 * A tool reply as the runner reads it: the envelope's fields and `isError`. A text that isn't
 * JSON is the SDK's own refusal when it reads as one (INVALID_ARGUMENTS), and UNREADABLE_REPLY
 * otherwise, so a crash text is never taken for a validation refusal.
 */
export function parseReply(res) {
  const text = res?.content?.[0]?.type === "text" ? res.content[0].text : "";
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return { ...value, isError: res?.isError === true };
  } catch {
    const code = res?.isError === true && SDK_VALIDATION.test(text) ? "INVALID_ARGUMENTS" : "UNREADABLE_REPLY";
    return { status: "error", summary: text.slice(0, 500), isError: true, error: { code } };
  }
}

/**
 * Whether a prepare reply is the validation refusal AT-01 asks for. The CI test expects
 * planning's MISSING_INPUT for a task that isn't a valid TaskSpec; over MCP the tool's input
 * schema (TaskSpecInput) refuses the same task first, as INVALID_ARGUMENTS. A failed or timed
 * out call (CALL_FAILED), a crash or any other code is not a refusal.
 */
export function refusalJudgement(reply) {
  const code = reply?.error?.code;
  const planId = reply?.data?.plan?.id;
  if (planId) return { refused: false, reason: "the task was accepted" };
  if (reply?.thrown === true) return { refused: false, reason: `the call failed: ${reply.summary ?? ""}` };
  if (reply?.status === "error" && (code === "MISSING_INPUT" || code === "INVALID_ARGUMENTS")) return { refused: true };
  return { refused: false, reason: `not a validation refusal: ${code ?? reply?.status ?? "no reply"}` };
}

// ---------------------------------------------------------------------------------------
// Approval

/** The effect kinds of an action plan, in order; undefined when it lists none it can read. */
export function effectKinds(actionPlan) {
  const effects = actionPlan?.effects;
  if (!Array.isArray(effects) || effects.length === 0) return undefined;
  return effects.map((e) => (e && typeof e.kind === "string" ? e.kind : "(unreadable)"));
}

/** Whether the effects are exactly one local render, the only thing the runner approves. */
export function onlyLocalRender(kinds) {
  return Array.isArray(kinds) && kinds.length === 1 && kinds[0] === "local_render";
}

/**
 * Whether the runner may approve: the action plan the store holds for the approval request,
 * which is what the terminal approval approves, is the one the server replied with, is still
 * pending, and has a single local render as its only effect. Downloads, residency changes and
 * any effect added later are never approved by the runner (TODO 6.5.2). Returns the short
 * hash to type, taken from the stored plan, so the approval can't confirm another one.
 */
export function approvalJudgement({ reply, request, stored, shortHash }) {
  const replied = reply?.actionPlan;
  const requestId = reply?.approvalRequest?.id;
  if (!replied?.id || !requestId) return { ok: false, reason: "the prepare reply names no action plan or approval request" };
  if (!request) return { ok: false, reason: `approval request ${requestId} isn't in the store` };
  if (request.actionPlanId !== replied.id) return { ok: false, reason: `approval request ${requestId} is for ${request.actionPlanId}, not ${replied.id}` };
  if (request.state !== "pending") return { ok: false, reason: `approval request ${requestId} is ${request.state}` };
  if (!stored) return { ok: false, reason: `action plan ${replied.id} isn't in the store` };
  if (stored.id !== replied.id || typeof stored.hash !== "string" || stored.hash !== replied.hash) {
    return { ok: false, reason: `the stored action plan ${stored.id} differs from the one the server replied with` };
  }
  if (shortHash(stored.hash) !== reply.shortHash) return { ok: false, reason: "the reply's short hash isn't the stored action plan's" };
  const kinds = effectKinds(stored);
  if (!onlyLocalRender(kinds)) {
    return { ok: false, effects: kinds ?? [], reason: `the action plan's effects are ${kinds?.join(", ") ?? "unreadable"}; the runner approves a single local_render only` };
  }
  return { ok: true, effects: kinds, typed: shortHash(stored.hash) };
}

// ---------------------------------------------------------------------------------------
// Attempts and acceptance

/**
 * The attempt summary of a status reply. `attempts` absent: one first attempt, as
 * `summariseAttempts` counts it. Present, but not a list or with an attempt that doesn't
 * parse: the path is `unknown`, since the unread attempt may be the repaired one (#796).
 */
export function attemptSummary(rawAttempts, parseAttempt, summarise) {
  if (rawAttempts === undefined) return summarise(undefined);
  if (!Array.isArray(rawAttempts)) return { path: "unknown", smokeAttempts: 0, finalAttempts: 0, chainReported: true, unparsed: 1 };
  const parsed = rawAttempts.map((a) => parseAttempt(a));
  const ok = parsed.filter((p) => p.success).map((p) => p.data);
  const unparsed = parsed.length - ok.length;
  if (unparsed > 0) {
    // The counts cover the attempts that parsed; the unread ones are `unparsed`.
    const counted = ok.length > 0 ? summarise(ok) : { smokeAttempts: 0, finalAttempts: 0 };
    return { path: "unknown", smokeAttempts: counted.smokeAttempts, finalAttempts: counted.finalAttempts, chainReported: true, unparsed };
  }
  return summarise(ok);
}

/**
 * The criteria acceptance waits on, as evaluation.ts `acceptanceFrom` lists them: the
 * built-in checks of the kind (or the no-evaluator criterion), then the task's required
 * criteria; `userOnly` for a user_review criterion, which only the user's verdict resolves.
 */
export function requiredCriteria(task, { builtInImage, noEvaluator }) {
  const out = [];
  if (task?.media?.kind === "image") for (const id of builtInImage) out.push({ id, userOnly: false });
  else out.push({ id: noEvaluator, userOnly: false });
  for (const c of task?.acceptance ?? []) if (c.required) out.push({ id: c.id, userOnly: c.kind === "user_review" });
  return out;
}

/**
 * Whether a render's acceptance lets the fixture pass: `passed`, or `pending` only on
 * user_review criteria, which a runner can't answer. Every other required criterion must
 * have its latest counted verdict pass or not_applicable. `evaluations` is the status's list
 * in store order, so the last record of a criterion is its latest.
 */
export function acceptanceJudgement({ acceptance, evaluations, required }) {
  if (acceptance === "passed") return { ok: true, pendingOn: [] };
  if (acceptance !== "pending") return { ok: false, pendingOn: [], reason: `acceptance ${acceptance ?? "unknown"}` };
  if (!Array.isArray(required) || required.length === 0) return { ok: false, pendingOn: [], reason: "acceptance pending, and the task's criteria are unknown" };
  const list = Array.isArray(evaluations) ? evaluations : [];
  const latest = (c) => {
    let verdict;
    for (const e of list) {
      if (e?.criterion !== c.id || e.source === "agent_reported" || e.advisory === true || (c.userOnly && e.source !== "user")) continue;
      verdict = e.verdict;
    }
    return verdict;
  };
  const open = required.filter((c) => {
    const v = latest(c);
    return v === undefined || v === "unknown";
  });
  const failed = required.filter((c) => latest(c) === "fail");
  if (failed.length > 0) return { ok: false, pendingOn: open.map((c) => c.id), reason: `acceptance pending, yet ${failed.map((c) => c.id).join(", ")} failed` };
  const machine = open.filter((c) => !c.userOnly);
  if (machine.length > 0) return { ok: false, pendingOn: open.map((c) => c.id), reason: `acceptance pending on ${machine.map((c) => c.id).join(", ")}, not only on user review` };
  if (open.length === 0) return { ok: false, pendingOn: [], reason: "acceptance pending with every criterion resolved" };
  return { ok: true, pendingOn: open.map((c) => c.id) };
}

/** A render fixture's result: execution passed and acceptance as acceptanceJudgement allows. */
export function renderVerdict(execution, accepted) {
  if (execution !== "passed") return { ok: false, reason: `execution ${execution ?? "unknown"}` };
  if (!accepted.ok) return { ok: false, reason: `execution passed; ${accepted.reason}` };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------
// AT-09

/** What the guard must have patched for its log to cover the server (egress-guard.mjs). */
export const REQUIRED_PATCHES = [
  "fetch",
  "http.request",
  "http.get",
  "https.request",
  "https.get",
  "net.connect",
  "net.createConnection",
  "tls.connect",
  "socket.connect",
  "child_process.spawn",
  "child_process.spawnSync",
  "child_process.execFile",
  "child_process.execFileSync",
  "child_process.exec",
  "child_process.execSync",
  "child_process.fork",
  "dns.lookup",
  "dns.resolve",
  "dns.resolve4",
  "dns.resolve6",
  "dns.Resolver.resolve",
  "dns.promises.lookup",
  "dns.promises.resolve",
  "dns.promises.resolve4",
  "dns.promises.resolve6",
  "dns.promises.Resolver.resolve",
  "dgram.send",
  "dgram.connect",
];

/** The guard's records by kind: its startup lines, child-process spawns and destinations. */
export function classifyEgress(records) {
  const startup = [];
  const spawns = [];
  const destinations = [];
  for (const r of records) {
    if (r.kind === "startup") startup.push(r);
    else if (r.kind === "spawn") spawns.push(r);
    else destinations.push(r);
  }
  return { startup, spawns, destinations };
}

/**
 * System programs that only read this machine's state and open no connection: upstream runs
 * `lsof` on every model-path resolution and reads device facts through the others. Counting
 * them as unseen traffic would make every live AT-09 `unknown` without telling anything. A
 * program that can fetch (git, npm, hf, curl, comfy, python) is deliberately not here.
 */
export const LOCAL_ONLY_PROGRAMS = Object.freeze(["lsof", "ps", "pgrep", "sysctl", "sw_vers", "uname", "df", "vm_stat", "ioreg", "system_profiler", "which"]);

/** Whether a spawn starts node, whose own connections a guard in it would have to record. */
function nodeSpawn(spawn, execNames) {
  return spawn.via === "child_process.fork" || ["node", "node.exe", ...execNames].includes(spawn.command);
}

/** Whether a spawn needs no guard of its own: node (covered as above) or a local-only program. */
function seenSpawn(spawn, execNames) {
  return nodeSpawn(spawn, execNames) || LOCAL_ONLY_PROGRAMS.includes(spawn.command);
}

/** Sequence gaps per process: a line the guard numbered but the log doesn't hold. */
function sequenceGaps(records) {
  const byPid = new Map();
  let unnumbered = 0;
  for (const r of records) {
    if (!Number.isInteger(r.seq)) {
      unnumbered += 1;
      continue;
    }
    const pid = r.pid ?? -1;
    if (!byPid.has(pid)) byPid.set(pid, []);
    byPid.get(pid).push(r.seq);
  }
  let missing = 0;
  for (const seqs of byPid.values()) {
    const seen = new Set(seqs);
    const max = Math.max(...seqs);
    missing += max + 1 - seen.size;
  }
  return { missing, unnumbered };
}

/**
 * AT-09 over the whole session (spec §19.2): `passed` needs the log, its startup line with
 * every required patch, every line readable and numbered without a gap, no write failure
 * (the guard's `.errors` sidecar), no destination off this machine, and no spawn of a
 * program other than node or a LOCAL_ONLY_PROGRAMS one, whose traffic the guard can't see. An observed non-local
 * destination is `failed`; anything that leaves the log incomplete is `unknown`, never passed
 * (#796). `violations` is `egressViolations` over the destinations, passed in.
 */
export function at09Verdict({ logExists, log, sidecarExists, violations }) {
  if (!logExists) return { verdict: "unknown", reasons: ["the egress guard wrote no log"], violations: [], spawns: [] };
  const { startup, spawns, destinations } = classifyEgress(log.records);
  const bad = violations(destinations);
  const unknown = [];
  if (startup.length === 0) unknown.push("the log has no startup line");
  const patched = new Set(startup.flatMap((s) => (Array.isArray(s.patched) ? s.patched : [])));
  const unpatched = REQUIRED_PATCHES.filter((p) => !patched.has(p));
  if (startup.length > 0 && unpatched.length > 0) unknown.push(`the guard didn't patch ${unpatched.join(", ")}`);
  if (log.unreadable > 0) unknown.push(`${log.unreadable} unreadable line(s)`);
  const gaps = sequenceGaps(log.records);
  if (gaps.missing > 0) unknown.push(`${gaps.missing} line(s) missing from the sequence`);
  if (gaps.unnumbered > 0) unknown.push(`${gaps.unnumbered} line(s) without a sequence number`);
  if (sidecarExists) unknown.push("the guard recorded write failures (egress.jsonl.errors)");
  const execNames = startup.map((s) => s.execName).filter((n) => typeof n === "string");
  const foreign = [...new Set(spawns.filter((s) => !seenSpawn(s, execNames)).map((s) => s.command ?? "(unknown)"))].sort();
  if (foreign.length > 0) unknown.push(`child processes the guard can't see into: ${foreign.join(", ")}`);
  const spawned = [...new Set(spawns.map((s) => s.command ?? "(unknown)"))].sort();
  if (bad.length > 0) return { verdict: "failed", reasons: [`non-loopback destinations: ${bad.join(", ")}`, ...unknown], violations: bad, spawns: spawned };
  return { verdict: unknown.length > 0 ? "unknown" : "passed", reasons: unknown, violations: [], spawns: spawned };
}
