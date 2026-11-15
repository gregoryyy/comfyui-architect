import { describe, expect, it } from "vitest";
import {
  NO_EVALUATOR_CRITERION,
  OUTPUT_EVALUATOR_ID,
  type ProbedOutput,
  acceptanceFrom,
  evaluateOutputs,
  evaluationId,
  needsUserReview,
} from "../../services/architect/evaluation.js";
import { EvaluationRecord, RunRecord, TaskSpec } from "../../services/architect/schemas.js";
import { PROMPT_ID, T, T1, run as runFixture, task as taskFixture } from "./fixtures/execution-records.js";

const AT = new Date("2026-11-15T12:05:00.000Z");
const evaluating = RunRecord.parse({ ...runFixture, state: "EVALUATING", promptId: PROMPT_ID });

function task(overrides: Record<string, unknown> = {}): TaskSpec {
  return TaskSpec.parse({ ...taskFixture, ...overrides });
}

/** A probed file; by default its image decoded at the size its header states. */
function file(name: string, probe: ProbedOutput["probe"], decode?: ProbedOutput["decode"]): ProbedOutput {
  const decoded: ProbedOutput["decode"] = probe.readable
    ? { state: "decoded", width: probe.width, height: probe.height }
    : { state: "not_attempted", reason: "the header couldn't be read" };
  return { ref: { node: "9", filename: name, subfolder: "", type: "output" }, probe, decode: decode ?? decoded };
}
const png1024 = (name = "a.png") => file(name, { readable: true, format: "png", width: 1024, height: 1024 });

function verdicts(records: ReturnType<typeof evaluateOutputs>): Record<string, string> {
  return Object.fromEntries(records.map((r) => [r.criterionId, r.verdict]));
}

function stored(records: ReturnType<typeof evaluateOutputs>): EvaluationRecord[] {
  return records.map((r) => EvaluationRecord.parse(r));
}

describe("evaluateOutputs, image tasks", () => {
  it("passes every built-in check when count, format and size match", () => {
    const records = evaluateOutputs({ run: evaluating, task: task(), files: [png1024()], at: AT });
    expect(verdicts(records)).toEqual({
      run_completion: "pass",
      output_count: "pass",
      output_readable: "pass",
      output_format: "pass",
      output_dimensions: "pass",
    });
    for (const r of stored(records)) {
      expect(r).toMatchObject({ evaluatorId: OUTPUT_EVALUATOR_ID, evaluatorVersion: "2", source: "automatic", runId: evaluating.id });
      expect(r.id).toBe(evaluationId(evaluating.id, r.criterionId));
    }
    expect(records.find((r) => r.criterionId === "output_count")?.measurement).toEqual({ value: 1, unit: "files" });
  });

  it("fails count, format and dimensions on a mismatch", () => {
    const records = evaluateOutputs({
      run: evaluating,
      task: task(),
      files: [
        file("a.jpg", { readable: true, format: "jpeg", width: 1024, height: 1024 }),
        file("b.png", { readable: true, format: "png", width: 512, height: 1024 }),
      ],
      at: AT,
    });
    expect(verdicts(records)).toMatchObject({ output_count: "fail", output_format: "fail", output_dimensions: "fail" });
  });

  it("fails the count when nothing was written, and checks no format", () => {
    const v = verdicts(evaluateOutputs({ run: evaluating, task: task(), files: [], at: AT }));
    expect(v).toMatchObject({ output_count: "fail", output_format: "not_applicable", output_dimensions: "not_applicable" });
  });

  it("never passes format or dimensions of a file whose header couldn't be read", () => {
    const v = verdicts(
      evaluateOutputs({ run: evaluating, task: task(), files: [file("a.png", { readable: false, reason: "empty file" })], at: AT }),
    );
    expect(v).toMatchObject({ output_count: "pass", output_readable: "fail", output_format: "unknown", output_dimensions: "unknown" });
  });

  it("calls a file that couldn't be fetched unknown, not unreadable", () => {
    const v = verdicts(
      evaluateOutputs({
        run: evaluating,
        task: task(),
        files: [png1024("a.png"), file("b.png", { readable: false, fetched: false, reason: "connection reset" })],
        unparsedOutputs: 0,
        at: AT,
      }),
    );
    expect(v).toMatchObject({ output_readable: "unknown", output_format: "unknown", output_dimensions: "unknown" });
  });

  it("fails readability for an image whose header parses but whose data doesn't decode", () => {
    const header = { readable: true, format: "png", width: 1024, height: 1024 } as const;
    const records = evaluateOutputs({
      run: evaluating,
      task: task(),
      files: [file("a.png", header, { state: "failed", reason: "vipspng: libpng read error" })],
      at: AT,
    });
    // Format and size come from the header; readability needs the decode.
    expect(verdicts(records)).toMatchObject({ output_readable: "fail", output_format: "pass", output_dimensions: "pass" });
    expect(records.find((r) => r.criterionId === "output_readable")?.explanation).toMatch(/doesn't decode: vipspng/);
    expect(acceptanceFrom(task(), stored(records))).toBe("failed");
  });

  it("fails readability when the decoded size isn't the header's", () => {
    const header = { readable: true, format: "png", width: 1024, height: 1024 } as const;
    const records = evaluateOutputs({
      run: evaluating,
      task: task(),
      files: [file("a.png", header, { state: "decoded", width: 512, height: 512 })],
      at: AT,
    });
    expect(verdicts(records).output_readable).toBe("fail");
    expect(records.find((r) => r.criterionId === "output_readable")?.explanation).toMatch(/1024×1024.*512×512/);
  });

  it("calls readability unknown, never passed, when no decode happened", () => {
    const header = { readable: true, format: "png", width: 1024, height: 1024 } as const;
    const records = evaluateOutputs({
      run: evaluating,
      task: task(),
      files: [file("a.png", header, { state: "not_attempted", reason: "sharp couldn't be loaded" })],
      at: AT,
    });
    expect(verdicts(records).output_readable).toBe("unknown");
    expect(acceptanceFrom(task(), stored(records))).toBe("pending");
  });

  it("makes the count unknown when history entries couldn't be read", () => {
    const v = verdicts(evaluateOutputs({ run: evaluating, task: task(), files: [png1024()], unparsedOutputs: 1, at: AT }));
    expect(v).toMatchObject({ output_count: "unknown", output_readable: "unknown" });
  });

  it("doesn't call completion passed before the run reached evaluation", () => {
    const queued = RunRecord.parse({ ...evaluating, state: "QUEUED" });
    expect(verdicts(evaluateOutputs({ run: queued, task: task(), files: [png1024()], at: AT })).run_completion).toBe("unknown");
  });

  it("checks the task's dimensions criteria by their id, leaves protected regions unknown and user review alone", () => {
    const t = task({
      acceptance: [
        { id: "wide", kind: "dimensions", required: true, expected: [2048, 1024] },
        { id: "square", kind: "dimensions", required: false, expected: [1024, 1024] },
        {
          id: "keep-face",
          kind: "protected_region_exact",
          required: true,
          sourceAssetId: "asset-1",
          maskAssetId: "asset-2",
          coordinateSpace: "source_pixels",
        },
        { id: "looks-right", kind: "user_review", required: true, rubric: "Is it a red bicycle?" },
      ],
    });
    const records = evaluateOutputs({ run: evaluating, task: t, files: [png1024()], at: AT });
    const v = verdicts(records);
    expect(v).toMatchObject({ wide: "fail", square: "pass", "keep-face": "unknown" });
    expect(v["looks-right"]).toBeUndefined();
    expect(needsUserReview(t)).toBe(true);
    expect(needsUserReview(task())).toBe(false);
  });
});

describe("evaluateOutputs, other kinds", () => {
  it("returns one not_applicable record instead of throwing", () => {
    // TaskSpec has only the image part so far; a stored video task arrives untyped.
    const video: TaskSpec = JSON.parse(JSON.stringify({ ...task(), media: { kind: "video" } }));
    const records = evaluateOutputs({ run: evaluating, task: video, files: [], at: AT });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ criterionId: NO_EVALUATOR_CRITERION, verdict: "not_applicable" });
    expect(records[0].explanation).toMatch(/video/);
    expect(acceptanceFrom(video, stored(records))).toBe("pending");
  });
});

