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

import { dirname, join } from "node:path";
import { type AcquisitionIo, diskShortfall, freeDiskBytesSync, hfEndpointRefusal, stagedNameOf } from "./acquisition.js";
import { MIN_FREE_DISK_BYTES, acquisitionPolicy, formatBytes } from "./acquisition-policy.js";
import { ARCHITECT_PANEL_RUNS_ENV, onPanelRoute, panelRunsAllowed } from "./config.js";
import { canonicalJson } from "./hash.js";
import type { ArchitectPlanning } from "./planning.js";
import {
  type AcquireModelsEffect,
  type ActionPlan,
  type ApprovalChannel,
  type ApprovalGrant,
  type ApprovalRequest,
  type ApiGraph,
  type CandidateAcquisition,
  Effect,
  type PlanCandidate,
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
/**
 * The download rate the wall-time allowance for a plan's downloads assumes when the task
 * sets no wall time: 10 MB/s (decimal). A bound the grant names, not an estimate.
 */
export const DOWNLOAD_ALLOWANCE_BYTES_PER_SECOND = 10_000_000;

/** Seconds added to the default wall time for downloading `bytes`, rounded up. */
export function downloadAllowanceSeconds(bytes: number): number {
  return Math.ceil(bytes / DOWNLOAD_ALLOWANCE_BYTES_PER_SECOND);
}

/** A refusal on the effect path, with a stable code (spec §16.4) and a safe next step. */
export class ApprovalError extends Error {
  constructor(
    readonly code: "APPROVAL_REQUIRED" | "APPROVAL_INVALIDATED" | "MISSING_INPUT" | "STALE_ENVIRONMENT" | "GRAPH_CONFLICT" | "DEPENDENCY_UNAVAILABLE",
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
  planning: Pick<ArchitectPlanning, "selectedForRun" | "validate" | "store">;
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
  /**
   * Upstream's downloader, the filesystem and the network, for a candidate that acquires
   * model files first (TODO 4.5). Without it such a candidate isn't prepared or started.
   */
  acquisitionIo?: AcquisitionIo;
}

/** What the action plan binds, built from a selected candidate (everything the hash covers). */
function binding(
  ctx: { plan: { id: string }; task: TaskSpec; candidate: { id: string }; recipe: Recipe; fingerprint: string },
  baseUrl: string,
  residency: ReleaseResidencyEffect | undefined,
  acquire?: AcquireModelsEffect,
) {
  return {
    planId: ctx.plan.id,
    taskId: ctx.task.id,
    taskRevision: ctx.task.revision,
    candidateId: ctx.candidate.id,
    target: { baseUrl },
    effects: [
      // The files are acquired before the render that needs them (ARCH 2026-11-16, candidates).
      ...(acquire ? [acquire] : []),
      { kind: "local_render" as const, graphFingerprint: ctx.fingerprint, outputNodes: ctx.recipe.outputs.map((o) => o.node) },
      ...(residency ? [residency] : []),
    ] satisfies Effect[],
    // The wall time counts from the run's start and so covers its downloads: a task without
    // its own gets the default plus an allowance at 10 MB/s. A task's own value stays as given.
    budgets: {
      maxRuns: 1,
      maxWallTimeSeconds:
        ctx.task.budgets.maxWallTimeSeconds ?? DEFAULT_MAX_WALL_TIME_SECONDS + (acquire ? downloadAllowanceSeconds(acquire.totalBytes) : 0),
    },
  };
}

/**
 * Build and store an action plan for the plan's selected candidate, and open its approval
 * request. The candidate is validated again first, against a fresh snapshot, so the user
 * is never asked to approve a plan that's already stale.
 */
export async function prepareActionPlan(deps: AdmissionDeps, planId: string): Promise<{ actionPlan: ActionPlan; request: ApprovalRequest }> {
  const { store, now, newId } = deps;
  const ctx = await freshSelection(deps, planId, { allowAcquirable: true });
  const created = now();
  const expiresAt = new Date(created.getTime() + (deps.actionPlanTtlMs ?? DEFAULT_ACTION_PLAN_TTL_MS)).toISOString();
  const baseUrl = deps.baseUrl();
  // An acquirable candidate gets its downloads in the plan, checked and sized now, so the
  // user approves each file, its source and destination (TODO 4.5). A feasible one gets none.
  let acquire: AcquireModelsEffect | undefined;
  if (ctx.candidate.status === "acquirable") {
    // A download writes into this machine's model folders: only for a local target, the
    // same rule start applies to the render.
    requireLocalCapableTarget(store, baseUrl, ctx.candidate.environmentId);
    acquire = await acquireEffectFor(deps, ctx.task, ctx.candidate, { checkDisk: true });
  }
  // The models to unload are read now and shown in the approval, so the user is asked
  // before any of them is unloaded (GAPS Q23).
  const bound = binding(ctx, baseUrl, await deps.releasable?.(baseUrl), acquire);
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

/**
 * Validate a candidate against a fresh snapshot and require it feasible. Used at admission
 * and by the controller before submitting a run that waited for its resources (spec §15.3).
 */
export async function requireFeasible(
  planning: Pick<AdmissionDeps["planning"], "validate" | "store">,
  planId: string,
  candidateId: string,
): Promise<void> {
  await requireAdmissible(planning, planId, candidateId);
}

/**
 * Validate a candidate against a fresh snapshot, require it feasible, and return it as that
 * validation stored it. With `allowAcquirable`, an acquirable candidate passes too, its
 * `acquisition` derived again by this validation; only the step that acquires the files
 * before the render asks for that (TODO 4.5).
 */
export async function requireAdmissible(
  planning: Pick<AdmissionDeps["planning"], "validate" | "store">,
  planId: string,
  candidateId: string,
  options: { allowAcquirable?: boolean } = {},
): Promise<PlanCandidate> {
  const checked = await planning.validate({ planId, candidateId });
  const status = checked.candidate.status;
  if (status !== "feasible" && !(status === "acquirable" && options.allowAcquirable === true)) {
    throw new ApprovalError(
      "APPROVAL_INVALIDATED",
      `candidate ${candidateId} is ${status} against the current environment: ${checked.candidate.blocking.join("; ") || "see its validation"}`,
      status === "acquirable"
        ? "The candidate needs model files first; prepare a run that acquires them, with the user's approval."
        : "Report the blockers to the user and plan again; never relax a requirement without their approval.",
    );
  }
  const stored = planning.store.getCandidate(candidateId);
  // validate just wrote it; a different status means another writer changed it meanwhile.
  if (!stored || stored.status !== status) {
    throw new ApprovalError("APPROVAL_INVALIDATED", `candidate ${candidateId} changed while it was validated`, "Call architect_run prepare again.");
  }
  return stored;
}

async function freshSelection(deps: AdmissionDeps, planId: string, options: { allowAcquirable: boolean }) {
  const before = deps.planning.selectedForRun(planId, options);
  await requireAdmissible(deps.planning, planId, before.candidate.id, options);
  // Read again: validation stored a fresh report and environment for the candidate.
  return deps.planning.selectedForRun(planId, options);
}

/** A refusal while the downloads of a plan are built, with the step that can fix it. */
function acquisitionRefusal(message: string, nextStep = "Report this to the user; the candidate can't acquire its files on this target."): ApprovalError {
  return new ApprovalError("DEPENDENCY_UNAVAILABLE", message, nextStep);
}

/**
 * The `acquire_models` effect for a candidate's acquisition (TODO 4.5; GAPS Q25). Its files
 * are the candidate's, one for one; the destination root of each is where upstream's own
 * resolver would write it. Refused: a task that forbids downloads or a policy refusal, an
 * `HF_ENDPOINT` that would change the host, the ComfyUI-Manager route, a destination
 * upstream can't resolve or that isn't `<root>/<folder>/<file>`, and a destination that
 * already exists (the candidate needs validating again then). With `checkDisk` (at
 * prepare), each root must keep at least 50 GB free after the whole download; a free-disk
 * reading that fails refuses too (spec §7.3).
 */
async function acquireEffectFor(
  deps: AdmissionDeps,
  task: TaskSpec,
  candidate: PlanCandidate,
  options: { checkDisk: boolean },
): Promise<AcquireModelsEffect> {
  const acquisition: CandidateAcquisition | undefined = candidate.acquisition;
  if (!acquisition) throw acquisitionRefusal(`candidate ${candidate.id} has no acquisition`);
  const io = deps.acquisitionIo;
  if (!io) throw acquisitionRefusal("this server isn't set up to download model files", "Plan with installed models only.");
  const policy = acquisitionPolicy(task, acquisition.files);
  if (!policy.allowed) throw acquisitionRefusal(`the download policy refuses: ${policy.refusals.map((r) => r.message).join("; ")}`);
  const endpoint = hfEndpointRefusal(io.env);
  if (endpoint) throw acquisitionRefusal(endpoint, "Unset HF_ENDPOINT, or download the files yourself.");
  if (await io.facade.downloadRoutesToManager()) {
    throw acquisitionRefusal(
      "upstream would hand these downloads to ComfyUI-Manager, whose files can't be checked before they are placed",
      "Set COMFYUI_PATH to the ComfyUI install, so downloads are written locally, then prepare again.",
    );
  }
  const files: AcquireModelsEffect["files"] = [];
  for (const f of acquisition.files) {
    let dest: { root: string; path: string };
    try {
      dest = await io.facade.resolveModelDestination(f.folder, f.file);
    } catch (err) {
      throw acquisitionRefusal(`upstream can't resolve where ${f.folder}/${f.file} would go: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (dest.path !== join(dest.root, f.folder, f.file)) {
      throw acquisitionRefusal(`upstream would write ${f.folder}/${f.file} to ${dest.path}, not into a ${f.folder} folder under a model root`);
    }
    // The download is staged next to the destination under a name no loader lists; it has
    // to resolve into the same folder, or the controller would refuse it later.
    let staged: { root: string; path: string };
    try {
      staged = await io.facade.resolveModelDestination(f.folder, stagedNameOf(f.file, "run-check"));
    } catch (err) {
      throw acquisitionRefusal(`upstream can't resolve a staged name next to ${f.folder}/${f.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (dirname(staged.path) !== dirname(dest.path)) {
      throw acquisitionRefusal(`upstream would stage ${f.folder}/${f.file} in ${dirname(staged.path)}, not next to its destination ${dest.path}`);
    }
    try {
      await io.fs.lstat(dest.path);
      throw new ApprovalError(
        "STALE_ENVIRONMENT",
        `${dest.path} already exists, so the candidate doesn't need it downloaded`,
        "Call architect_plan validate for the candidate, then prepare again.",
      );
    } catch (err) {
      if (err instanceof ApprovalError) throw err;
      const code = err !== null && typeof err === "object" && "code" in err ? err.code : undefined;
      if (code !== "ENOENT") {
        throw acquisitionRefusal(`couldn't check whether ${dest.path} exists: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    files.push({ folder: f.folder, file: f.file, source: f.source, destinationRoot: dest.root });
  }
  if (options.checkDisk) {
    // The model root's disk and upstream's download cache's, with the unfinished downloads
    // of other runs reserved (GAPS Q25).
    const shortfall = await diskShortfall(io, deps.store, files, MIN_FREE_DISK_BYTES);
    if (shortfall) throw acquisitionRefusal(`${shortfall} (GAPS Q25)`, "Report this to the user: they can free disk space, then prepare again.");
  }
  const effect = Effect.parse({ kind: "acquire_models", files, totalBytes: policy.totalBytes, maxBytes: policy.maxBytes, minFreeBytes: MIN_FREE_DISK_BYTES });
  if (effect.kind !== "acquire_models") throw acquisitionRefusal("the download effect didn't parse as one");
  return effect;
}

/** The (folder, file, source) list a plan's effect and a candidate's acquisition must share. */
function acquiredFiles(files: readonly { folder: string; file: string; source: unknown }[]): string {
  return canonicalJson(files.map((f) => ({ folder: f.folder, file: f.file, source: f.source })));
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

/** Reads the free disk under a path for the approval text; a failed read says so. */
export type FreeDiskReader = (path: string) => { known: true; bytes: number } | { known: false; reason: string };

function describeEffect(e: Effect, freeDisk: FreeDiskReader): string {
  switch (e.kind) {
    case "local_render":
      return `Effect: local_render of graph ${shortHash(e.graphFingerprint)}`;
    case "release_residency":
      return (
        `Effect: unload from Ollama at ${e.host} before the render, and load back after it: ` +
        `${e.models.map((m) => `${m.name} (${gigabytes(m.sizeBytes)})`).join(", ")}`
      );
    case "acquire_models": {
      const roots = [...new Set(e.files.map((f) => f.destinationRoot))];
      return [
        `Effect: download ${e.files.length} model file(s) from Hugging Face before the render, ${formatBytes(e.totalBytes)} in total ` +
          `(at most ${formatBytes(e.maxBytes)}), each checked against its pinned sha256 and size before it is placed; an existing file is never replaced:`,
        ...e.files.map(
          (f) =>
            `  ${f.folder}/${f.file}: ${f.source.repo}@${f.source.revision.slice(0, 12)} ${f.source.path}, ${formatBytes(f.source.sizeBytes)}` +
            (f.source.license ? `, licence ${f.source.license}` : ""),
        ),
        ...roots.map((root) => {
          const free = freeDisk(root);
          const remains = free.known ? `${formatBytes(free.bytes - e.totalBytes)} of disk will remain free` : `free disk unknown (${free.reason})`;
          return `  Destination: ${root} (${remains}; at least ${formatBytes(e.minFreeBytes)} must)`;
        }),
      ].join("\n");
    }
  }
}

/** How a plan's wall time was set when it includes a download allowance. */
function wallTimeNote(task: TaskSpec | undefined, actionPlan: ActionPlan): string {
  const acquire = actionPlan.effects.find((e): e is AcquireModelsEffect => e.kind === "acquire_models");
  if (!acquire || !task || task.budgets.maxWallTimeSeconds !== undefined) return "";
  return ` from the start, downloads included (${DEFAULT_MAX_WALL_TIME_SECONDS} s plus ${downloadAllowanceSeconds(acquire.totalBytes)} s for ${formatBytes(acquire.totalBytes)} at 10 MB/s)`;
}

/** What an approval channel shows the user before they decide. */
export function describeActionPlan(store: ArchitectStore, actionPlan: ActionPlan, freeDisk: FreeDiskReader = freeDiskBytesSync): string {
  const task = store.getTask(actionPlan.taskId, actionPlan.taskRevision);
  const candidate = store.getCandidate(actionPlan.candidateId);
  const lines = [
    `Action plan ${actionPlan.id} (hash ${shortHash(actionPlan.hash)})`,
    `Task: ${task ? JSON.stringify(task.intent) : actionPlan.taskId} (${task ? `${task.media.kind}, ${task.media.operation}` : "?"})`,
    `Candidate: ${candidate ? `${candidate.recipeId} r${candidate.recipeRevision} (${candidate.ranking.tier} recipe)` : actionPlan.candidateId}`,
    // GAPS Q30: a proposed recipe may download, and the person approving sees that no one has
    // reviewed the recipe, or the sources it pinned.
    ...(candidate?.ranking.tier === "proposed" && actionPlan.effects.some((e) => e.kind === "acquire_models")
      ? ["Note: this recipe is proposed: an agent wrote it and pinned its download sources, and no maintainer has reviewed it yet"]
      : []),
    ...(candidate ? [`Models: ${Object.entries(candidate.bindings).filter(([, v]) => typeof v === "string" && /\.(safetensors|ckpt|pt|pth|bin|gguf)$/i.test(String(v))).map(([k, v]) => `${k}=${String(v)}`).join(", ") || "none"}`] : []),
    // One line per entry: `printable` turns a newline inside a line into a visible mark.
    ...actionPlan.effects.flatMap((e) => describeEffect(e, freeDisk).split("\n")),
    `Target: ${actionPlan.target.baseUrl}`,
    `Limits: ${actionPlan.budgets.maxRuns} run, at most ${actionPlan.budgets.maxWallTimeSeconds} s` + wallTimeNote(task, actionPlan),
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
  // A plan that acquires files was approved for an acquirable candidate, which stays
  // acquirable until the files are placed; every other plan needs a feasible one.
  const approvedAcquire = actionPlan.effects.find((e): e is AcquireModelsEffect => e.kind === "acquire_models");
  const ctx = await freshSelection(deps, actionPlan.planId, { allowAcquirable: approvedAcquire !== undefined });
  requireLocalCapableTarget(store, baseUrl, ctx.candidate.environmentId);
  // The downloads are rebuilt from the candidate's fresh acquisition and upstream's current
  // destinations, without the free-disk reading (it isn't part of the hash; the controller
  // checks it before each file). A candidate that became feasible meanwhile rebuilds without
  // them, and the hash tells the user to prepare again.
  let acquire: AcquireModelsEffect | undefined;
  if (approvedAcquire && ctx.candidate.status === "acquirable") {
    if (!ctx.candidate.acquisition || acquiredFiles(ctx.candidate.acquisition.files) !== acquiredFiles(approvedAcquire.files)) {
      throw new ApprovalError(
        "APPROVAL_INVALIDATED",
        `the files candidate ${ctx.candidate.id} needs aren't the ones action plan ${actionPlan.id} downloads`,
        "Call architect_run prepare again; the user approves the new downloads.",
      );
    }
    acquire = await acquireEffectFor(deps, ctx.task, ctx.candidate, { checkDisk: false });
  }
  // The residency effect is the one the user approved, not a fresh reading: a model that
  // left Ollama since doesn't invalidate the approval, and one that arrived since isn't
  // unloaded (the controller blocks on it).
  const rebuilt = actionPlanHash(
    binding(ctx, baseUrl, actionPlan.effects.find((e): e is ReleaseResidencyEffect => e.kind === "release_residency"), acquire),
  );
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
