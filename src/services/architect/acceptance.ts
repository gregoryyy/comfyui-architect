// The reference acceptance suite's data (spec §19.2; TODO 6.5; ARCH 2026-11-16, milestone 6,
// acceptance suite): the task fixtures in `architect/acceptance/`, the synthetic input images
// they name, and the pure parts of the live runner's report: whether a conflict's blockers are
// the ones it expects (AT-02), which outbound destinations break AT-09 and how AT-04 counts
// first-attempt and repaired results.
//
// The CI test (`acceptance-suite.test.ts`) and the live runner (`scripts/architect/
// acceptance.mjs`) both read the fixtures through these schemas, so a field either of them
// can't read fails here, as a fixture bug, rather than being ignored. Nothing here talks to
// ComfyUI or renders an image; the runner turns `inputSvg` into PNG files itself.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PlanBlockers } from "./schemas.js";
import { isLoopbackHostname } from "./validate.js";

/** `architect/acceptance/` at the package root: three levels up from src/ and from dist/. */
export const ACCEPTANCE_DIR = fileURLToPath(new URL("../../../architect/acceptance/", import.meta.url));

/** The blocker categories of spec §9.5, as `Plan.blockers` names them. */
export const BlockerCategory = PlanBlockers.keyof();
export type BlockerCategory = z.infer<typeof BlockerCategory>;

/** Whether a blocker check is written as a regular expression: `/source/`. */
function isRegexCheck(check: string): boolean {
  return check.length > 2 && check.startsWith("/") && check.endsWith("/");
}

/**
 * One expected blocker line: a substring of the line, or a regular expression's source
 * between slashes (`/multiple of (16|32)/`). A substring is the default because the lines
 * quote file names and sizes full of characters a pattern would read as syntax.
 */
export const BlockerCheck = z
  .string()
  .min(1)
  .refine(
    (check) => {
      if (!isRegexCheck(check)) return true;
      try {
        new RegExp(check.slice(1, -1));
        return true;
      } catch {
        return false;
      }
    },
    { message: "a check between slashes must be a valid regular expression" },
  );

/** Whether a blocker line matches an expected check. */
export function blockerCheckMatches(check: string, line: string): boolean {
  return isRegexCheck(check) ? new RegExp(check.slice(1, -1)).test(line) : line.includes(check);
}

/** What a fixture expects planning to come to. */
export const AcceptanceExpectation = z.discriminatedUnion("outcome", [
  /** A feasible candidate of one of `recipes`. */
  z.object({ outcome: z.literal("feasible"), recipes: z.array(z.string().min(1)).min(1) }).strict(),
  /**
   * No feasible or acquirable candidate, blocked for the reason `checks` names (`judgeBlockers`).
   * `checks` are the lines `category` must hold; `related` the lines the same conflict puts in
   * other categories, as at-30's missing file is what the forbidden download would fetch.
   */
  z
    .object({
      outcome: z.literal("blocked"),
      category: BlockerCategory,
      checks: z.array(BlockerCheck).min(1),
      related: z.partialRecord(BlockerCategory, z.array(BlockerCheck).min(1)).optional(),
    })
    .strict(),
  /** The task is rejected as malformed before planning (AT-01). */
  z.object({ outcome: z.literal("refused") }).strict(),
]);
export type AcceptanceExpectation = z.infer<typeof AcceptanceExpectation>;

/**
 * One `<id>.task.json` (architect/acceptance/README.md). `task` stays unparsed here: a
 * `refused` fixture holds a task that `TaskSpecInput` must reject, so the caller parses it.
 */
