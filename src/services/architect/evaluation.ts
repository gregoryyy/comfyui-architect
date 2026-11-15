// Automatic output checks (spec §13.2; TODO 3.7, AT-08): run completion, output count,
// readability, format and dimensions against the task, one `EvaluationRecord` each.
//
// Data in, data out: the controller fetches and probes the files, this module only judges
// them. A file that couldn't be fetched or whose header couldn't be read is never a pass:
// what can't be observed is `unknown` (spec §7.3, #796). `user_review` criteria aren't
// judged here; they stay pending until the user's verdict arrives through an approval
// channel (ARCH milestone 3, evaluation).

import { canonicalJson, sha256Hex } from "./hash.js";
import type { MediaProbe } from "./media-probe.js";
import {
  type Acceptance,
  type AcceptanceCriterion,
  type EvaluationRecord,
  type RunOutput,
  type RunRecord,
  type TaskSpec,
  type Verdict,
} from "./schemas.js";
import type { z } from "zod";

export const OUTPUT_EVALUATOR_ID = "architect.output-basic";
export const OUTPUT_EVALUATOR_VERSION = "1";

/** The criteria this evaluator adds for every image task, besides the task's own. */
export const BUILT_IN_IMAGE_CRITERIA = [
  "run_completion",
  "output_count",
  "output_readable",
  "output_format",
  "output_dimensions",
] as const;

/** The criterion a kind without an evaluator gets its one `not_applicable` record under. */
export const NO_EVALUATOR_CRITERION = "automatic_checks";

/** What the controller learned about one output file. */
export type OutputProbe =
  | MediaProbe
  /** The bytes couldn't be fetched; nothing about the file was observed. */
  | { readable: false; fetched: false; reason: string };

export interface ProbedOutput {
  ref: RunOutput;
  probe: OutputProbe;
}

export interface EvaluateOutputsInput {
  run: RunRecord;
  task: TaskSpec;
  files: readonly ProbedOutput[];
  /** Output entries ComfyUI's history listed in a shape that couldn't be read. */
  unparsedOutputs?: number;
  at: Date;
}

type EvaluationInput = z.input<typeof EvaluationRecord>;

/**
 * The evaluation's ID: a digest of run, evaluator and criterion, so evaluating a run again
 * after a restart finds the records it already stored instead of writing a second set.
 */
export function evaluationId(runId: string, criterionId: string): string {
  return `eval-${sha256Hex(canonicalJson([runId, OUTPUT_EVALUATOR_ID, criterionId])).slice(0, 32)}`;
}

function refOf(o: RunOutput): string {
  return `${o.type}/${o.subfolder ? `${o.subfolder}/` : ""}${o.filename}`;
}

/** Combine per-file verdicts: a fail decides, then an unknown; pass only when every file passed. */
function combine(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.length === 0) return "not_applicable";
  if (verdicts.includes("fail")) return "fail";
  if (verdicts.includes("unknown")) return "unknown";
  return "pass";
}

/**
 * The automatic checks of a run's outputs against its task. Kind-neutral entry point: an
 * image task gets the built-in criteria and its `dimensions` and `protected_region_exact`
 * criteria; a kind without an evaluator gets one `not_applicable` record saying so, never
 * an exception and never a pass.
 */
export function evaluateOutputs(input: EvaluateOutputsInput): EvaluationInput[] {
  const { run, task, at } = input;
  const record = (
    criterionId: string,
    verdict: Verdict,
    explanation: string,
    extra: { measurement?: { value: number; unit: string }; evidence?: string[] } = {},
  ): EvaluationInput => ({
    schemaVersion: 1,
    id: evaluationId(run.id, criterionId),
    runId: run.id,
    criterionId,
    evaluatorId: OUTPUT_EVALUATOR_ID,
    evaluatorVersion: OUTPUT_EVALUATOR_VERSION,
    verdict,
    source: "automatic",
    explanation,
    evidence: extra.evidence ?? input.files.map((f) => refOf(f.ref)),
    ...(extra.measurement ? { measurement: extra.measurement } : {}),
    createdAt: at.toISOString(),
  });

  // A kind captured in a string, so the fall-through below still reads it once the
  // union has more members than the image part.
  const kind: string = task.media.kind;
  if (task.media.kind === "image") return evaluateImage(input, task.media.output, record);
  return [record(NO_EVALUATOR_CRITERION, "not_applicable", `no automatic evaluator exists for ${kind} outputs yet`, { evidence: [] })];
}

type RecordFn = (
  criterionId: string,
  verdict: Verdict,
  explanation: string,
  extra?: { measurement?: { value: number; unit: string }; evidence?: string[] },
) => EvaluationInput;

