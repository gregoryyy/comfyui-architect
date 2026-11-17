// The live acceptance runner's judgements (scripts/architect/acceptance-judge.mjs; TODO 6.5.2):
// the target check, the server's environment, the refusal AT-01 counts, what the runner may
// approve, the attempt path, a render fixture's acceptance and AT-09 over the session. Pure
// functions over values; no server, ComfyUI or build.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { StatusAttempt, egressViolations, loadAcceptanceFixtures, summariseAttempts } from "../../services/architect/acceptance.js";
import { shortHash } from "../../services/architect/admission.js";
import { ARCHITECT_ENV_KEYS, ARCHITECT_PANEL_RUNS_ENV, ARCHITECT_RESIDENCY_ENV, ARCHITECT_ROUTE_ENV } from "../../services/architect/config.js";
import { BUILT_IN_IMAGE_CRITERIA, NO_EVALUATOR_CRITERION } from "../../services/architect/evaluation.js";
import { ArchitectService } from "../../services/architect/service.js";
import { isLoopbackHostname } from "../../services/architect/validate.js";
import { registerArchitectTools } from "../../tools/architect.js";
import {
  KEPT_ARCHITECT_ENV,
  REQUIRED_PATCHES,
  acceptanceJudgement,
  approvalJudgement,
  at09Verdict,
  LOCAL_ONLY_PROGRAMS,
  attemptSummary,
  parseReply,
  refusalJudgement,
  renderVerdict,
  requiredCriteria,
  serverEnv,
  strictLoopbackHost,
} from "../../../scripts/architect/acceptance-judge.mjs";

describe("the runner's target check", () => {
  it("accepts localhost, ::1 and 127.0.0.0/8", () => {
    for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) expect(strictLoopbackHost(h), h).toBe(true);
  });

  it("refuses the bind addresses validate.ts counts as loopback, and every other host", () => {
    // The reason the runner has its own check: these two pass validate.ts.
    expect(isLoopbackHostname("0.0.0.0")).toBe(true);
    expect(isLoopbackHostname("::")).toBe(true);
    for (const h of ["0.0.0.0", "::", "[::]", "127.0.0.256", "128.0.0.1", "192.168.1.10", "comfy.local", "localhost.example.org", ""]) {
      expect(strictLoopbackHost(h), h).toBe(false);
    }
  });
});

describe("the server's environment", () => {
  it("drops the variables that widen what a run may do, and any ARCHITECT_* it doesn't know", () => {
    const env = serverEnv(
      {
        PATH: "/usr/bin",
        COMFYUI_URL: "http://127.0.0.1:8188",
        [ARCHITECT_RESIDENCY_ENV]: "1",
        [ARCHITECT_PANEL_RUNS_ENV]: "terminal",
        [ARCHITECT_ROUTE_ENV]: "panel",
        ARCHITECT_SOMETHING_LATER: "yes",
        ARCHITECT_OCR_MODEL: "glm-ocr:latest",
        ARCHITECT_DATA_DIR: "/elsewhere",
        UNSET: undefined,
      },
      { COMFYUI_ARCHITECT: "1", ARCHITECT_DATA_DIR: "/run/data" },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      COMFYUI_URL: "http://127.0.0.1:8188",
      ARCHITECT_OCR_MODEL: "glm-ocr:latest",
      COMFYUI_ARCHITECT: "1",
      ARCHITECT_DATA_DIR: "/run/data",
    });
  });

  it("keeps only variables Architect reads, and none that widens a run", () => {
    const known: readonly string[] = ARCHITECT_ENV_KEYS;
    for (const key of KEPT_ARCHITECT_ENV) expect(known, key).toContain(key);
    for (const key of [ARCHITECT_RESIDENCY_ENV, ARCHITECT_PANEL_RUNS_ENV, ARCHITECT_ROUTE_ENV]) expect(KEPT_ARCHITECT_ENV).not.toContain(key);
  });
});