export const AcceptanceFixture = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^at-\d{2}$/),
    title: z.string().min(1),
    expect: AcceptanceExpectation,
    /** The recipes `propose` may build; absent, every fitting recipe. */
    recipeIds: z.array(z.string().min(1)).min(1).optional(),
    /** How far the live runner takes it: render, plan, or the CI test only. */
    live: z.enum(["render", "plan", "fixture_only"]),
    why: z.string().min(1),
    task: z.unknown(),
    /** Bindings for open slots, as `propose` takes them. */
    proposals: z
      .array(z.object({ recipeId: z.string().min(1), bindings: z.record(z.string(), z.union([z.string(), z.number()])) }).strict())
      .optional(),
    /** Changes to the reference environment; a fixture with any runs in the CI test only. */
    environment: z
      .object({
        targetBaseUrl: z.string().url().optional(),
        /** Model files the target lacks, as `<folder>/<file>`. */
        removeModels: z.array(z.string().regex(/^[^/]+\/.+$/)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    // The live runner can't change the target's environment, so such a fixture can't be live.
    if (f.environment && f.live !== "fixture_only") {
      ctx.addIssue({ code: "custom", message: "a fixture that changes the environment runs in the CI test only (live: fixture_only)", path: ["live"] });
    }
    if (f.expect.outcome === "feasible" && f.recipeIds && !f.expect.recipes.every((r) => f.recipeIds?.includes(r))) {
      ctx.addIssue({ code: "custom", message: "an expected recipe isn't among recipeIds, so propose would never build it", path: ["expect", "recipes"] });
    }
  });
export type AcceptanceFixture = z.infer<typeof AcceptanceFixture>;

/** The synthetic input images (`inputs.json`). */
export const AcceptanceInputs = z
  .object({
    schemaVersion: z.literal(1),
    /**
     * The prefix of each file's name in the target's input folder. The files sit at its top
     * level: LoadImage lists only that level, and an input must be a file it lists (GAPS Q33).
     */
    prefix: z.string().regex(/^[a-z0-9][a-z0-9-]*-$/),
    files: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z0-9][a-z0-9x.-]*\.png$/),
            width: z.number().int().positive().max(4096),
            height: z.number().int().positive().max(4096),
            pattern: z.enum(["scene", "stripes", "mask-disc"]),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type AcceptanceInputs = z.infer<typeof AcceptanceInputs>;
export type AcceptanceInputFile = AcceptanceInputs["files"][number];

/** The fixtures of a folder, each parsed, and every file that didn't parse with its reason. */
export interface AcceptanceLoad {
  fixtures: AcceptanceFixture[];
  inputs?: AcceptanceInputs;
  errors: { file: string; message: string }[];
}

function readJson(file: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, "utf-8")) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function issues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/**
 * Load `<id>.task.json` and `inputs.json` from `dir`, in file-name order. A file that doesn't
 * parse, or whose `id` isn't its name, is listed in `errors` and left out; a missing
 * `inputs.json` is an error too, since every input-taking fixture needs it.
 */
export function loadAcceptanceFixtures(dir: string = ACCEPTANCE_DIR): AcceptanceLoad {
  const out: AcceptanceLoad = { fixtures: [], errors: [] };
  if (!existsSync(dir)) {
    out.errors.push({ file: dir, message: "the acceptance folder doesn't exist" });
    return out;
  }
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".task.json")).sort()) {
    const file = join(dir, name);
    const raw = readJson(file);
    if (!raw.ok) {
      out.errors.push({ file: name, message: `not valid JSON: ${raw.message}` });
      continue;
    }
    const parsed = AcceptanceFixture.safeParse(raw.value);
    if (!parsed.success) {
      out.errors.push({ file: name, message: issues(parsed.error) });
      continue;
    }
    if (`${parsed.data.id}.task.json` !== name) {
      out.errors.push({ file: name, message: `id ${parsed.data.id} doesn't match the file name` });
      continue;
    }
    out.fixtures.push(parsed.data);
  }
  const inputsFile = join(dir, "inputs.json");
  const raw = existsSync(inputsFile) ? readJson(inputsFile) : { ok: false as const, message: "missing" };
  if (!raw.ok) {
    out.errors.push({ file: "inputs.json", message: raw.message });
  } else {
    const parsed = AcceptanceInputs.safeParse(raw.value);
    if (parsed.success) out.inputs = parsed.data;
    else out.errors.push({ file: "inputs.json", message: issues(parsed.error) });
  }
  return out;
}

