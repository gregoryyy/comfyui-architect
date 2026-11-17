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

/** The most of a task's text the approval quotes. */
export const APPROVAL_QUOTE_MAX_CHARS = 200;

/**
 * A task's text as the approval quotes it: data, never wording of the approval itself. Control
 * and bidirectional formatting characters are removed, so it can't break the line or reorder
 * what the user reads; at most APPROVAL_QUOTE_MAX_CHARS characters, then a mark that it was
 * cut; in JSON quotes, so it can't close its quote either.
 */
export function quotedForApproval(text: string): string {
  const cleaned = text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
  const chars = [...cleaned];
  const cut = chars.length > APPROVAL_QUOTE_MAX_CHARS;
  return `${JSON.stringify(chars.slice(0, APPROVAL_QUOTE_MAX_CHARS).join(""))}${cut ? ` (cut at ${APPROVAL_QUOTE_MAX_CHARS} of ${chars.length} characters)` : ""}`;
}

/** What a counted criterion asks, so the user approves the acceptance itself, not its name. */
function criterionLines(c: AcceptanceCriterion): string[] {
  const required = c.required ? "required" : "optional";
  switch (c.kind) {
    case "text_in_image":
      return [
        `  Criterion ${quotedForApproval(c.id)}, ${required}: the output must show the text ${quotedForApproval(c.text)} (quoted from the task as data), ` +
          `match ${c.match === "exact" ? "exact (the reading is the text)" : "contains (the reading includes the text)"}, ${c.caseSensitive ? "case-sensitive" : "case-insensitive"}`,
      ];
    case "protected_region_exact": {
      const tolerance = c.tolerance ?? 0;
      return [
        `  Criterion ${quotedForApproval(c.id)}, ${required}: the output keeps the source's pixels where the mask's red channel is 0; source ${quotedForApproval(c.sourceAssetId)}, mask ${quotedForApproval(c.maskAssetId)}`,
        tolerance === 0
          ? "  Tolerance 0: exact, every protected pixel must be the source's"
          : `  Tolerance ${tolerance}: not exact, a protected pixel may differ from the source's by up to ${tolerance} of 255 per channel and still pass`,
      ];
    }
    default:
      return [];
  }
}

/**
 * What the approval says about the task's visual evaluators: for each criterion one judges,
 * whether its verdict counts, and for each that counts what it asks (its text, match and case,
 * or its source, mask and tolerance) and whether it is required, so the user's approval is
 * the acceptance spec §13.2 asks for (GAPS A11). An optional evaluator not accepted stays
 * advisory.
 */
export function evaluatorApprovalLines(task: Pick<TaskSpec, "acceptance">, accepted: readonly AcceptedEvaluator[] | undefined): string[] {
  const lines: string[] = [];
  for (const c of task.acceptance) {
    const entry = evaluatorForKind(c.kind);
    if (!entry) continue;
    if (!entry.advisoryUnlessAccepted) {
      lines.push(`Evaluator: ${entry.id} ${entry.version} ${entry.does}; its ${entry.verdictName} for criterion ${c.id} counts toward acceptance`, ...criterionLines(c));
      continue;
    }
    const a = (accepted ?? []).find((x) => x.criterionId === c.id);
    if (a) {
      lines.push(
        `Evaluator: ${a.evaluatorId} ${a.evaluatorVersion} ${entry.does}; approving accepts its verdict for criterion ${c.id}, so the ${entry.verdictName} counts toward acceptance`,
        ...criterionLines(c),
      );
    } else {
      lines.push(`Evaluator: ${entry.id} ${entry.version} ${entry.does}; its verdict for criterion ${c.id} is advisory and doesn't count toward acceptance`);
    }
  }
  return lines;
}
