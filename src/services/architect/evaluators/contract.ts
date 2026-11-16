// The versioned contract of Architect's visual evaluators (spec §13.2; TODO 6.4.1; ARCH
// 2026-11-16, visual evaluators).
//
// An evaluator is an in-repository module registered in code (registry.ts); nothing is
// loaded at run time. It judges one task criterion of one run from the run's output files
// and the task's input files, through the facade only, and returns a verdict with its
// evidence. An observation that failed is `unknown`, never a fail or a pass (spec §7.3,
// #796). Whether the verdict counts toward acceptance isn't the evaluator's decision: an
// optional evaluator's verdict is advisory unless the action plan lists it as accepted for
// the criterion (GAPS A11).

import type { AcceptanceCriterion, AcceptedEvaluator, RenderInput, RunOutput, RunRecord, TaskSpec, Verdict } from "../schemas.js";
import type { UpstreamFacade } from "../upstream.js";

/** What a visual evaluator reaches through the facade. */
export type EvaluatorIo = Pick<UpstreamFacade, "readInputFile" | "decodePixels" | "imageForModel" | "ollamaHost" | "ollamaJson">;

/** One output file of the run, as the controller fetched it. */
export interface FetchedOutput {
  ref: RunOutput;
  /** Absent when the file couldn't be fetched; `reason` says why. */
  bytes?: Buffer;
  reason?: string;
}

/** Everything an evaluation of one criterion may read. */
export interface EvaluatorContext {
  run: RunRecord;
  task: TaskSpec;
  outputs: readonly FetchedOutput[];
  /** The input files the grant bound, with their sha256 (the `local_render` effect's `inputs`). */
  approvedInputs: readonly RenderInput[];
  io: EvaluatorIo;
  /** The Ollama tag the operator chose for OCR (ARCHITECT_OCR_MODEL), if any. */
  ocrModel?: string;
  /** How long a model request may take, in milliseconds; each evaluator has its default. */
  timeoutMs?: number;
}

/** What an evaluator established for one criterion (spec §13.2, `EvaluationResult`). */
export interface VisualVerdict {
  verdict: Verdict;
  explanation: string;
  measurement?: { value: number; unit: string };
  /** Asset references the verdict rests on: output files and task inputs. */
  evidence: string[];
}

/** Whether an evaluator can run here, decided before any lease is taken. */
export type EvaluatorAvailability = { available: true } | { available: false; reason: string };

/** A visual evaluator (spec §13.2: plugins with versioned contracts). */
export interface VisualEvaluator {
  readonly id: string;
  /** Changes whenever the verdict rules change; an accepted evaluator binds its version. */
  readonly version: string;
  readonly criterionKinds: readonly AcceptanceCriterion["kind"][];
  /**
   * Optional evaluators are advisory by default (spec §13.2); a deterministic one the recipe's
   * guarantee rests on, such as the protected-region comparison, counts as any check does.
   */
  readonly advisoryUnlessAccepted: boolean;
  /** Whether it needs the run's memory pool while it evaluates (a model on this machine). */
  readonly usesPool: boolean;
  availability(ctx: EvaluatorContext): Promise<EvaluatorAvailability>;
  evaluate(criterion: AcceptanceCriterion, ctx: EvaluatorContext): Promise<VisualVerdict>;
}

/** Whether the action plan accepts this evaluator, at this version, for the criterion. */
export function isAccepted(accepted: readonly AcceptedEvaluator[] | undefined, criterionId: string, evaluator: Pick<VisualEvaluator, "id" | "version">): boolean {
  return (accepted ?? []).some((a) => a.criterionId === criterionId && a.evaluatorId === evaluator.id && a.evaluatorVersion === evaluator.version);
}

/** The reference an output file is cited by in evidence: `<type>/<subfolder>/<file>`. */
export function outputRef(o: RunOutput): string {
  return `${o.type}/${o.subfolder ? `${o.subfolder}/` : ""}${o.filename}`;
}

/** An error's message, for an explanation. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Text from outside (a model's reading, a file name) for an explanation: printable and bounded. */
export function boundedText(text: string, max = 200): string {
  const printable = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return printable.length <= max ? printable : `${printable.slice(0, max)}…`;
}

/** Combine per-file verdicts: a fail decides, then an unknown; pass only when every file passed. */
export function combineVerdicts(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.length === 0) return "unknown";
  if (verdicts.includes("fail")) return "fail";
  if (verdicts.includes("unknown")) return "unknown";
  if (verdicts.every((v) => v === "not_applicable")) return "not_applicable";
  return "pass";
}