/** The name a task's `comfyui-input:` asset id gives an input file: `<prefix><name>`. */
export function inputName(inputs: Pick<AcceptanceInputs, "prefix">, file: Pick<AcceptanceInputFile, "name">): string {
  return `${inputs.prefix}${file.name}`;
}

/**
 * A synthetic input image as SVG, the same text for the same file entry every time: flat
 * shapes on integer coordinates, no text, no gradients, no randomness. `scene` is a
 * landscape (sky, two hills, a sun), `stripes` diagonal bands of three colours, `mask-disc` a
 * white disc on black, a quarter of the width across, centred, drawn without antialiasing so
 * the mask has only the values 0 and 255.
 */
export function inputSvg(file: Pick<AcceptanceInputFile, "width" | "height" | "pattern">): string {
  const { width: w, height: h } = file;
  const r = (x: number) => Math.round(x);
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
  switch (file.pattern) {
    case "scene":
      return (
        head +
        `<rect x="0" y="0" width="${w}" height="${h}" fill="#86b8e6"/>` +
        `<circle cx="${r(w * 0.78)}" cy="${r(h * 0.22)}" r="${r(Math.min(w, h) * 0.08)}" fill="#f6d24a"/>` +
        `<ellipse cx="${r(w * 0.25)}" cy="${r(h * 0.95)}" rx="${r(w * 0.55)}" ry="${r(h * 0.4)}" fill="#5f9e4f"/>` +
        `<ellipse cx="${r(w * 0.8)}" cy="${r(h * 1.02)}" rx="${r(w * 0.5)}" ry="${r(h * 0.35)}" fill="#3e7a3c"/>` +
        `<rect x="0" y="${r(h * 0.86)}" width="${w}" height="${h - r(h * 0.86)}" fill="#7a5a3a"/>` +
        "</svg>"
      );
    case "stripes": {
      const band = Math.max(1, r(Math.max(w, h) / 16));
      const colours = ["#d9483b", "#f2c14e", "#3b6ea5"];
      const shapes: string[] = [];
      // Each band is a parallelogram at 45 degrees; enough of them to cover the image.
      for (let i = 0, x = -h; x < w + band; i++, x += band) {
        shapes.push(`<polygon points="${x},0 ${x + band},0 ${x + band + h},${h} ${x + h},${h}" fill="${colours[i % colours.length]}"/>`);
      }
      return head + shapes.join("") + "</svg>";
    }
    case "mask-disc":
      return (
        head +
        `<rect x="0" y="0" width="${w}" height="${h}" fill="#000000"/>` +
        `<circle cx="${r(w / 2)}" cy="${r(h / 2)}" r="${r(w / 8)}" fill="#ffffff" shape-rendering="crispEdges"/>` +
        "</svg>"
      );
  }
}

// ---------------------------------------------------------------------------------------
// AT-02: a conflict blocked for its own reason

/**
 * The lines a failed compilation adds for each candidate it built no graph for (validate.ts):
 * the structure and native-type layers and the paid-node scan have nothing to check, so they
 * are unknown. They follow from the failure a fixture expects and are never its reason.
 */
export const COMPILE_KNOCK_ON_LINES = [
  "no graph: compilation failed its contract checks",
  "no compiled graph to scan for paid render nodes",
] as const;

/** Whether a blocker line is one of the knock-ons of a failed compilation, as `<recipe>: <line>`. */
export function isCompileKnockOn(line: string): boolean {
  return COMPILE_KNOCK_ON_LINES.some((k) => line === k || line.endsWith(`: ${k}`));
}

/** Whether a blocked fixture's plan was blocked for its reason, and what didn't match. */
export interface BlockerJudgement {
  passed: boolean;
  /**
   * Why the blockers couldn't be read, when they couldn't: the judgement is then unknown, and
   * `missing` and `unexpected` are empty because nothing was compared, not because nothing differed.
   */
  unreadable?: string;
  /** Expected checks no line matched, as `<category>: <check>`. */
  missing: string[];
  /** Lines no expected check matched that aren't knock-ons, as `<category>: <line>`. */
  unexpected: string[];
}

