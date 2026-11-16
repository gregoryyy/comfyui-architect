// The registered visual evaluators and the step that runs them on a finished run (spec
// §13.2; TODO 6.3, 6.4; ARCH 2026-11-16, protected regions and visual evaluators).
//
// The controller calls `VisualEvaluation.evaluate` in EVALUATING, after it fetched the run's
// outputs. Each task criterion an evaluator judges gets one record per run, keyed by run,
// criterion and evaluator, so a restart finds what an earlier pass stored. An evaluator that
// needs the memory pool (OCR on this machine's Ollama) takes the run's pool lease for its
// duration, heartbeats it, and gives it back; when another run holds the pool it waits, and
// the controller tries again on its next pass, until the run's wall time is over and the
// verdict becomes `unknown`. An optional evaluator's record is advisory unless the action
// plan accepts it for the criterion (GAPS A11).

import type { z } from "zod";
import { evaluationId } from "../evaluation.js";
import type { AcceptanceCriterion, ActionPlan, EvaluationRecord, LocalRenderEffect, RunRecord, TaskSpec } from "../schemas.js";
import { type EvaluatorContext, type EvaluatorIo, type FetchedOutput, type VisualEvaluator, type VisualVerdict, boundedText, isAccepted, messageOf } from "./contract.js";
import { ocrGlmEvaluator } from "./ocr-glm.js";
import { protectedRegionEvaluator } from "./protected-region.js";

/** Every visual evaluator of this build. Nothing is loaded at run time. */
export const VISUAL_EVALUATORS: readonly VisualEvaluator[] = [protectedRegionEvaluator, ocrGlmEvaluator];

/** How often a held pool lease is extended while an evaluator runs; well inside its 60 s TTL. */
export const EVALUATION_HEARTBEAT_MS = 15_000;

/** The run's pool lease, as the controller lends it to the evaluation. */
export interface PoolLease {
  /** Take the lease, or extend it when the run holds it already. */
  take(): { held: true } | { held: false; reason: string };
  extend(): void;
  release(): void;
}

type EvaluationInput = z.input<typeof EvaluationRecord>;

export interface VisualEvaluationInput {
  run: RunRecord;
  task: TaskSpec;
  outputs: readonly FetchedOutput[];
  actionPlan: ActionPlan | undefined;
  /** Record ids already stored for the run; their criteria aren't evaluated again. */
  storedIds: ReadonlySet<string>;
  lease: PoolLease;
  /** Set when the run's wall time is over: a criterion waiting for the pool stops waiting. */
  waitOver?: string;
  at: Date;
}

export interface VisualEvaluationResult {
  /** New records, to be stored. */
  records: EvaluationInput[];
  /** Criteria a visual evaluator answers, whether stored now or before. */
  criteria: Set<string>;
  /** Criteria waiting for the memory pool, with who holds it. */
  waiting: { criterionId: string; reason: string }[];
}

export interface VisualEvaluationDeps {
  io: EvaluatorIo;
  /** The OCR tag the operator chose (ARCHITECT_OCR_MODEL), read at each evaluation. */
  ocrModel?: () => string | undefined;
  /** How long a model request may take, in milliseconds. */
  timeoutMs?: number;
  heartbeatMs?: number;
  evaluators?: readonly VisualEvaluator[];
}

/** Runs the visual evaluators on one run's outputs. */
export class VisualEvaluation {
  private readonly evaluators: readonly VisualEvaluator[];

  constructor(private readonly deps: VisualEvaluationDeps) {
    this.evaluators = deps.evaluators ?? VISUAL_EVALUATORS;
  }

  /** The evaluator registered for a criterion's kind, if any. */
  evaluatorFor(criterion: AcceptanceCriterion): VisualEvaluator | undefined {
    return this.evaluators.find((e) => e.criterionKinds.includes(criterion.kind));
  }

  async evaluate(input: VisualEvaluationInput): Promise<VisualEvaluationResult> {
    const { run, task, at } = input;
    const render = input.actionPlan?.effects.find((e): e is LocalRenderEffect => e.kind === "local_render");
    const ocrModel = this.deps.ocrModel?.();
    const ctx: EvaluatorContext = {
      run,
      task,
      outputs: input.outputs,
      approvedInputs: render?.inputs ?? [],
      io: this.deps.io,
      ...(ocrModel !== undefined ? { ocrModel } : {}),
      ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
    };
    const result: VisualEvaluationResult = { records: [], criteria: new Set(), waiting: [] };
    const record = (criterion: AcceptanceCriterion, evaluator: VisualEvaluator, v: VisualVerdict): EvaluationInput => ({
      schemaVersion: 1,
      id: evaluationId(run.id, criterion.id, evaluator.id),
      runId: run.id,
      criterionId: criterion.id,
      evaluatorId: evaluator.id,
      evaluatorVersion: evaluator.version,
      verdict: v.verdict,
      source: "automatic",
      advisory: evaluator.advisoryUnlessAccepted && !isAccepted(render?.acceptedEvaluators, criterion.id, evaluator),
      explanation: boundedText(v.explanation, 4000) || `${evaluator.id} gave no explanation`,
      evidence: v.evidence,
      ...(v.measurement ? { measurement: v.measurement } : {}),
      createdAt: at.toISOString(),
    });

    let leased = false;
    try {
      for (const criterion of task.acceptance) {
        const evaluator = this.evaluatorFor(criterion);
        if (evaluator === undefined) continue;
        result.criteria.add(criterion.id);
        if (input.storedIds.has(evaluationId(run.id, criterion.id, evaluator.id))) continue;

        let available: Awaited<ReturnType<VisualEvaluator["availability"]>>;
        try {
          available = await evaluator.availability(ctx);
        } catch (err) {
          available = { available: false, reason: `${evaluator.id} couldn't tell whether it can run: ${boundedText(messageOf(err), 300)}` };
        }
        if (!available.available) {
          result.records.push(record(criterion, evaluator, { verdict: "unknown", explanation: available.reason, evidence: [] }));
          continue;
        }
        if (evaluator.usesPool && !leased) {
          const lease = input.lease.take();
          if (!lease.held) {
            if (input.waitOver === undefined) {
              result.waiting.push({ criterionId: criterion.id, reason: lease.reason });
            } else {
              result.records.push(
                record(criterion, evaluator, {
                  verdict: "unknown",
                  explanation: `${evaluator.id} needs the memory pool, which stayed busy (${lease.reason}) until ${input.waitOver}`,
                  evidence: [],
                }),
              );
            }
            continue;
          }
          leased = true;
        }
        result.records.push(record(criterion, evaluator, await this.run(evaluator, criterion, ctx, evaluator.usesPool ? input.lease : undefined)));
      }
    } finally {
      if (leased) input.lease.release();
    }
    return result;
  }

  /** One evaluation, its lease extended while it runs; a throw is an observation that failed. */
  private async run(evaluator: VisualEvaluator, criterion: AcceptanceCriterion, ctx: EvaluatorContext, lease: PoolLease | undefined): Promise<VisualVerdict> {
    const timer = lease ? setInterval(() => lease.extend(), this.deps.heartbeatMs ?? EVALUATION_HEARTBEAT_MS) : undefined;
    timer?.unref();
    try {
      return await evaluator.evaluate(criterion, ctx);
    } catch (err) {
      return { verdict: "unknown", explanation: `${evaluator.id} failed: ${boundedText(messageOf(err), 300)}`, evidence: [] };
    } finally {
      if (timer) clearInterval(timer);
    }
  }
}
