// Bounded repair and the smoke stage (spec §13.1, §13.4; TODO 6.1, 6.2; ARCH 2026-11-16,
// milestone 6: repair policy, stages and repair scope, attempts under one grant).
//
// Data in, data out: the failure classification, the transformation allowlist, applying a
// chain of transformations to an API graph with its node-level diff, the stages and repair
// scope a plan asks approval for, and the decision what follows a finished attempt. The
// controller reads the records and writes the result; the store's admission transaction
// checks the attempt again before it exists.
//
// ComfyUI's error text is data (spec §14.4): the classification matches it against the fixed
// patterns below and does nothing else with it. Nothing outside the allowlist is a repair: no
// custom code, dependency change, other model file or family, precision change, relaxed
// constraint or paid fallback (spec §13.4, §4.3).

import { graphFingerprint } from "./compile.js";
import { z } from "zod";
import { canonicalJson } from "./hash.js";
import type {
  Acceptance,
  ApiGraph,
  FailureClass,
  GraphNodeChange,
  GraphRevision,
  RenderStage,
  RunError,
  RunEvent,
  RunLimits,
  RunState,
  TaskSpec,
  TransformationId,
  TransformationRef,
  TransformationStep,
} from "./schemas.js";

/** The task budget defaults of spec §13.4: three previews, one final, two repair rounds. */
export const DEFAULT_MAX_PREVIEW_RUNS = 3;
export const DEFAULT_MAX_FINAL_RUNS = 1;
export const DEFAULT_MAX_REPAIR_ROUNDS = 2;

/** The smoke stage's transformation (ARCH 2026-11-16, milestone 6, stages). */
export const SMOKE_TRANSFORMATION: TransformationRef = { id: "preview.min_steps", version: 1 };

/** Sampler nodes whose `steps` the smoke stage lowers. */
const SAMPLER_CLASSES: readonly string[] = ["KSampler", "Flux2Scheduler"];
/** The tiling a tiled VAE node gets when it replaces a plain one, ComfyUI's own defaults. */
export const TILED_VAE_INPUTS = { tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } as const;
/** `vae.smaller_tiles` never goes below this tile size. */
export const MIN_TILE_SIZE = 256;
/** ComfyUI's step for `tile_size`: 32 on VAEDecodeTiled, 64 on VAEEncodeTiled. */
const TILE_STEP: Readonly<Record<string, number>> = { VAEDecodeTiled: 32, VAEEncodeTiled: 64 };
/** Node inputs that hold a sampler's seed. */
const SEED_INPUTS: readonly string[] = ["seed", "noise_seed"];
/**
 * Criterion kinds whose outcome another seed can change, so a failure of one is a `quality`
 * failure `seed.next` answers. `text_in_image` comes with the OCR evaluator (TODO 6.4).
 */
export const SEED_CHANGEABLE_CRITERIA: readonly string[] = ["text_in_image"];

/** A transformation that can't be applied as asked: a bug in the caller or a changed graph. */
export class RepairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepairError";
  }
}

interface TransformationDef {
  id: TransformationId;
  version: number;
  /** The failure classes it answers; empty for the smoke stage's. */
  classes: readonly FailureClass[];
  /** Whether it targets one node: the failing one. */
  needsNode: boolean;
  /** What the approval text says it does. */
  summary: string;
  applies(graph: ApiGraph, node?: string): boolean;
  apply(graph: ApiGraph, node?: string): ApiGraph;
}

function literalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function samplersAboveOneStep(graph: ApiGraph): string[] {
  return Object.entries(graph)
    .filter(([, n]) => SAMPLER_CLASSES.includes(n.class_type) && (literalNumber(n.inputs.steps) ?? 0) > 1)
    .map(([id]) => id);
}

function seedNodes(graph: ApiGraph): string[] {
  return Object.entries(graph)
    .filter(([, n]) => SEED_INPUTS.some((k) => literalNumber(n.inputs[k]) !== undefined))
    .map(([id]) => id);
}