/**
 * Judge a plan's blockers against a blocked fixture (AT-02). It passes only when each
 * expected check matches a line of its category, every line is matched by a check of its
 * category or is a knock-on of a failed compilation, and so no category holds a reason the
 * fixture didn't name. A non-empty category alone isn't enough: a conflict that is also
 * blocked by, say, an unbound slot would pass while testing the wrong reason.
 *
 * `blockers` is parsed here, so the live runner can pass the plan's blockers as the tool
 * returned them; blockers that don't parse are `unreadable`, never an empty set (#796).
 */
export function judgeBlockers(fixture: Pick<AcceptanceFixture, "expect">, blockers: unknown): BlockerJudgement {
  const expectation = fixture.expect;
  if (expectation.outcome !== "blocked") {
    return { passed: false, missing: [`(fixture): expects ${expectation.outcome}, not blocked`], unexpected: [] };
  }
  const parsed = PlanBlockers.safeParse(blockers);
  if (!parsed.success) return { passed: false, unreadable: `the plan's blockers don't parse: ${issues(parsed.error)}`, missing: [], unexpected: [] };
  const expected: Partial<Record<BlockerCategory, string[]>> = { ...expectation.related, [expectation.category]: expectation.checks };
  const missing: string[] = [];
  const unexpected: string[] = [];
  for (const category of BlockerCategory.options) {
    const checks = expected[category] ?? [];
    const lines = parsed.data[category];
    for (const check of checks) if (!lines.some((l) => blockerCheckMatches(check, l))) missing.push(`${category}: ${check}`);
    for (const line of lines) {
      if (isCompileKnockOn(line) || checks.some((c) => blockerCheckMatches(c, line))) continue;
      unexpected.push(`${category}: ${line}`);
    }
  }
  return { passed: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}

// ---------------------------------------------------------------------------------------
// AT-09: outbound destinations

/** The variable naming the guard's log file; egress-guard.mjs reads the same name. */
export const EGRESS_LOG_ENV = "ARCHITECT_EGRESS_LOG";

/** One line of the egress guard's log (scripts/architect/egress-guard.mjs). */
export const EgressRecord = z
  .object({
    at: z.number().int().nonnegative(),
    via: z.string().min(1),
    host: z.string().optional(),
    port: z.number().int().optional(),
    /** A local socket path: never leaves the machine. */
    path: z.string().optional(),
    pid: z.number().int().optional(),
  })
  .passthrough();
export type EgressRecord = z.infer<typeof EgressRecord>;

/** Parse the guard's JSON-lines log; a line that doesn't parse is counted, never dropped silently. */
export function parseEgressLog(text: string): { records: EgressRecord[]; unreadable: number } {
  const records: EgressRecord[] = [];
  let unreadable = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      unreadable += 1;
      continue;
    }
    const parsed = EgressRecord.safeParse(value);
    if (parsed.success) records.push(parsed.data);
    else unreadable += 1;
  }
  return { records, unreadable };
}

/**
 * Whether a recorded destination stays on this machine: a local socket path, or a loopback
 * host. A record with neither a host nor a path didn't say where it went, so it isn't local.
 */
export function isLocalDestination(r: Pick<EgressRecord, "host" | "path">): boolean {
  if (r.host === undefined || r.host === "") return r.path !== undefined;
  return isLoopbackHostname(r.host);
}

