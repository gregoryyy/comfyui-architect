// The visual evaluators by id and version, as data (TODO 6.4.1; ARCH 2026-11-16, visual
// evaluators). Planning and admission read this table: which evaluator a task may accept for
// a criterion, which version an action plan binds, and what the approval says about it. The
// evaluators themselves (registry.ts) read the files through the facade; this module imports
// no I/O, so validation and admission stay data in, data out.

import type { AcceptanceCriterion, AcceptedEvaluator, CheckResult, TaskSpec } from "../schemas.js";

/** What planning and admission know of an evaluator. */
export interface EvaluatorEntry {
  readonly id: string;
  readonly version: string;
  readonly criterionKinds: readonly AcceptanceCriterion["kind"][];
  /** Whether its verdict counts only when the action plan accepts it for the criterion. */
  readonly advisoryUnlessAccepted: boolean;
  /** How the approval text names what it does. */
  readonly does: string;
  /** How the approval text names its verdict. */
  readonly verdictName: string;
}

export const PROTECTED_REGION_EVALUATOR: EvaluatorEntry = {
  id: "architect.protected-region",
  version: "1",
  criterionKinds: ["protected_region_exact"],
  advisoryUnlessAccepted: false,
  does: "compares the output's pixels outside the mask with the source's",
  verdictName: "protected-region verdict",
};

export const OCR_GLM_EVALUATOR: EvaluatorEntry = {
  id: "architect.ocr-glm",
  version: "1",
  criterionKinds: ["text_in_image"],
  advisoryUnlessAccepted: true,
  does: "reads the text in the output with glm-ocr in Ollama, only when Ollama's host is loopback, so the image stays on this machine; an uncertain reading is unknown",
  verdictName: "OCR verdict",
};

export const EVALUATOR_CATALOG: readonly EvaluatorEntry[] = [PROTECTED_REGION_EVALUATOR, OCR_GLM_EVALUATOR];

/** The evaluator that judges a criterion kind by default, if any. */
export function evaluatorForKind(kind: AcceptanceCriterion["kind"]): EvaluatorEntry | undefined {
  return EVALUATOR_CATALOG.find((e) => e.criterionKinds.includes(kind));
}

/** The evaluator a criterion's `acceptEvaluator` names, when it exists and judges that kind. */
function acceptable(criterion: AcceptanceCriterion): EvaluatorEntry | undefined {
  if (criterion.kind !== "text_in_image" || criterion.acceptEvaluator === undefined) return undefined;
  const named = criterion.acceptEvaluator;
  return EVALUATOR_CATALOG.find((e) => e.id === named && e.criterionKinds.includes(criterion.kind));
}

/**
 * The evaluators the task accepts, for the `local_render` effect: each criterion whose
 * `acceptEvaluator` names an evaluator that judges it, with that evaluator's version.
 * Undefined when there are none, so the plan's hash stays what it was before this field.
 */
export function acceptedEvaluatorsFor(task: Pick<TaskSpec, "acceptance">): AcceptedEvaluator[] | undefined {
  const out: AcceptedEvaluator[] = [];
  for (const c of task.acceptance) {
    const e = acceptable(c);
    if (e?.advisoryUnlessAccepted) out.push({ criterionId: c.id, evaluatorId: e.id, evaluatorVersion: e.version });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Contract checks of the task's `acceptEvaluator` fields: one that names no evaluator of this
 * build, or one that doesn't judge the criterion's kind, fails hard, since the user would
 * otherwise approve an acceptance that nothing can give.
 */
export function acceptEvaluatorChecks(task: Pick<TaskSpec, "acceptance">): CheckResult[] {
  const out: CheckResult[] = [];
  for (const c of task.acceptance) {
    if (c.kind !== "text_in_image" || c.acceptEvaluator === undefined) continue;
    const e = acceptable(c);
    const known = EVALUATOR_CATALOG.map((x) => x.id).join(", ");
    out.push({
      id: `contract.acceptance.${c.id}.evaluator`,
      layer: "contract",
      verdict: e ? "pass" : "fail",
      hard: true,
      message: e
        ? `criterion ${c.id} accepts ${e.id} ${e.version}, whose verdict will count toward acceptance once the user approves the plan`
        : `criterion ${c.id} accepts ${JSON.stringify(c.acceptEvaluator)}, which isn't an evaluator for ${c.kind} criteria (evaluators: ${known})`,
      enforcedBy: "validator.contract",
    });
  }
  return out;
}

/**
 * What the approval says about the task's optional evaluators: an accepted one counts, and the
 * user's approval is that acceptance (GAPS A11); any other stays advisory.
 */
export function evaluatorApprovalLines(task: Pick<TaskSpec, "acceptance">, accepted: readonly AcceptedEvaluator[] | undefined): string[] {
  const lines: string[] = [];
  for (const c of task.acceptance) {
    const entry = evaluatorForKind(c.kind);
    if (!entry?.advisoryUnlessAccepted) continue;
    const a = (accepted ?? []).find((x) => x.criterionId === c.id);
    lines.push(
      a
        ? `Evaluator: ${a.evaluatorId} ${a.evaluatorVersion} ${entry.does}; approving accepts its verdict for criterion ${c.id}, so the ${entry.verdictName} counts toward acceptance`
        : `Evaluator: ${entry.id} ${entry.version} ${entry.does}; its verdict for criterion ${c.id} is advisory and doesn't count toward acceptance`,
    );
  }
  return lines;
}