/** A plain VAE node replaced by its tiled form, with the same id and links. */
function tiled(graph: ApiGraph, node: string | undefined, from: string, to: string, imageInput: string): ApiGraph {
  const n = node === undefined ? undefined : graph[node];
  if (!n || n.class_type !== from || node === undefined) throw new RepairError(`node ${node ?? "(none)"} isn't a ${from}`);
  const out = structuredClone(graph);
  out[node] = {
    class_type: to,
    inputs: { [imageInput]: n.inputs[imageInput] ?? null, vae: n.inputs.vae ?? null, ...TILED_VAE_INPUTS },
    ...(n._meta ? { _meta: structuredClone(n._meta) } : {}),
  };
  return out;
}

function smallerTileOf(graph: ApiGraph, node: string | undefined): number | undefined {
  const n = node === undefined ? undefined : graph[node];
  if (!n || !(n.class_type in TILE_STEP)) return undefined;
  const size = literalNumber(n.inputs.tile_size);
  if (size === undefined || size <= MIN_TILE_SIZE) return undefined;
  const step = TILE_STEP[n.class_type];
  return Math.max(MIN_TILE_SIZE, Math.floor(size / 2 / step) * step);
}

/** The allowlist (ARCH 2026-11-16, repair policy), each transformation versioned. */
const DEFS: Readonly<Record<TransformationId, TransformationDef>> = {
  "preview.min_steps": {
    id: "preview.min_steps",
    version: 1,
    classes: [],
    needsNode: false,
    summary: "sampler steps set to 1 on KSampler and Flux2Scheduler, SaveImage replaced by PreviewImage so nothing lands in the output folder; full size",
    applies: (graph) => samplersAboveOneStep(graph).length > 0,
    apply: (graph) => {
      const out = structuredClone(graph);
      for (const id of samplersAboveOneStep(graph)) out[id].inputs.steps = 1;
      for (const [id, n] of Object.entries(out)) {
        // PreviewImage takes the images only; it writes to ComfyUI's temp folder.
        if (n.class_type === "SaveImage") out[id] = { class_type: "PreviewImage", inputs: { images: n.inputs.images ?? null }, ...(n._meta ? { _meta: n._meta } : {}) };
      }
      return out;
    },
  },
  "vae.tiled_decode": {
    id: "vae.tiled_decode",
    version: 1,
    classes: ["memory", "unsupported_backend"],
    needsNode: true,
    summary: `the failing VAEDecode becomes VAEDecodeTiled (tiles ${TILED_VAE_INPUTS.tile_size}, overlap ${TILED_VAE_INPUTS.overlap}, temporal ${TILED_VAE_INPUTS.temporal_size} and ${TILED_VAE_INPUTS.temporal_overlap})`,
    applies: (graph, node) => node !== undefined && graph[node]?.class_type === "VAEDecode",
    apply: (graph, node) => tiled(graph, node, "VAEDecode", "VAEDecodeTiled", "samples"),
  },
  "vae.tiled_encode": {
    id: "vae.tiled_encode",
    version: 1,
    classes: ["memory", "unsupported_backend"],
    needsNode: true,
    summary: `the failing VAEEncode becomes VAEEncodeTiled (tiles ${TILED_VAE_INPUTS.tile_size}, overlap ${TILED_VAE_INPUTS.overlap}, temporal ${TILED_VAE_INPUTS.temporal_size} and ${TILED_VAE_INPUTS.temporal_overlap})`,
    applies: (graph, node) => node !== undefined && graph[node]?.class_type === "VAEEncode",
    apply: (graph, node) => tiled(graph, node, "VAEEncode", "VAEEncodeTiled", "pixels"),
  },
  "vae.smaller_tiles": {
    id: "vae.smaller_tiles",
    version: 1,
    classes: ["memory", "unsupported_backend"],
    needsNode: true,
    summary: `the failing tiled VAE node's tiles halved, at least ${MIN_TILE_SIZE}`,
    applies: (graph, node) => smallerTileOf(graph, node) !== undefined,
    apply: (graph, node) => {
      const size = smallerTileOf(graph, node);
      if (size === undefined || node === undefined) throw new RepairError(`node ${node ?? "(none)"} has no tiles to halve`);
      const out = structuredClone(graph);
      out[node].inputs.tile_size = size;
      return out;
    },
  },
  "retry.unchanged": {
    id: "retry.unchanged",
    version: 1,
    classes: ["transport"],
    needsNode: false,
    summary: "the same graph again, only after a transport failure before ComfyUI accepted the prompt",
    applies: () => true,
    apply: (graph) => structuredClone(graph),
  },
  "seed.next": {
    id: "seed.next",
    version: 1,
    classes: ["quality"],
    needsNode: false,
    summary: "every literal seed plus one, for a failed criterion another seed can change",
    applies: (graph) => seedNodes(graph).length > 0,
    apply: (graph) => {
      const out = structuredClone(graph);
      for (const id of seedNodes(graph)) {
        for (const k of SEED_INPUTS) {
          const v = literalNumber(out[id].inputs[k]);
          // ComfyUI's seeds are unsigned 64-bit; past what a JSON number holds exactly, wrap.
          if (v !== undefined) out[id].inputs[k] = v >= Number.MAX_SAFE_INTEGER ? 0 : v + 1;
        }
      }
      return out;
    },
  },
};