describe("AT-01's refusal over MCP", () => {
  it("reads the SDK's input-schema refusal of the video fixture as INVALID_ARGUMENTS, before planning is reached", async () => {
    const fixture = loadAcceptanceFixtures().fixtures.find((f) => f.id === "at-21");
    expect(fixture?.expect.outcome).toBe("refused");
    const server = new McpServer({ name: "t", version: "0" });
    const service = new ArchitectService({
      upstream: {
        comfyuiBaseUrl: () => "http://127.0.0.1:8188",
        systemStats: async () => {
          throw new Error("not reached");
        },
        objectInfo: async () => {
          throw new Error("not reached");
        },
        installedModels: async () => {
          throw new Error("not reached");
        },
        isPaidNode: () => false,
      },
      now: () => new Date(),
      newId: () => "x",
    });
    // A planning or run context that is built would make the reply an INTERNAL_ERROR envelope.
    registerArchitectTools(
      server,
      service,
      () => {
        throw new Error("planning reached");
      },
      () => {
        throw new Error("run context reached");
      },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    const reply = parseReply(await client.callTool({ name: "architect_plan", arguments: { action: "prepare", task: fixture?.task } }));
    expect(reply.error).toEqual({ code: "INVALID_ARGUMENTS" });
    expect(refusalJudgement(reply)).toEqual({ refused: true });
    await client.close();
  });

  it("counts planning's MISSING_INPUT and the SDK's refusal, and nothing else", () => {
    expect(refusalJudgement({ status: "error", isError: true, error: { code: "MISSING_INPUT" } })).toEqual({ refused: true });
    const refusedNot = [
      { status: "error", isError: true, thrown: true, summary: "Request timed out", error: { code: "CALL_FAILED" } },
      { status: "error", isError: true, thrown: true, summary: "Connection closed", error: { code: "CALL_FAILED" } },
      { status: "error", isError: true, error: { code: "INTERNAL_ERROR" } },
      parseReply({ content: [{ type: "text", text: "TypeError: x is undefined" }], isError: true }),
      { status: "ok", isError: false, data: { plan: { id: "plan-1" } } },
      undefined,
    ];
    for (const r of refusedNot) expect(refusalJudgement(r).refused, JSON.stringify(r)).toBe(false);
  });

  it("reads a plain-text reply as the SDK's refusal only when it says so and is an error", () => {
    const text = "MCP error -32602: Input validation error: Invalid arguments for tool architect_plan: ...";
    expect(parseReply({ content: [{ type: "text", text }], isError: true }).error.code).toBe("INVALID_ARGUMENTS");
    expect(parseReply({ content: [{ type: "text", text }] }).error.code).toBe("UNREADABLE_REPLY");
    expect(parseReply({ content: [{ type: "text", text: "Error: crashed" }], isError: true }).error.code).toBe("UNREADABLE_REPLY");
    expect(parseReply({ content: [{ type: "text", text: "[1]" }] }).error.code).toBe("UNREADABLE_REPLY");
    expect(parseReply({ content: [{ type: "text", text: '{"status":"ok","data":{}}' }] })).toEqual({ status: "ok", data: {}, isError: false });
  });
});

describe("what the runner approves", () => {
  const hash = "a".repeat(64);
  const render = { kind: "local_render", graphFingerprint: "b".repeat(64), outputNodes: ["9"], stages: {}, repair: {} };
  const plan = (effects: unknown[], over: Record<string, unknown> = {}) => ({ id: "actions-1", hash, effects, ...over });
  const reply = (p: ReturnType<typeof plan>) => ({ actionPlan: p, approvalRequest: { id: "request-1" }, shortHash: shortHash(p.hash) });
  const request = { id: "request-1", actionPlanId: "actions-1", state: "pending" };

  it("approves a single local render, typing the stored plan's hash", () => {
    const stored = plan([render]);
    expect(approvalJudgement({ reply: reply(stored), request, stored, shortHash })).toEqual({ ok: true, effects: ["local_render"], typed: shortHash(hash) });
  });

  it("refuses downloads, residency changes, a second render and an unknown effect, naming the effects", () => {
    const cases = [
      [{ kind: "acquire_models" }, render],
      [render, { kind: "release_residency" }],
      [render, render],
      [{ kind: "install_nodes" }],
      [],
    ];
    for (const effects of cases) {
      const stored = plan(effects);
      const j = approvalJudgement({ reply: reply(stored), request, stored, shortHash });
      expect(j.ok, JSON.stringify(effects)).toBe(false);
      for (const e of effects) expect(j.reason).toContain(e.kind);
    }
  });

  it("refuses when the store's record isn't the one the server replied with", () => {
    const stored = plan([render]);
    const ok = { reply: reply(stored), request, stored, shortHash };
    const cases: [string, Parameters<typeof approvalJudgement>[0]][] = [
      ["no request", { ...ok, request: undefined }],
      ["another plan's request", { ...ok, request: { ...request, actionPlanId: "actions-2" } }],
      ["a request no longer pending", { ...ok, request: { ...request, state: "granted" } }],
      ["no stored plan", { ...ok, stored: undefined }],
      ["another hash", { ...ok, stored: plan([render], { hash: "c".repeat(64) }) }],
      ["a reply whose short hash differs", { ...ok, reply: { ...reply(stored), shortHash: "deadbeef" } }],
      ["a reply without a request", { ...ok, reply: { actionPlan: stored, shortHash: shortHash(hash) } }],
      // The reply shows one render, the store holds a download as well: the store's counts.
      ["a stored plan with more effects than the reply", { ...ok, reply: reply(plan([render])), stored: plan([render, { kind: "acquire_models" }]) }],
    ];
    for (const [name, input] of cases) expect(approvalJudgement(input).ok, name).toBe(false);
  });
});

describe("the attempt path", () => {
  const attempt = (over: Record<string, unknown> = {}) => ({ runId: "run-1", index: 1, stage: "final", state: "COMPLETED", ...over });
  const summary = (raw: unknown) => attemptSummary(raw, (a: unknown) => StatusAttempt.safeParse(a), summariseAttempts);

  it("is a first attempt without `attempts`, and as summariseAttempts counts parsed ones", () => {
    expect(summary(undefined)).toEqual(summariseAttempts(undefined));
    expect(summary([attempt()]).path).toBe("first_attempt");
    expect(summary([attempt({ repairRound: 1 })]).path).toBe("repaired");
  });

  it("is unknown when an attempt doesn't parse, or none does", () => {
    expect(summary([{ nonsense: true }])).toMatchObject({ path: "unknown", unparsed: 1, smokeAttempts: 0, finalAttempts: 0 });
    expect(summary([attempt(), { runId: 7 }])).toMatchObject({ path: "unknown", unparsed: 1, finalAttempts: 1 });
    expect(summary({ not: "a list" })).toMatchObject({ path: "unknown" });
  });
});

describe("a render fixture's acceptance", () => {
  const task = {
    media: { kind: "image" },
    acceptance: [
      { id: "review", kind: "user_review", required: true },
      { id: "advice", kind: "text_in_image", required: false },
    ],
  };
  const required = requiredCriteria(task, { builtInImage: BUILT_IN_IMAGE_CRITERIA, noEvaluator: NO_EVALUATOR_CRITERION });
  const builtIns = BUILT_IN_IMAGE_CRITERIA.map((criterion) => ({ criterion, verdict: "pass", source: "automatic" }));

  it("lists the built-in checks and the task's required criteria, as acceptanceFrom does", () => {
    expect(required).toEqual([...BUILT_IN_IMAGE_CRITERIA.map((id) => ({ id, userOnly: false })), { id: "review", userOnly: true }]);
    expect(requiredCriteria({ media: { kind: "video" }, acceptance: [] }, { builtInImage: BUILT_IN_IMAGE_CRITERIA, noEvaluator: NO_EVALUATOR_CRITERION })).toEqual([
      { id: NO_EVALUATOR_CRITERION, userOnly: false },
    ]);
  });

  it("passes on acceptance passed, or pending only on user review", () => {
    expect(acceptanceJudgement({ acceptance: "passed", evaluations: [], required })).toEqual({ ok: true, pendingOn: [] });
    expect(acceptanceJudgement({ acceptance: "pending", evaluations: builtIns, required })).toEqual({ ok: true, pendingOn: ["review"] });
  });

  it("fails on acceptance pending on a check, failed, waived, or with criteria it can't list", () => {
    const unknownDims = builtIns.map((e) => (e.criterion === "output_dimensions" ? { ...e, verdict: "unknown" } : e));
    const missing = builtIns.filter((e) => e.criterion !== "output_readable");
    const advisoryOnly = builtIns.map((e) => (e.criterion === "output_format" ? { ...e, advisory: true } : e));
    const agentOnly = builtIns.map((e) => (e.criterion === "output_count" ? { ...e, source: "agent_reported" } : e));
    // A later record of the same criterion replaces an earlier one.
    const laterUnknown = [...builtIns, { criterion: "output_count", verdict: "unknown", source: "automatic" }];
    for (const evaluations of [unknownDims, missing, advisoryOnly, agentOnly, laterUnknown]) {
      const j = acceptanceJudgement({ acceptance: "pending", evaluations, required });
      expect(j.ok, JSON.stringify(j)).toBe(false);
      expect(j.reason).toMatch(/not only on user review/);
    }
    expect(acceptanceJudgement({ acceptance: "failed", evaluations: builtIns, required }).ok).toBe(false);
    expect(acceptanceJudgement({ acceptance: "waived_by_user", evaluations: builtIns, required }).ok).toBe(false);
    expect(acceptanceJudgement({ acceptance: undefined, evaluations: builtIns, required }).ok).toBe(false);
    expect(acceptanceJudgement({ acceptance: "pending", evaluations: builtIns, required: [] }).ok).toBe(false);
  });

  it("doesn't let an automatic record stand in for the user's review", () => {
    const noReview = requiredCriteria({ media: { kind: "image" }, acceptance: [] }, { builtInImage: BUILT_IN_IMAGE_CRITERIA, noEvaluator: NO_EVALUATOR_CRITERION });
    // Pending although every check passed and nothing waits on a review: not a pass.
    expect(acceptanceJudgement({ acceptance: "pending", evaluations: builtIns, required: noReview }).ok).toBe(false);
    const automaticReview = [...builtIns, { criterion: "review", verdict: "pass", source: "automatic" }];
    expect(acceptanceJudgement({ acceptance: "pending", evaluations: automaticReview, required })).toEqual({ ok: true, pendingOn: ["review"] });
  });

  it("needs execution passed as well", () => {
    const accepted = { ok: true, pendingOn: [] };
    expect(renderVerdict("passed", accepted)).toEqual({ ok: true });
    for (const e of ["failed", "unknown", "cancelled", undefined]) expect(renderVerdict(e, accepted).ok).toBe(false);
    expect(renderVerdict("passed", { ok: false, pendingOn: [], reason: "acceptance failed" })).toEqual({ ok: false, reason: "execution passed; acceptance failed" });
  });
});

describe("AT-09 over the session", () => {
  const violations = (rs: Parameters<typeof egressViolations>[0]) => egressViolations(rs, 0, Number.MAX_SAFE_INTEGER);
  const startup = { at: 1, via: "startup", kind: "startup", patched: [...REQUIRED_PATCHES], execName: "node", pid: 1, seq: 0 };
  const line = (seq: number, over: Record<string, unknown>) => ({ at: 10 + seq, via: "fetch", host: "127.0.0.1", port: 8188, pid: 1, seq, ...over });
  const judge = (records: Record<string, unknown>[], over: { unreadable?: number; sidecarExists?: boolean; logExists?: boolean } = {}) =>
    at09Verdict({
      logExists: over.logExists ?? true,
      log: { records: records.map((r) => ({ at: 0, via: "x", ...r })), unreadable: over.unreadable ?? 0 },
      sidecarExists: over.sidecarExists ?? false,
      violations,
    });

  it("passes a complete log with loopback destinations and node children only", () => {
    const v = judge([startup, line(1, {}), line(2, { kind: "dns", host: "localhost", port: undefined }), line(3, { kind: "spawn", via: "child_process.fork", command: "node", host: undefined })]);
    expect(v).toEqual({ verdict: "passed", reasons: [], violations: [], spawns: ["node"] });
  });

  it("passes local-only system programs such as lsof, and nothing that can fetch", () => {
    const spawn = (seq: number, command: string) => line(seq, { kind: "spawn", via: "child_process.execFile", command, host: undefined });
    expect(judge([startup, spawn(1, "lsof"), spawn(2, "sysctl")]).verdict).toBe("passed");
    for (const fetcher of ["git", "npm", "hf", "curl", "comfy", "python3"]) {
      expect(LOCAL_ONLY_PROGRAMS, fetcher).not.toContain(fetcher);
      expect(judge([startup, spawn(1, "lsof"), spawn(2, fetcher)]).verdict, fetcher).toBe("unknown");
    }
  });

  it("fails on a non-loopback destination anywhere in the session", () => {
    const v = judge([startup, line(1, { host: "huggingface.co", port: 443 }), line(2, { kind: "dns", host: "example.org", port: undefined })]);
    expect(v.verdict).toBe("failed");
    expect(v.violations).toEqual(["example.org", "huggingface.co:443"]);
  });

  it("is unknown, never passed, when the log is incomplete or a program other than node or a local-only one ran", () => {
    const cases: [string, ReturnType<typeof judge>][] = [
      ["no log", judge([], { logExists: false })],
      ["no startup line", judge([line(0, {})])],
      ["a missing patch", judge([{ ...startup, patched: REQUIRED_PATCHES.filter((p) => p !== "dns.lookup") }])],
      ["an unreadable line", judge([startup], { unreadable: 1 })],
      ["a gap", judge([startup, line(2, {})])],
      ["an unnumbered line", judge([startup, line(1, { seq: undefined })])],
      ["write failures", judge([startup], { sidecarExists: true })],
      ["git", judge([startup, line(1, { kind: "spawn", via: "child_process.spawn", command: "git", host: undefined })])],
      ["a shell line", judge([startup, line(1, { kind: "spawn", via: "child_process.exec", command: "(unreadable)", host: undefined })])],
    ];
    for (const [name, v] of cases) {
      expect(v.verdict, name).toBe("unknown");
      expect(v.reasons.length, name).toBeGreaterThan(0);
    }
    expect(cases[7][1].reasons.join(" ")).toContain("git");
    expect(cases[2][1].reasons.join(" ")).toContain("dns.lookup");
  });

  it("stays failed when a violation comes with an incomplete log", () => {
    const v = judge([startup, line(1, { host: "192.0.2.9", port: 80 }), line(3, {})], { sidecarExists: true });
    expect(v.verdict).toBe("failed");
    expect(v.reasons.length).toBeGreaterThan(1);
  });
});