describe("acceptanceFrom", () => {
  const pass = () => stored(evaluateOutputs({ run: evaluating, task: task(), files: [png1024()], at: AT }));

  it("passes when every built-in criterion passed", () => {
    expect(acceptanceFrom(task(), pass())).toBe("passed");
  });

  it("fails on a required failure and stays pending on an unknown", () => {
    const failed = stored(evaluateOutputs({ run: evaluating, task: task(), files: [], at: AT }));
    expect(acceptanceFrom(task(), failed)).toBe("failed");
    const unknown = stored(
      evaluateOutputs({ run: evaluating, task: task(), files: [file("a.png", { readable: false, fetched: false, reason: "x" })], at: AT }),
    );
    expect(acceptanceFrom(task(), unknown)).toBe("pending");
  });

  it("stays pending without any records", () => {
    expect(acceptanceFrom(task(), [])).toBe("pending");
  });

  it("ignores an optional criterion's failure", () => {
    const t = task({ acceptance: [{ id: "wide", kind: "dimensions", required: false, expected: [2048, 1024] }] });
    expect(acceptanceFrom(t, stored(evaluateOutputs({ run: evaluating, task: t, files: [png1024()], at: AT })))).toBe("passed");
  });

  it("counts only the user's verdict on a review criterion, never the agent's", () => {
    const t = task({ acceptance: [{ id: "looks-right", kind: "user_review", required: true, rubric: "ok?" }] });
    const auto = stored(evaluateOutputs({ run: evaluating, task: t, files: [png1024()], at: AT }));
    expect(acceptanceFrom(t, auto)).toBe("pending");
    const verdict = (source: "user" | "agent_reported", v: "pass" | "fail", createdAt: string) =>
      EvaluationRecord.parse({
        schemaVersion: 1,
        id: `eval-${source.replace("_", "")}-${v}-${createdAt.slice(11, 19).replaceAll(":", "")}`,
        runId: evaluating.id,
        criterionId: "looks-right",
        evaluatorId: "architect.user-review",
        evaluatorVersion: "1",
        verdict: v,
        source,
        ...(source === "user" ? { channel: "terminal" as const } : {}),
        explanation: "verdict",
        createdAt,
      });
    expect(acceptanceFrom(t, [...auto, verdict("agent_reported", "pass", T1)])).toBe("pending");
    expect(acceptanceFrom(t, [...auto, verdict("user", "pass", T1)])).toBe("passed");
    // The latest verdict decides.
    expect(acceptanceFrom(t, [...auto, verdict("user", "pass", T), verdict("user", "fail", T1)])).toBe("failed");
  });
});
