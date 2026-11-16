// Action plans, grants and the one gate every Architect effect passes (TODO 3.3, 3.4;
// spec §14.1-§14.3, SEC T1).
//
// Three rules hold here:
// - A grant comes only from an approval channel: `issueGrant` is called by the terminal
//   command (cli.ts) and by the elicitation handler, never by a tool with a model-supplied
//   argument. Tools reference an action plan; the store finds the grant.
// - A grant binds the action plan's hash. `admitEffect` rebuilds the plan from the current
//   records and a fresh validation, so a changed task, candidate, graph, target or budget
//   gives another hash and the old grant no longer applies (APPROVAL_INVALIDATED).
// - One grant starts one run: the store consumes it in the transaction that creates the run.

import { ARCHITECT_PANEL_RUNS_ENV, onPanelRoute, panelRunsAllowed } from "./config.js";
import { canonicalJson } from "./hash.js";
import type { ArchitectPlanning } from "./planning.js";
import {
  type ActionPlan,
  type ApprovalChannel,
  type ApprovalGrant,
  type ApprovalRequest,
  type ApiGraph,
  type Effect,
  type Recipe,
  type ReleaseResidencyEffect,
  type TaskSpec,
  actionPlanHash,
} from "./schemas.js";
import { architectDataDir, type ArchitectStore } from "./store.js";
import { isLoopbackHostname } from "./validate.js";

/** How long an action plan, and a grant made for it, stays usable. */
export const DEFAULT_ACTION_PLAN_TTL_MS = 30 * 60 * 1000;
/** The wall-time budget when the task sets none (spec §18.1 `maxWallTimeSeconds`). */
export const DEFAULT_MAX_WALL_TIME_SECONDS = 1800;