/** The order in which a failure class tries its transformations. */
const ALLOWLIST: Readonly<Record<FailureClass, readonly TransformationId[]>> = {
  memory: ["vae.tiled_decode", "vae.tiled_encode", "vae.smaller_tiles"],
  unsupported_backend: ["vae.tiled_decode", "vae.tiled_encode", "vae.smaller_tiles"],
  transport: ["retry.unchanged"],
  quality: ["seed.next"],
  schema_wiring: [],
  missing_dependency: [],
  policy: [],
  unclassified: [],
};

/** Classes the controller never repairs: their cause is outside what a transformation may change. */
const STOP_CLASSES: readonly FailureClass[] = ["schema_wiring", "missing_dependency", "policy", "unclassified"];

/** What the approval text says a transformation does. */
export function describeTransformation(ref: TransformationRef): string {
  const def = DEFS[ref.id];
  return `${ref.id} ${ref.version}: ${def.summary}`;
}

/** Whether `ref` names a transformation this build has, at that version. */
export function knownTransformation(ref: TransformationRef): boolean {
  return DEFS[ref.id].version === ref.version;
}

/** Apply one step; refused when its version isn't this build's or it doesn't apply to the graph. */
export function applyStep(graph: ApiGraph, step: Pick<TransformationStep, "id" | "version" | "node">): ApiGraph {
  const def = DEFS[step.id];
  if (def.version !== step.version) throw new RepairError(`${step.id} ${step.version} isn't known; this build has version ${def.version}`);
  if (def.needsNode && step.node === undefined) throw new RepairError(`${step.id} needs the node it targets`);
  if (!def.needsNode && step.node !== undefined) throw new RepairError(`${step.id} targets the whole graph, not node ${step.node}`);
  if (!def.applies(graph, step.node)) throw new RepairError(`${step.id} doesn't apply to ${step.node === undefined ? "this graph" : `node ${step.node}`}`);
  return def.apply(graph, step.node);
}

/** The approved graph with `steps` applied in order (ARCH 2026-11-16, attempts). */
export function applySteps(graph: ApiGraph, steps: readonly Pick<TransformationStep, "id" | "version" | "node">[]): ApiGraph {
  return steps.reduce((g, s) => applyStep(g, s), graph);
}

