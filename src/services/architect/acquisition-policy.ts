// Which missing model files a candidate may acquire (TODO 4.2, 4.3; ARCH 2026-11-16,
// candidates and sources; GAPS Q25).
//
// Data in, data out: planning calls it after validation, and admission calls the same
// policy before it builds an `acquire_models` effect, so the two can't disagree. Nothing
// here touches the network: a file can only be acquired from the source its recipe pins
// (spec §9.2: the agent never names a source or URL).

import type {
  CandidateAcquisition,
  CheckResult,
  EnvironmentSnapshot,
  ModelSource,
  PlanBlockers,
  PlanCandidate,
  Recipe,
  TaskSpec,
} from "./schemas.js";

/** At most this much is downloaded under one approval (GAPS Q25: 40 GB). */
export const MAX_ACQUISITION_BYTES = 40 * 1024 ** 3;
/** At least this much disk stays free after each placed file (GAPS Q25: 50 GB). */
export const MIN_FREE_DISK_BYTES = 50 * 1024 ** 3;

/** One file the policy is asked about. */
export interface AcquisitionCandidateFile {
  folder: string;
  file: string;
  source: ModelSource;
}

/** Why the policy refuses, sorted into the plan's blocker groups (spec §9.5). */
export interface AcquisitionRefusal {
  group: keyof PlanBlockers;
  message: string;
}

/** The policy's answer for a set of files: the bound it applied either way. */
export type AcquisitionPolicyResult =
  | { allowed: true; totalBytes: number; maxBytes: number }
  | { allowed: false; totalBytes: number; maxBytes: number; refusals: AcquisitionRefusal[] };

/** Bytes as the approval and the agent read them. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${bytes} B`;
}

/**
 * The acquisition policy (GAPS Q25): Hugging Face sources only, `.safetensors` only (a
 * pickle format can run code when loaded), the task's `modelDownloads` not `forbidden`, and
 * the total within the task's `maxDownloadBytes` and 40 GB, whichever is lower. Approval is
 * always needed besides; `allowed` and `approval_required` both pass here.
 */
export function acquisitionPolicy(
  task: Pick<TaskSpec, "constraints" | "budgets">,
  files: readonly AcquisitionCandidateFile[],
): AcquisitionPolicyResult {
  const refusals: AcquisitionRefusal[] = [];
  const taskMax = task.budgets.maxDownloadBytes;
  const maxBytes = taskMax === undefined ? MAX_ACQUISITION_BYTES : Math.min(taskMax, MAX_ACQUISITION_BYTES);
  const totalBytes = files.reduce((sum, f) => sum + f.source.sizeBytes, 0);
  if (task.constraints.modelDownloads === "forbidden") {
    refusals.push({
      group: "policy_conflicts",
      message: `downloads forbidden by the task (constraints.modelDownloads): ${files.map((f) => `${f.folder}/${f.file}`).join(", ")}`,
    });
  }
  for (const f of files) {
    if (f.source.kind !== "huggingface") {
      refusals.push({ group: "policy_conflicts", message: `${f.folder}/${f.file}: source kind ${f.source.kind} isn't an approved source` });
    }
    if (!f.source.path.toLowerCase().endsWith(".safetensors")) {
      refusals.push({ group: "policy_conflicts", message: `${f.folder}/${f.file}: not .safetensors (${f.source.path}); only .safetensors files are downloaded` });
    }
  }
  if (totalBytes > maxBytes) {
    refusals.push({
      group: "resource_limits",
      message:
        `over the size limit: ${formatBytes(totalBytes)} to download, at most ${formatBytes(maxBytes)} ` +
        (taskMax !== undefined && taskMax < MAX_ACQUISITION_BYTES ? "(the task's budgets.maxDownloadBytes)" : "per approval (GAPS Q25)"),
    });
  }
  return refusals.length === 0 ? { allowed: true, totalBytes, maxBytes } : { allowed: false, totalBytes, maxBytes, refusals };
}