/** A refusal on the effect path, with a stable code (spec §16.4) and a safe next step. */
export class ApprovalError extends Error {
  constructor(
    readonly code: "APPROVAL_REQUIRED" | "APPROVAL_INVALIDATED" | "MISSING_INPUT" | "STALE_ENVIRONMENT" | "GRAPH_CONFLICT",
    message: string,
    readonly nextStep: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

/** The first eight hex digits, which the user compares or types to confirm a plan. */
export function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

/**
 * ComfyUI 0.3.57 added the prompt id to /interrupt; an older server stops whatever runs,
 * which may be someone else's job (spec §14.5). Below it, or with no version reported,
 * no run starts.
 */
export const MIN_COMFYUI_VERSION = [0, 3, 57] as const;

function versionAtLeast(version: string | undefined, min: readonly number[]): boolean | undefined {
  const m = version?.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return undefined;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

/**
 * The terminal command that approves a request, as this server would run it: the same
 * entry point and data directory, so it works from a clone where `comfyui-mcp` on PATH
 * would be upstream's package.
 */
export function approveCommand(requestId: string, subcommand: "approve" | "review" = "approve"): string {
  const entry = process.argv[1] ? `node ${JSON.stringify(process.argv[1])}` : "comfyui-mcp";
  return `COMFYUI_ARCHITECT=1 ARCHITECT_DATA_DIR=${JSON.stringify(architectDataDir())} ${entry} architect ${subcommand} ${requestId}`;
}

/** Text from records and ComfyUI, shown in a terminal or dialog: no control characters. */
export function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

export interface AdmissionDeps {
  store: ArchitectStore;
  planning: Pick<ArchitectPlanning, "selectedForRun" | "validate">;
  /** The ComfyUI target this server is configured for. */
  baseUrl: () => string;
  now: () => Date;
  newId: () => string;
  actionPlanTtlMs?: number;
  /**
   * The Ollama models to unload for a render, when the user lets Architect manage them
   * (ARCHITECT_MANAGE_RESIDENCY=1; GAPS Q23): what Ollama holds in the target's pool now.
   * Undefined when management is off, nothing is resident, or the pool isn't shared.
   */
  releasable?: (baseUrl: string) => Promise<ReleaseResidencyEffect | undefined>;
}

/** What the action plan binds, built from a selected candidate (everything the hash covers). */
function binding(
  ctx: { plan: { id: string }; task: TaskSpec; candidate: { id: string }; recipe: Recipe; fingerprint: string },
  baseUrl: string,
  residency: ReleaseResidencyEffect | undefined,
) {
  return {
    planId: ctx.plan.id,
    taskId: ctx.task.id,
    taskRevision: ctx.task.revision,
    candidateId: ctx.candidate.id,
    target: { baseUrl },
    effects: [
      { kind: "local_render" as const, graphFingerprint: ctx.fingerprint, outputNodes: ctx.recipe.outputs.map((o) => o.node) },
      ...(residency ? [residency] : []),
    ] satisfies Effect[],
    budgets: { maxRuns: 1, maxWallTimeSeconds: ctx.task.budgets.maxWallTimeSeconds ?? DEFAULT_MAX_WALL_TIME_SECONDS },
  };
}

/**
 * Build and store an action plan for the plan's selected candidate, and open its approval
 * request. The candidate is validated again first, against a fresh snapshot, so the user
 * is never asked to approve a plan that's already stale.
 */
export async function prepareActionPlan(deps: AdmissionDeps, planId: string): Promise<{ actionPlan: ActionPlan; request: ApprovalRequest }> {
  const { store, now, newId } = deps;
  const ctx = await freshSelection(deps, planId);
  const created = now();
  const expiresAt = new Date(created.getTime() + (deps.actionPlanTtlMs ?? DEFAULT_ACTION_PLAN_TTL_MS)).toISOString();
  const baseUrl = deps.baseUrl();
  // The models to unload are read now and shown in the approval, so the user is asked
  // before any of them is unloaded (GAPS Q23).
  const bound = binding(ctx, baseUrl, await deps.releasable?.(baseUrl));
  const actionPlan = store.putActionPlan({
    schemaVersion: 1,
    id: `actions-${newId()}`,
    ...bound,
    environmentId: ctx.candidate.environmentId,
    createdAt: created.toISOString(),
    expiresAt,
    hash: actionPlanHash(bound),
  });
  const request = store.putApprovalRequest({
    schemaVersion: 1,
    id: `approval-${newId()}`,
    actionPlanId: actionPlan.id,
    actionPlanHash: actionPlan.hash,
    state: "pending",
    createdAt: created.toISOString(),
    expiresAt,
  });
  return { actionPlan, request };
}

/** Validate the selected candidate again; refuse when the selection didn't survive. */
/**
 * Validate a candidate against a fresh snapshot and require it feasible. Used at admission
 * and by the controller before submitting a run that waited for its resources (spec §15.3).
 */
export async function requireFeasible(planning: Pick<AdmissionDeps["planning"], "validate">, planId: string, candidateId: string): Promise<void> {
  const checked = await planning.validate({ planId, candidateId });
  if (checked.candidate.status !== "feasible") {
    throw new ApprovalError(
      "APPROVAL_INVALIDATED",
      `candidate ${candidateId} is ${checked.candidate.status} against the current environment: ${checked.candidate.blocking.join("; ") || "see its validation"}`,
      "Report the blockers to the user and plan again; never relax a requirement without their approval.",
    );
  }
}

async function freshSelection(deps: AdmissionDeps, planId: string) {
  const before = deps.planning.selectedForRun(planId);
  await requireFeasible(deps.planning, planId, before.candidate.id);
  // Read again: validation stored a fresh report and environment for the candidate.
  return deps.planning.selectedForRun(planId);
}

/**
 * Issue a grant for a pending request. Called only from an approval channel: the terminal
 * command, after the user typed the plan's short hash, and the elicitation handler, after
 * the user accepted the dialog. `confirmHash` is required for the terminal channel.
 */
export function issueGrant(
  deps: Pick<AdmissionDeps, "store" | "now" | "newId">,
  args: { requestId: string; channel: ApprovalChannel; issuer: string; confirmHash?: string },
): ApprovalGrant {
  const { store, now, newId } = deps;
  const request = store.getApprovalRequest(args.requestId);
  if (!request) throw new ApprovalError("MISSING_INPUT", `approval request ${args.requestId} is not stored`, "Check the request ID.");
  const actionPlan = store.getActionPlan(request.actionPlanId);
  if (!actionPlan) throw new ApprovalError("MISSING_INPUT", `action plan ${request.actionPlanId} is not stored`, "Prepare the run again.");
  if (request.state !== "pending") {
    throw new ApprovalError("APPROVAL_INVALIDATED", `approval request ${request.id} is ${request.state}`, "Prepare the run again for a new request.");
  }
  const at = now();
  if (at.getTime() >= Date.parse(request.expiresAt)) {
    store.resolveApprovalRequest(request.id, "expired", at);
    throw new ApprovalError("APPROVAL_INVALIDATED", `approval request ${request.id} expired at ${request.expiresAt}`, "Prepare the run again.");
  }
  if (request.actionPlanHash !== actionPlan.hash) {
    throw new ApprovalError("APPROVAL_INVALIDATED", `approval request ${request.id} names another plan hash than its action plan`, "Prepare the run again.");
  }
  if (args.channel === "terminal" && args.confirmHash?.trim().toLowerCase() !== shortHash(actionPlan.hash)) {
    throw new ApprovalError("APPROVAL_REQUIRED", "the confirmation doesn't match the action plan's short hash", "Run the approve command again and type the hash it shows.");
  }
  store.resolveApprovalRequest(request.id, "granted", at);
  return store.putGrant({
    schemaVersion: 1,
    id: `grant-${newId()}`,
    approvalRequestId: request.id,
    actionPlanId: actionPlan.id,
    actionPlanHash: actionPlan.hash,
    target: actionPlan.target,
    limits: actionPlan.budgets,
    channel: args.channel,
    issuer: args.issuer,
    issuedAt: at.toISOString(),
    expiresAt: actionPlan.expiresAt,
  });
}

/** Record that the user declined a request; no grant follows. */
export function declineRequest(deps: Pick<AdmissionDeps, "store" | "now">, requestId: string): ApprovalRequest {
  return deps.store.resolveApprovalRequest(requestId, "declined", deps.now());
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

function describeEffect(e: Effect): string {
  switch (e.kind) {
    case "local_render":
      return `Effect: local_render of graph ${shortHash(e.graphFingerprint)}`;
    case "release_residency":
      return (
        `Effect: unload from Ollama at ${e.host} before the render, and load back after it: ` +
        `${e.models.map((m) => `${m.name} (${gigabytes(m.sizeBytes)})`).join(", ")}`
      );
  }
}

/** What an approval channel shows the user before they decide. */
export function describeActionPlan(store: ArchitectStore, actionPlan: ActionPlan): string {
  const task = store.getTask(actionPlan.taskId, actionPlan.taskRevision);
  const candidate = store.getCandidate(actionPlan.candidateId);
  const lines = [
    `Action plan ${actionPlan.id} (hash ${shortHash(actionPlan.hash)})`,
    `Task: ${task ? JSON.stringify(task.intent) : actionPlan.taskId} (${task ? `${task.media.kind}, ${task.media.operation}` : "?"})`,
    `Candidate: ${candidate ? `${candidate.recipeId} r${candidate.recipeRevision}` : actionPlan.candidateId}`,
    ...(candidate ? [`Models: ${Object.entries(candidate.bindings).filter(([, v]) => typeof v === "string" && /\.(safetensors|ckpt|pt|pth|bin|gguf)$/i.test(String(v))).map(([k, v]) => `${k}=${String(v)}`).join(", ") || "none"}`] : []),
    ...actionPlan.effects.map(describeEffect),
    `Target: ${actionPlan.target.baseUrl}`,
    `Limits: ${actionPlan.budgets.maxRuns} run, at most ${actionPlan.budgets.maxWallTimeSeconds} s`,
    `Memory and time: unknown; nothing has been measured for this recipe here, so this run is the bounded probe that measures it`,
    `Expires: ${actionPlan.expiresAt}`,
  ];
  return lines.map(printable).join("\n");
}

/**
 * The gate (ARCH 2026-11-15). Before an effect: the action plan is unexpired, its target is
 * the configured one, the selected candidate is still feasible against a fresh snapshot,
 * the rebuilt plan has the same hash, and a usable grant exists. With no grant, `elicit` is
 * tried when the caller offers it (a client dialog only the user answers); otherwise the
 * refusal names the terminal command. Returns the grant and the compiled graph.
 */
export async function admitEffect(
  deps: AdmissionDeps,
  actionPlanId: string,
  elicit?: (actionPlan: ActionPlan, request: ApprovalRequest) => Promise<ApprovalGrant | undefined>,
): Promise<{ actionPlan: ActionPlan; grant: ApprovalGrant; graph: ApiGraph; task: TaskSpec }> {
  const { store, now } = deps;
  // The panel's agents run with shells that approve themselves (upstream's backends), and
  // the terminal is the only channel there, so the agent could complete the approval on
  // its own. No run starts on that route unless the operator accepted that with
  // ARCHITECT_PANEL_RUNS=terminal, until the panel has an approval of its own (ROAD
  // phase 4; GAPS Q22). Even then no dialog is shown there (architect-run.ts).
  if (onPanelRoute() && !panelRunsAllowed()) {
    throw new ApprovalError(
      "APPROVAL_REQUIRED",
      "runs can't be started from the ComfyUI panel's agent: it has no approval channel the agent can't answer itself",
      `Plan here; start the run from an external MCP client, where the user approves in a dialog or their own terminal. The operator can allow runs here with ${ARCHITECT_PANEL_RUNS_ENV}=terminal.`,
    );
  }
  const actionPlan = store.getActionPlan(actionPlanId);
  if (!actionPlan) throw new ApprovalError("MISSING_INPUT", `action plan ${actionPlanId} is not stored`, "Call architect_run prepare.");
  const at = now();
  if (at.getTime() >= Date.parse(actionPlan.expiresAt)) {
    throw new ApprovalError("APPROVAL_INVALIDATED", `action plan ${actionPlan.id} expired at ${actionPlan.expiresAt}`, "Call architect_run prepare again.");
  }
  const baseUrl = deps.baseUrl();
  if (actionPlan.target.baseUrl !== baseUrl) {
    throw new ApprovalError(
      "APPROVAL_INVALIDATED",
      `action plan ${actionPlan.id} was approved for ${actionPlan.target.baseUrl}, but this server targets ${baseUrl}`,
      "Prepare the run again for the current target.",
    );
  }
  const ctx = await freshSelection(deps, actionPlan.planId);
  requireLocalCapableTarget(store, baseUrl, ctx.candidate.environmentId);
  // The residency effect is the one the user approved, not a fresh reading: a model that
  // left Ollama since doesn't invalidate the approval, and one that arrived since isn't
  // unloaded (the controller blocks on it).
  const rebuilt = actionPlanHash(binding(ctx, baseUrl, actionPlan.effects.find((e): e is ReleaseResidencyEffect => e.kind === "release_residency")));
  if (rebuilt !== actionPlan.hash) {
    throw new ApprovalError(
      "APPROVAL_INVALIDATED",
      `the plan changed since action plan ${actionPlan.id} was prepared (hash ${shortHash(actionPlan.hash)}, now ${shortHash(rebuilt)})`,
      "Call architect_run prepare again; the user approves the new plan.",
      { previous: canonicalJson({ hash: actionPlan.hash }), current: rebuilt },
    );
  }
  let grant = store.findUsableGrant({ actionPlanId: actionPlan.id, actionPlanHash: actionPlan.hash, baseUrl, now: at });
  if (!grant) {
    const request = pendingRequest(store, actionPlan);
    if (request && elicit) grant = await elicit(actionPlan, request);
    if (!grant) {
      throw new ApprovalError(
        "APPROVAL_REQUIRED",
        `action plan ${actionPlan.id} (hash ${shortHash(actionPlan.hash)}) has no grant`,
        request
          ? `Ask the user to approve it themselves, in a terminal: ${approveCommand(request.id)}. Then call start again. You can't approve it for them.`
          : "Call architect_run prepare again for a new approval request.",
        request ? { approvalRequestId: request.id, shortHash: shortHash(actionPlan.hash) } : undefined,
      );
    }
  }
  return { actionPlan, grant, graph: ctx.graph, task: ctx.task };
}

/**
 * The effect is a local render: the target must be on this machine (a remote or cloud
 * target can disclose data or spend money, which this milestone has no approval for), and
 * its ComfyUI must interrupt by prompt id. Checked against the snapshot the candidate was
 * just validated on; an unreported version is a hard unknown and blocks (spec §7.3).
 */
function requireLocalCapableTarget(store: ArchitectStore, baseUrl: string, environmentId: string): void {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    throw new ApprovalError("APPROVAL_INVALIDATED", `the target ${baseUrl} isn't a URL`, "Configure a local ComfyUI target.");
  }
  if (!isLoopbackHostname(host)) {
    throw new ApprovalError("APPROVAL_INVALIDATED", `the target ${baseUrl} isn't on this machine; this version renders locally only`, "Point the server at a local ComfyUI, or render with upstream's tools.");
  }
  const version = store.getSnapshot(environmentId)?.comfyuiVersion;
  const ok = versionAtLeast(version, MIN_COMFYUI_VERSION);
  if (ok !== true) {
    throw new ApprovalError(
      "APPROVAL_INVALIDATED",
      ok === undefined
        ? "the target didn't report its ComfyUI version, so it can't be shown to cancel only its own job"
        : `ComfyUI ${version} interrupts every running job, not one by its id; ${MIN_COMFYUI_VERSION.join(".")} or newer is needed`,
      "Update ComfyUI, then prepare the run again.",
    );
  }
}

/** The action plan's request if it's still waiting. */
function pendingRequest(store: ArchitectStore, actionPlan: ActionPlan): ApprovalRequest | undefined {
  const request = store.latestRequestFor(actionPlan.id);
  return request?.state === "pending" ? request : undefined;
}