/** The node-level diff of `revised` against `base`: classes and inputs, never `_meta`. */
export function diffGraphs(base: ApiGraph, revised: ApiGraph): GraphNodeChange[] {
  const ids = [...new Set([...Object.keys(base), ...Object.keys(revised)])].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const out: GraphNodeChange[] = [];
  for (const node of ids) {
    const a = base[node];
    const b = revised[node];
    if (!b) {
      out.push({ node, op: "removed", classType: { from: a.class_type }, inputs: Object.entries(a.inputs).map(([name, from]) => ({ name, from })) });
      continue;
    }
    if (!a) {
      out.push({ node, op: "added", classType: { to: b.class_type }, inputs: Object.entries(b.inputs).map(([name, to]) => ({ name, to })) });
      continue;
    }
    const names = [...new Set([...Object.keys(a.inputs), ...Object.keys(b.inputs)])].sort();
    const inputs = names
      .filter((name) => (name in a.inputs) !== (name in b.inputs) || canonicalJson(a.inputs[name]) !== canonicalJson(b.inputs[name]))
      .map((name) => ({ name, ...(name in a.inputs ? { from: a.inputs[name] } : {}), ...(name in b.inputs ? { to: b.inputs[name] } : {}) }));
    const classChanged = a.class_type !== b.class_type;
    if (classChanged || inputs.length > 0) {
      out.push({ node, op: "changed", ...(classChanged ? { classType: { from: a.class_type, to: b.class_type } } : {}), inputs });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Planning: the stages and repair scope a plan asks approval for

/** What a plan with more than one possible render binds; undefined for a plan with one. */
export interface PlannedAttempts {
  stages: ({ stage: "smoke"; transformation: TransformationRef } | { stage: "final" })[];
  repair?: { transformations: TransformationRef[] };
  limits: { maxPreviewRuns: number; maxFinalRuns: number; maxRepairRounds: number };
}

/**
 * The stages and repair scope for a compiled graph and its task (ARCH 2026-11-16, milestone
 * 6, stages). A smoke stage comes first when the task allows previews and it lowers some step
 * count. The repair scope lists the transformations that could apply to this graph. A plan
 * where nothing could render a second time (no smoke stage and one final) gets neither, so
 * it binds what a plan made before stages existed binds. Throws on a task allowing no final
 * render: there would be nothing to approve.
 */
export function planAttempts(graph: ApiGraph, task: Pick<TaskSpec, "budgets" | "acceptance">): PlannedAttempts | undefined {
  const previews = task.budgets.maxPreviewRuns ?? DEFAULT_MAX_PREVIEW_RUNS;
  const finals = task.budgets.maxFinalRuns ?? DEFAULT_MAX_FINAL_RUNS;
  const rounds = task.budgets.maxRepairRounds ?? DEFAULT_MAX_REPAIR_ROUNDS;
  if (finals < 1) throw new RepairError("the task's budgets allow no final render (maxFinalRuns 0)");
  const smoke = previews > 0 && DEFS["preview.min_steps"].applies(graph);
  const classes = Object.values(graph).map((n) => n.class_type);
  const repairs: TransformationRef[] = [];
  if (rounds > 0) {
    if (classes.includes("VAEDecode")) repairs.push({ id: "vae.tiled_decode", version: 1 });
    if (classes.includes("VAEEncode")) repairs.push({ id: "vae.tiled_encode", version: 1 });
    if (classes.some((c) => c === "VAEDecode" || c === "VAEEncode" || c in TILE_STEP)) repairs.push({ id: "vae.smaller_tiles", version: 1 });
    repairs.push({ id: "retry.unchanged", version: 1 });
    // A changed seed is a second final, so only when the budget has one.
    if (finals > 1 && seedNodes(graph).length > 0 && task.acceptance.some((c) => SEED_CHANGEABLE_CRITERIA.includes(c.kind))) {
      repairs.push({ id: "seed.next", version: 1 });
    }
  }
  if (!smoke && (finals < 2 || repairs.length === 0)) return undefined;
  return {
    stages: smoke ? [{ stage: "smoke", transformation: SMOKE_TRANSFORMATION }, { stage: "final" }] : [{ stage: "final" }],
    ...(repairs.length > 0 ? { repair: { transformations: repairs } } : {}),
    limits: { maxPreviewRuns: smoke ? previews : 0, maxFinalRuns: finals, maxRepairRounds: repairs.length > 0 ? rounds : 0 },
  };
}

// ---------------------------------------------------------------------------------------
// Classification

/** A failed attempt as the classification reads it. */
export interface ClassifiedFailure {
  failureClass: FailureClass;
  /** The node ComfyUI named, when it named one. */
  node?: string;
  nodeType?: string;
  /** The pattern that decided, for the record. */
  matched: string;
}

const CODE_CLASSES: Readonly<Partial<Record<RunError["code"], FailureClass>>> = {
  APPROVAL_REQUIRED: "policy",
  APPROVAL_INVALIDATED: "policy",
  BUDGET_EXCEEDED: "policy",
  RATE_LIMITED: "policy",
  DEPENDENCY_UNAVAILABLE: "missing_dependency",
  MISSING_INPUT: "missing_dependency",
  STALE_ENVIRONMENT: "missing_dependency",
  GRAPH_CONFLICT: "schema_wiring",
  PROVIDER_UNAVAILABLE: "transport",
};

/** Fixed patterns over ComfyUI's text, in the order they are tried; the first match decides. */
const TEXT_PATTERNS: readonly { failureClass: FailureClass; pattern: RegExp; name: string }[] = [
  { failureClass: "memory", name: "out of memory", pattern: /OutOfMemoryError|out of memory|\bOOM\b|failed to allocate|Allocation on device|Invalid buffer size|insufficient memory/i },
  {
    failureClass: "unsupported_backend",
    name: "unsupported on this backend",
    pattern: /NotImplementedError|not implemented for|not (?:currently )?supported (?:on|by) the MPS|MPS backend does not support|NDArray > 2\*\*32|larger than INT_MAX|unsupported (?:dtype|scalar type)|does not support (?:bfloat16|float8|fp8)/i,
  },
  {
    failureClass: "missing_dependency",
    name: "missing node or file",
    pattern: /not in list|does not exist|node is missing|node type .{0,80} not found|FileNotFoundError|No such file or directory/i,
  },
  {
    failureClass: "schema_wiring",
    name: "graph validation",
    pattern: /Required input is missing|Return type mismatch|failed validation|Failed to convert an input value|smaller than min|bigger than max|invalid prompt|Exception when validating/i,
  },
];

/** Network failures before ComfyUI answered, for an error that isn't ComfyUI's own report. */
const TRANSPORT_PATTERN = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|socket hang up|fetch failed|network error/i;

/** The classifier reads at most this much of the error text; ComfyUI's tracebacks can be long. */
const MAX_CLASSIFIED_TEXT = 4000;

/**
 * Classify a failed attempt from its stored error and ComfyUI's execution error (ARCH
 * 2026-11-16, repair policy). Codes the service itself writes decide first; then fixed
 * patterns over the exception type and message, then over the error's message. What
 * nothing matches is `unclassified`, which stops the repair.
 */
export function classifyFailure(error: RunError | undefined): ClassifiedFailure {
  if (!error) return { failureClass: "unclassified", matched: "no error recorded" };
  const where = {
    ...(error.detail?.nodeId !== undefined ? { node: error.detail.nodeId } : {}),
    ...(error.detail?.nodeType !== undefined ? { nodeType: error.detail.nodeType } : {}),
  };
  const byCode = CODE_CLASSES[error.code];
  if (byCode) return { failureClass: byCode, ...where, matched: `code ${error.code}` };
  const text = [error.detail?.exceptionType, error.detail?.exceptionMessage, error.message].filter((t) => t !== undefined).join("\n").slice(0, MAX_CLASSIFIED_TEXT);
  if (error.code === "EXECUTION_FAILED" || error.code === "COMFYUI_ERROR") {
    for (const p of TEXT_PATTERNS) if (p.pattern.test(text)) return { failureClass: p.failureClass, ...where, matched: p.name };
  }
  // An execution error ComfyUI reported came from a node, never from the connection to it.
  if (error.detail === undefined && TRANSPORT_PATTERN.test(text)) return { failureClass: "transport", ...where, matched: "network failure" };
  return { failureClass: "unclassified", ...where, matched: "no pattern matched" };
}

// ---------------------------------------------------------------------------------------
// The decision after an attempt

/** One attempt of a chain as the decision reads it, in index order. */
export interface AttemptView {
  runId: string;
  index: number;
  stage: RenderStage;
  repairRound: number;
  state: RunState;
  acceptance: Acceptance;
  /** The steps of the revision it rendered; empty for the approved graph. */
  steps: readonly TransformationStep[];
  error?: RunError;
  /** Whether a submission was ever claimed for it: a prompt with its ID may have reached ComfyUI. */
  submitted: boolean;
  /** For a final whose acceptance failed: the failing criteria, and whether a seed can change them. */
  qualityFailure?: { criteria: string[]; seedChangeable: boolean };
}

export interface ChainInput {
  attempts: readonly AttemptView[];
  /** The render effect's repair scope, as the grant bound it. */
  repair: readonly TransformationRef[];
  limits: RunLimits;
  deadlinePassed: boolean;
  cancelRequested: boolean;
  /** The graph the last attempt rendered: the approved graph with its steps applied. */
  lastGraph: ApiGraph;
}

/**
 * A graph revision of the approved graph and the graph it renders: `steps` applied in order,
 * the node-level diff against the approved graph and the revised graph's fingerprint.
 * Throws RepairError when a step doesn't apply.
 */
export function buildRevision(args: {
  id: string;
  rootRunId: string;
  actionPlanId: string;
  candidateId: string;
  approved: ApiGraph;
  approvedFingerprint: string;
  parentRevisionId?: string;
  steps: TransformationStep[];
  at: Date;
}): { revision: GraphRevision; graph: ApiGraph } {
  const graph = applySteps(args.approved, args.steps);
  return {
    graph,
    revision: {
      schemaVersion: 1,
      id: args.id,
      rootRunId: args.rootRunId,
      actionPlanId: args.actionPlanId,
      candidateId: args.candidateId,
      ...(args.parentRevisionId ? { parentRevisionId: args.parentRevisionId } : {}),
      baseFingerprint: args.approvedFingerprint,
      steps: args.steps,
      diff: diffGraphs(args.approved, graph),
      fingerprint: graphFingerprint(graph),
      createdAt: args.at.toISOString(),
    },
  };
}

/** The smoke stage's one step, as the root's revision records it. */
export function smokeStep(ref: TransformationRef): TransformationStep {
  return { id: ref.id, version: ref.version, reason: "smoke stage: one sampler step at full size, saved to ComfyUI's temp folder" };
}

/** Which stop rule ended a chain (spec §13.4); `refused` when the store's admission refused the next attempt. */
export type StopRule =
  | "refused"
  | "passed"
  | "awaiting_review"
  | "final_done"
  | "smoke_checks"
  | "budget_exhausted"
  | "deadline"
  | "repeated_failure"
  | "no_applicable_transformation"
  | "not_repairable"
  | "cancelled";

export type ChainDecision =
  | { kind: "wait"; reason: string }
  | { kind: "stop"; rule: StopRule; reason: string; resultRunId?: string }
  | { kind: "attempt"; stage: RenderStage; repairRound: number; steps: TransformationStep[]; reason: string; failureClass?: FailureClass };

/** The note on the root that records why its chain stopped (the controller writes it once). */
const ChainStopNote = z.object({
  chain: z.literal("stopped"),
  rule: z.string(),
  attempts: z.number().int().optional(),
  resultRunId: z.string().optional(),
});

/** The chain's stop as the root's events record it, or undefined while it goes on. */
export function chainStopOf(events: readonly RunEvent[]): { rule: string; reason: string; resultRunId?: string } | undefined {
  for (const e of events) {
    if (e.kind !== "note") continue;
    const d = ChainStopNote.safeParse(e.data);
    if (d.success) return { rule: d.data.rule, reason: e.reason, ...(d.data.resultRunId ? { resultRunId: d.data.resultRunId } : {}) };
  }
  return undefined;
}

/** The steps of a revision without the smoke stage's: what a final inherits from its smoke. */
export function repairSteps(steps: readonly TransformationStep[]): TransformationStep[] {
  return steps.filter((s) => s.id !== SMOKE_TRANSFORMATION.id);
}

/**
 * The chain's result: the final attempt that passed, else the latest final that finished,
 * else the latest final. A smoke attempt is never the result (spec §13.1).
 */
export function resultOf(attempts: readonly AttemptView[]): string | undefined {
  const finals = attempts.filter((a) => a.stage === "final");
  const pick = (f: (a: AttemptView) => boolean) => [...finals].reverse().find(f)?.runId;
  return pick((a) => a.acceptance === "passed") ?? pick((a) => a.state === "COMPLETED" || a.state === "AWAITING_REVIEW") ?? finals.at(-1)?.runId;
}

function signature(steps: readonly TransformationStep[]): string {
  return steps.map((s) => `${s.id}@${s.version}${s.node === undefined ? "" : `:${s.node}`}`).join(",");
}

/**
 * What follows the chain's last attempt (ARCH 2026-11-16, repair policy): wait while it
 * runs; a final after a passed smoke; the first applicable transformation not yet applied for
 * the same failure, within the grant; or a stop with the rule that ended the chain and its
 * result. Never a resubmission after OUTCOME_UNKNOWN, which isn't a finished attempt.
 */
export function nextAttempt(input: ChainInput): ChainDecision {
  const { attempts, limits } = input;
  const last = attempts.at(-1);
  if (!last) return { kind: "wait", reason: "the chain has no attempt" };
  const stop = (rule: StopRule, reason: string): ChainDecision => {
    const resultRunId = resultOf(attempts);
    return { kind: "stop", rule, reason, ...(resultRunId ? { resultRunId } : {}) };
  };
  if (last.state === "CANCELLED") return stop("cancelled", `attempt ${last.index} was cancelled`);
  if (last.state === "AWAITING_REVIEW") return stop("awaiting_review", `final attempt ${last.index} waits for the user's review`);
  if (last.state !== "COMPLETED" && last.state !== "FAILED") return { kind: "wait", reason: `attempt ${last.index} is ${last.state}` };
  if (input.cancelRequested) return stop("cancelled", "the run was cancelled");

  const smokes = attempts.filter((a) => a.stage === "smoke").length;
  const finals = attempts.filter((a) => a.stage === "final").length;
  const fits = (stage: RenderStage, repairRound: number): string | undefined => {
    if (limits.maxPreviewRuns === undefined || limits.maxFinalRuns === undefined || limits.maxRepairRounds === undefined) {
      return "the grant has no stage limits";
    }
    if (stage === "smoke" && smokes + 1 > limits.maxPreviewRuns) return `the grant's ${limits.maxPreviewRuns} preview run(s) are used`;
    if (stage === "final" && finals + 1 > limits.maxFinalRuns) return `the grant's ${limits.maxFinalRuns} final run(s) are used`;
    if (repairRound > limits.maxRepairRounds) return `the grant's ${limits.maxRepairRounds} repair round(s) are used`;
    if (attempts.length + 1 > limits.maxRuns) return `the grant's ${limits.maxRuns} run(s) are used`;
    if (input.deadlinePassed) return "the grant's wall time has passed";
    return undefined;
  };
  const budgetStop = (why: string) => stop(why === "the grant's wall time has passed" ? "deadline" : "budget_exhausted", why);

  if (last.state === "COMPLETED") {
    if (last.stage === "smoke") {
      if (last.acceptance === "failed") return stop("smoke_checks", `smoke attempt ${last.index}'s built-in checks failed`);
      if (last.acceptance !== "passed") return stop("smoke_checks", `smoke attempt ${last.index}'s built-in checks are ${last.acceptance}; an unknown blocks the final`);
      const why = fits("final", last.repairRound);
      if (why) return budgetStop(why);
      return { kind: "attempt", stage: "final", repairRound: last.repairRound, steps: repairSteps(last.steps), reason: `smoke attempt ${last.index} passed its checks` };
    }
    if (last.acceptance === "passed") return stop("passed", `final attempt ${last.index} passed acceptance`);
    if (last.acceptance !== "failed" || !last.qualityFailure) return stop("final_done", `final attempt ${last.index} finished; acceptance ${last.acceptance}`);
    if (!last.qualityFailure.seedChangeable) {
      return stop("not_repairable", `final attempt ${last.index} failed ${last.qualityFailure.criteria.join(", ")}, which no allowed transformation changes`);
    }
    return repair(input, last, { failureClass: "quality", matched: `failed ${last.qualityFailure.criteria.join(", ")}` }, fits, stop, budgetStop);
  }

  const failure = classifyFailure(last.error);
  if (STOP_CLASSES.includes(failure.failureClass)) {
    return stop("not_repairable", `attempt ${last.index} failed with a ${failure.failureClass} failure (${failure.matched}), which isn't repaired`);
  }
  const repeated = attempts
    .slice(0, -1)
    .some((a) => a.state === "FAILED" && signature(a.steps) === signature(last.steps) && sameFailure(classifyFailure(a.error), failure));
  if (repeated) return stop("repeated_failure", `attempt ${last.index} failed as an earlier one did (${failure.failureClass} at node ${failure.node ?? "?"})`);
  return repair(input, last, failure, fits, stop, budgetStop);
}

function sameFailure(a: ClassifiedFailure, b: ClassifiedFailure): boolean {
  return a.failureClass === b.failureClass && a.node === b.node;
}

function repair(
  input: ChainInput,
  last: AttemptView,
  failure: Pick<ClassifiedFailure, "failureClass" | "node" | "matched">,
  fits: (stage: RenderStage, repairRound: number) => string | undefined,
  stop: (rule: StopRule, reason: string) => ChainDecision,
  budgetStop: (why: string) => ChainDecision,
): ChainDecision {
  const allowed = (id: TransformationId) => input.repair.find((r) => r.id === id && DEFS[id].version === r.version);
  const already = (id: TransformationId, node: string | undefined) =>
    last.steps.some((s) => s.id === id && s.node === node && s.failureClass === failure.failureClass);
  for (const id of ALLOWLIST[failure.failureClass]) {
    const ref = allowed(id);
    if (!ref) continue;
    const def = DEFS[id];
    const node = def.needsNode ? failure.node : undefined;
    if (def.needsNode && node === undefined) continue;
    if (already(id, node) || !def.applies(input.lastGraph, node)) continue;
    // spec §15.4: a retry only when no prompt can have reached ComfyUI under the last ID.
    if (id === "retry.unchanged" && last.submitted) continue;
    const repairRound = last.repairRound + 1;
    const why = fits(last.stage, repairRound);
    if (why) return budgetStop(why);
    const step: TransformationStep = {
      id,
      version: ref.version,
      ...(node === undefined ? {} : { node }),
      reason: `attempt ${last.index} failed: ${failure.failureClass} (${failure.matched})${failure.node !== undefined ? ` at node ${failure.node}` : ""}`.slice(0, 500),
      failureClass: failure.failureClass,
      failedRunId: last.runId,
    };
    return { kind: "attempt", stage: last.stage, repairRound, steps: [...last.steps, step], reason: `repair round ${repairRound}: ${id}`, failureClass: failure.failureClass };
  }
  return stop("no_applicable_transformation", `no allowed transformation applies to attempt ${last.index}'s ${failure.failureClass} failure${failure.node !== undefined ? ` at node ${failure.node}` : ""}`);
}