/** The records in [from, to] whose destination isn't local, as `host:port` without duplicates. */
export function egressViolations(records: readonly EgressRecord[], from: number, to: number): string[] {
  const out = new Set<string>();
  for (const r of records) {
    if (r.at < from || r.at > to || isLocalDestination(r)) continue;
    out.add(`${r.host ?? "(no host)"}${r.port !== undefined ? `:${r.port}` : ""}`);
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------------------
// AT-04: executable results, first attempt and repaired apart

/** One attempt as `architect_run status` lists it (`attempts`), the fields the count reads. */
export const StatusAttempt = z
  .object({
    runId: z.string(),
    index: z.number().int().optional(),
    stage: z.enum(["smoke", "final"]).optional(),
    repairRound: z.number().int().optional(),
    state: z.string(),
    execution: z.string().optional(),
    graph: z
      .object({ transformations: z.array(z.object({ id: z.string() }).passthrough()).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type StatusAttempt = z.infer<typeof StatusAttempt>;

/** The smoke stage's transformation (repair.ts `SMOKE_TRANSFORMATION`); a step beyond it is a repair. */
export const SMOKE_TRANSFORMATION_ID = "preview.min_steps";

/** Whether an attempt was repaired: a repair round, or a graph step other than the smoke stage's. */
export function attemptRepaired(a: StatusAttempt): boolean {
  if ((a.repairRound ?? 0) > 0) return true;
  return (a.graph?.transformations ?? []).some((t) => t.id !== SMOKE_TRANSFORMATION_ID);
}

/** How a rendered fixture's attempts came out, for the report. */
export interface AttemptSummary {
  /**
   * `first_attempt`: the first final attempt whose execution passed wasn't repaired;
   * `repaired`: it was. With no executable final, whether any attempt was repaired.
   */
  path: "first_attempt" | "repaired";
  smokeAttempts: number;
  finalAttempts: number;
  /** Whether `attempts` was in the status; absent, the run counts as a single first attempt. */
  chainReported: boolean;
}

/**
 * Count a status's attempts, in the order the status lists them; without `attempts` the run
 * is one first attempt. AT-04 asks whether the result was executable at the first attempt,
 * so the path is the first executable final's: a quality repair after it (another seed, say)
 * renders again but doesn't make an executable first final a repaired one.
 */
export function summariseAttempts(attempts: readonly StatusAttempt[] | undefined): AttemptSummary {
  if (attempts === undefined || attempts.length === 0) return { path: "first_attempt", smokeAttempts: 0, finalAttempts: 1, chainReported: false };
  const finals = attempts.filter((a) => a.stage !== "smoke");
  const executable = finals.find((a) => a.execution === "passed");
  const repaired = executable ? attemptRepaired(executable) : attempts.some(attemptRepaired);
  return {
    path: repaired ? "repaired" : "first_attempt",
    smokeAttempts: attempts.length - finals.length,
    finalAttempts: finals.length,
    chainReported: true,
  };
}

/** One feasible fixture's live result, as the AT-04 count reads it. */
export interface RenderedResult {
  id: string;
  /** The result's execution verdict (`verdicts.execution`); `passed` is an executable result. */
  execution: string | undefined;
  path: AttemptSummary["path"];
}

/** AT-04's proposed target (EVAL E1): 90% of the feasible fixtures. */
export const AT04_TARGET = 0.9;

/**
 * AT-04 over the feasible fixtures: the share with an executable result, first-attempt and
 * repaired apart. A feasible fixture that wasn't rendered counts against the share, and
 * `complete` says whether every one was rendered.
 */
export function at04(feasibleIds: readonly string[], results: readonly RenderedResult[]) {
  const byId = new Map(results.map((r) => [r.id, r]));
  const rendered = feasibleIds.filter((id) => byId.has(id));
  const executable = rendered.filter((id) => byId.get(id)?.execution === "passed");
  const firstAttempt = executable.filter((id) => byId.get(id)?.path === "first_attempt");
  const repaired = executable.filter((id) => byId.get(id)?.path === "repaired");
  const share = feasibleIds.length === 0 ? 0 : executable.length / feasibleIds.length;
  return {
    feasible: feasibleIds.length,
    rendered: rendered.length,
    complete: rendered.length === feasibleIds.length,
    executable: executable.length,
    firstAttempt: firstAttempt.length,
    repaired: repaired.length,
    notExecutable: rendered.filter((id) => !executable.includes(id)),
    notRendered: feasibleIds.filter((id) => !byId.has(id)),
    share,
    firstAttemptShare: feasibleIds.length === 0 ? 0 : firstAttempt.length / feasibleIds.length,
    target: AT04_TARGET,
    passed: rendered.length === feasibleIds.length && share >= AT04_TARGET,
  };
}