function evaluateImage(
  input: EvaluateOutputsInput,
  output: { width: number; height: number; count: number; format: "png" | "jpeg" | "webp" },
  record: RecordFn,
): EvaluationInput[] {
  const { run, task, files } = input;
  const unparsed = input.unparsedOutputs ?? 0;
  const out: EvaluationInput[] = [];

  // Run completion: the controller evaluates only after ComfyUI's history reported the
  // prompt completed with status success, which is what EVALUATING means.
  const done = run.state === "EVALUATING" || run.state === "AWAITING_REVIEW" || run.state === "COMPLETED";
  out.push(
    done
      ? record("run_completion", "pass", `ComfyUI reported prompt ${run.promptId ?? "(none)"} completed successfully`, { evidence: [] })
      : record("run_completion", "unknown", `the run is ${run.state}; completion hasn't been observed`, { evidence: [] }),
  );

  const count = files.length;
  const countUnit = { value: count, unit: "files" };
  if (unparsed > 0) {
    out.push(
      record("output_count", "unknown", `${count} image output(s) read, ${unparsed} more history entr${unparsed === 1 ? "y" : "ies"} couldn't be read; the task asks for ${output.count}`, {
        measurement: countUnit,
      }),
    );
  } else {
    out.push(
      record(
        "output_count",
        count === output.count ? "pass" : "fail",
        `${count} image output(s), the task asks for ${output.count}`,
        { measurement: countUnit },
      ),
    );
  }

  // A header that was fetched and doesn't parse is an observed failure; bytes that never
  // arrived, or an entry that couldn't even be named, say nothing about the file.
  const readable = combine(files.map((f): Verdict => (f.probe.readable ? "pass" : "fetched" in f.probe ? "unknown" : "fail")));
  const unreadable = files.filter((f) => !f.probe.readable);
  const readableVerdict = unparsed > 0 && readable !== "fail" ? "unknown" : readable;
  const readableNotes = unreadable.map((f) => `${refOf(f.ref)}: ${f.probe.readable ? "" : f.probe.reason}`);
  if (unparsed > 0) readableNotes.push(`${unparsed} history entr${unparsed === 1 ? "y" : "ies"} couldn't be read`);
  out.push(
    record(
      "output_readable",
      readableVerdict,
      readableNotes.length > 0
        ? readableNotes.join("; ")
        : files.length === 0
          ? "no output files to read"
          : "every output file's header was read",
    ),
  );

  out.push(formatCheck(files, output.format, record));
  out.push(dimensionsCheck("output_dimensions", files, [output.width, output.height], record));

  for (const criterion of task.acceptance) out.push(...taskCriterion(criterion, files, record));
  return out;
}

function formatCheck(files: readonly ProbedOutput[], expected: string, record: RecordFn): EvaluationInput {
  const verdicts = files.map((f): Verdict => (!f.probe.readable ? "unknown" : f.probe.format === expected ? "pass" : "fail"));
  const notes = files.map((f) => `${refOf(f.ref)}: ${f.probe.readable ? f.probe.format : "format unknown, the file wasn't read"}`);
  const verdict = combine(verdicts);
  return record(
    "output_format",
    verdict,
    verdict === "not_applicable" ? "no output files to check" : `the task asks for ${expected}; ${notes.join("; ")}`,
  );
}

function dimensionsCheck(
  criterionId: string,
  files: readonly ProbedOutput[],
  [width, height]: readonly [number, number],
  record: RecordFn,
): EvaluationInput {
  const verdicts = files.map((f): Verdict =>
    !f.probe.readable ? "unknown" : f.probe.width === width && f.probe.height === height ? "pass" : "fail",
  );
  const notes = files.map(
    (f) => `${refOf(f.ref)}: ${f.probe.readable ? `${f.probe.width}×${f.probe.height}` : "size unknown, the file wasn't read"}`,
  );
  const verdict = combine(verdicts);
  const first = files[0]?.probe;
  return record(
    criterionId,
    verdict,
    verdict === "not_applicable" ? "no output files to measure" : `expected ${width}×${height}; ${notes.join("; ")}`,
    first?.readable && files.length === 1 ? { measurement: { value: first.width * first.height, unit: "px" } } : {},
  );
}

function taskCriterion(criterion: AcceptanceCriterion, files: readonly ProbedOutput[], record: RecordFn): EvaluationInput[] {
  switch (criterion.kind) {
    case "dimensions":
      return [dimensionsCheck(criterion.id, files, criterion.expected, record)];
    case "protected_region_exact":
      // A required criterion without a reliable evaluator stays pending (spec §7.3).
      return [record(criterion.id, "unknown", "no evaluator for protected_region_exact exists in this milestone", { evidence: [] })];
    case "user_review":
      return [];
  }
}

/**
 * The run's acceptance from its evaluations (spec §4.2, §15.3). The built-in criteria count
 * as required, the task's criteria by their `required` flag. A `user_review` criterion
 * counts only the user's verdict, and an agent's report counts for nothing, since it is the
 * agent's opinion (ARCH milestone 3, evaluation). A required failure fails acceptance; a
 * required unknown or missing verdict leaves it pending; it passes only when something was
 * checked and every required criterion passed or didn't apply. The latest record of a
 * criterion decides.
 */
export function acceptanceFrom(task: TaskSpec, records: readonly EvaluationRecord[]): Acceptance {
  const required: { id: string; userOnly: boolean }[] = [];
  if (task.media.kind === "image") for (const id of BUILT_IN_IMAGE_CRITERIA) required.push({ id, userOnly: false });
  else required.push({ id: NO_EVALUATOR_CRITERION, userOnly: false });
  for (const c of task.acceptance) if (c.required) required.push({ id: c.id, userOnly: c.kind === "user_review" });

  const verdicts = required.map(({ id, userOnly }): Verdict | undefined => {
    let latest: EvaluationRecord | undefined;
    for (const r of records) {
      if (r.criterionId !== id || r.source === "agent_reported" || (userOnly && r.source !== "user")) continue;
      if (latest === undefined || r.createdAt >= latest.createdAt) latest = r;
    }
    return latest?.verdict;
  });
  if (verdicts.includes("fail")) return "failed";
  if (verdicts.includes(undefined) || verdicts.includes("unknown")) return "pending";
  return verdicts.includes("pass") ? "passed" : "pending";
}

/** Whether the task asks for the user's review, which keeps a finished run in AWAITING_REVIEW. */
export function needsUserReview(task: TaskSpec): boolean {
  return task.acceptance.some((c) => c.kind === "user_review");
}