/** What `deriveAcquisition` reads of a candidate. */
export type AcquisitionCandidateView = Pick<PlanCandidate, "validation" | "bindings">;

/**
 * Whether a candidate is `acquirable`, from its checks, the recipe and the snapshot it was
 * validated on. Acquirable means: the overall verdict is `fail`; every failing hard check is
 * a model-file check (`dependencies.model.<slot>`, or `native_types.combo.<node>.<input>`
 * on that slot's loader input) of a slot whose file the target's answered folder doesn't
 * list; no hard check is unknown, because then the candidate wouldn't be feasible after the
 * download either; each such file has a `modelSources` entry for its folder and name; and
 * the policy accepts them together. `refusals` says why not when only the files stood in
 * the way, and is empty when something else blocks the candidate (its checks say what).
 */
export function deriveAcquisition(input: {
  recipe: Recipe;
  task: Pick<TaskSpec, "constraints" | "budgets">;
  candidate: AcquisitionCandidateView;
  /** The snapshot the checks were made against; undefined when it isn't stored. */
  snapshot: Pick<EnvironmentSnapshot, "installedModels"> | undefined;
}): { acquirable: true; acquisition: CandidateAcquisition } | { acquirable: false; refusals: AcquisitionRefusal[] } {
  const { recipe, task, candidate, snapshot } = input;
  const notAcquirable = (refusals: AcquisitionRefusal[] = []) => ({ acquirable: false as const, refusals });
  const checks = candidate.validation.checks;
  if (!checks.some((c) => c.hard && c.verdict === "fail")) return notAcquirable();
  if (checks.some((c) => c.hard && c.verdict === "unknown")) return notAcquirable();

  const modelSlots = recipe.slots.filter((s) => s.valueType === "model_file");
  const slotOf = (c: CheckResult) =>
    modelSlots.find((s) => c.id === `dependencies.model.${s.id}` || c.id === `native_types.combo.${s.target.node}.${s.target.input}`);
  const failing = checks.filter((c) => c.hard && c.verdict === "fail");
  const slots = new Set<(typeof modelSlots)[number]>();
  for (const c of failing) {
    const slot = slotOf(c);
    if (slot === undefined) return notAcquirable();
    slots.add(slot);
  }

  const refusals: AcquisitionRefusal[] = [];
  const files: CandidateAcquisition["files"] = [];
  for (const slot of slots) {
    // A loader that doesn't offer a file the folder lists isn't fixed by downloading it
    // again (GAPS Q13): only a file the dependencies layer found missing counts.
    if (!checks.some((c) => c.id === `dependencies.model.${slot.id}` && c.verdict === "fail")) return notAcquirable();
    const folder = slot.modelFolder ?? "";
    const file = candidate.bindings[slot.id];
    if (typeof file !== "string") return notAcquirable();
    const installed = snapshot?.installedModels;
    if (installed === undefined) {
      refusals.push({ group: "missing_dependencies", message: `${folder}/${file}: the snapshot the candidate was checked on isn't available` });
      continue;
    }
    if (!Object.hasOwn(installed.folders, folder)) {
      // Absent: ComfyUI registers no such folder, so a file placed there would never be listed.
      refusals.push({ group: "missing_dependencies", message: `${folder}/${file}: the target has no model folder ${folder} to place it in` });
      continue;
    }
    if (files.some((f) => f.folder === folder && f.file === file)) continue;
    const pinned = (recipe.modelSources ?? []).find((m) => m.folder === folder && m.file === file);
    if (pinned === undefined) {
      refusals.push({ group: "missing_dependencies", message: `no pinned source for ${folder}/${file} in recipe ${recipe.id} r${recipe.revision}` });
      continue;
    }
    files.push({ slot: slot.id, folder, file, source: pinned.source });
  }
  if (refusals.length > 0) return notAcquirable(refusals);
  if (files.length === 0) return notAcquirable();
  const verdict = acquisitionPolicy(task, files);
  if (!verdict.allowed) return notAcquirable(verdict.refusals);
  return { acquirable: true, acquisition: { files, totalBytes: verdict.totalBytes } };
}
