// The one facade through which Architect code reaches upstream (spec §5.1, AGENTS).
//
// Architect never imports upstream tool handlers and never calls its own process over MCP
// or HTTP. It depends on this interface, and tests inject a fake. The interface grows only
// with what an Architect feature needs; each method is a thin pass-through, so a change in
// upstream surfaces here as a type error rather than as drift inside the domain code.
//
// Kept free of Architect-specific logic so it can be offered upstream as-is (GAPS Q8).

import {
  enqueuePrompt,
  fetchImage,
  getHistory,
  getObjectInfo,
  getQueueVerified,
  getSystemStats,
  type HistoryEntry,
  interrupt,
} from "../../comfyui/client.js";
import type { ComfyUINodeDef, ObjectInfo, SystemStats } from "../../comfyui/types.js";
import { isApiNode, isExternalServiceNode } from "../api-nodes.js";
import { resolveOllamaHost, unloadAllOllama } from "../ollama-vram.js";
import { type CancelQueuedResult, cancelQueuedJob } from "../queue-manager.js";
import { WorkflowExecutionError } from "../../utils/errors.js";
import { getComfyUIBaseUrl } from "../../config.js";
import {
  type LocalModel,
  type ModelListingCoverage,
  listLocalModelsWithCoverage,
} from "../model-resolver.js";
import type { InstalledModels } from "./schemas.js";

export interface UpstreamFacade {
  /** The base URL of the ComfyUI target upstream is configured for. */
  comfyuiBaseUrl(): string;
  /** ComfyUI's /system_stats. Throws when the target can't be read. */
  systemStats(): Promise<SystemStats>;
  /** ComfyUI's /object_info: every node class the target has loaded. Throws on failure. */
  objectInfo(): Promise<ObjectInfo>;
  /**
   * Installed model files by folder, as ComfyUI reported them. Throws when the listing
   * verified nothing: no folder answered, or upstream refused it as stale.
   */
  installedModels(): Promise<InstalledModels>;
  /**
   * Whether a node spends money or sends data to a remote service: upstream's own rule
   * (ComfyUI API nodes, marked external-service nodes, known paid packs, nodes that ask for
   * a credential), so Architect's policy check matches what upstream already warns about.
   */
  isPaidNode(def: ComfyUINodeDef): boolean;
  /**
   * POST /prompt with a client-chosen prompt id. Classifies the outcome instead of throwing,
   * because only ComfyUI answering with a refusal proves the job wasn't queued: a lost or
   * unreadable response leaves it open (spec §15.4).
   */
  submitPrompt(graph: Record<string, unknown>, promptId: string): Promise<SubmitOutcome>;
  /** The prompt ids running and pending. Throws when /queue can't be read: never "empty". */
  queue(): Promise<{ running: string[]; pending: string[] }>;
  /** /history for one prompt id; undefined when ComfyUI has no entry. Throws when unreadable. */
  history(promptId: string): Promise<HistoryEntry | undefined>;
  /** Remove a pending prompt, reading /queue on both sides (upstream's verified cancel). */
  dequeue(promptId: string): Promise<CancelQueuedResult>;
  /** POST /interrupt with a prompt id: ComfyUI stops the running job only if it has that id. */
  interruptPrompt(promptId: string): Promise<void>;
  /** An output file's bytes, through /view. */
  outputFile(ref: { filename: string; subfolder: string; type: "output" | "temp" }): Promise<{ bytes: Buffer; mimeType: string }>;
  /** The Ollama host upstream would talk to (OLLAMA_HOST or the default). */
  ollamaHost(): string;
  /** Ask Ollama to unload every resident model; returns the names it asked about. */
  unloadOllama(host: string): Promise<string[]>;
}

/** What a POST /prompt established. */
export type SubmitOutcome =
  | { kind: "accepted"; promptId: string; rejectedOutputs?: string }
  /** ComfyUI answered and refused the prompt (its validation, `node_errors`). */
  | { kind: "rejected"; message: string }
  /** Nothing settles whether the job was queued: no response, or one that can't be read. */
  | { kind: "unknown"; message: string };

/** The facade over upstream's live services. */
export function createUpstreamFacade(): UpstreamFacade {
  return {
    comfyuiBaseUrl: () => getComfyUIBaseUrl(),
    systemStats: () => getSystemStats({ diagnosticContext: "environment" }),
    objectInfo: () => getObjectInfo(),
    installedModels: async () => installedModelsFromListing(await listLocalModelsWithCoverage()),
    isPaidNode: (def) => isApiNode(def) || isExternalServiceNode(def),
    submitPrompt: async (graph, promptId) => {
      try {
        const r = await enqueuePrompt(graph, undefined, { promptId });
        return { kind: "accepted", promptId: r.prompt_id, ...(r.rejectedOutputs ? { rejectedOutputs: r.rejectedOutputs } : {}) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Only a WorkflowExecutionError is ComfyUI's own refusal with its validation body.
        // Every other failure, a generic non-2xx included, could come from something between
        // us and ComfyUI, so it stays open and is reconciled by prompt id.
        return err instanceof WorkflowExecutionError ? { kind: "rejected", message } : { kind: "unknown", message };
      }
    },
    queue: async () => {
      const q = await getQueueVerified();
      return { running: q.queue_running.map((item) => item[1]), pending: q.queue_pending.map((item) => item[1]) };
    },
    history: async (promptId) => (await getHistory(promptId))[promptId],
    dequeue: (promptId) => cancelQueuedJob(promptId),
    interruptPrompt: (promptId) => interrupt(promptId),
    outputFile: async (ref) => {
      const r = await fetchImage(ref.filename, ref.type, ref.subfolder);
      return { bytes: Buffer.from(r.base64, "base64"), mimeType: r.mimeType };
    },
    ollamaHost: () => resolveOllamaHost(),
    unloadOllama: (host) => unloadAllOllama(host),
  };
}

/**
 * Legacy folder names whose files upstream's object_info fallback files under the current
 * name (`canonicalObjectInfoCategory` in model-resolver.ts). Fallback entries are never
 * typed with the legacy name, so a legacy folder that answered but holds no entries may
 * have had its files moved to the current folder.
 */
const LEGACY_FOLDER_CURRENT: Readonly<Record<string, string>> = {
  unet: "diffusion_models",
  clip: "text_encoders",
};

/**
 * ComfyUI-GGUF's views and the folders they read (`GGUF_BACKING_DIRS` in
 * model-resolver.ts). Upstream de-duplicates a view's `.gguf` entry against the same name
 * already listed under a backing folder, which the listing scans first, so the view's own
 * entries can be missing files it listed.
 */
const GGUF_VIEW_BACKING: Readonly<Record<string, readonly string[]>> = {
  unet_gguf: ["unet", "diffusion_models"],
  clip_gguf: ["text_encoders", "clip"],
};

/**
 * Turn upstream's model listing into `InstalledModels`, keeping what ComfyUI verified
 * apart from what it didn't (#796, #918).
 *
 * - `folders` holds the folders in `coverage.answered`, less those the third rule moves
 *   to `unanswered`, each with the sorted,
 *   de-duplicated names of the entries ComfyUI listed for it. An answered folder with no
 *   entries maps to `[]`: an OK response with an empty array, a verified fact. For a
 *   category upstream discovered beyond its core list, upstream keeps only weight files
 *   (`WEIGHT_EXTS`), so its list is the model files in it, not every file.
 * - Only HTTP entries count. Upstream writes their `path` as `<type>/<name>`; the
 *   filesystem fallback (`usedFilesystem`) writes an absolute path and runs when HTTP
 *   listed no file at all, scanning answered and unanswered folders alike. Counting those
 *   entries would fill an unanswered folder from this host's disk, or contradict an empty
 *   answer from ComfyUI, so they are ignored; an unanswered folder stays unanswered.
 * - An answered folder whose entries upstream may have filed under another folder can't
 *   be shown complete, so it moves to `unanswered` with the reason, never to a short or
 *   empty `folders` entry: a legacy folder with no entries while its current folder has
 *   some, and a GGUF view while a backing folder lists a `.gguf` file.
 * - `unanswered` and `absent` come from the coverage. A folder named in more than one
 *   list keeps the least certain: unanswered before absent before answered.
 * - A listing upstream refused as stale (`targetChanged`, `localPathRecovered`) has its
 *   coverage cleared, and one in which no folder answered or was absent verified nothing.
 *   Both throw: an empty `InstalledModels` would read as "no models registered".
 */
export function installedModelsFromListing(listing: {
  models: readonly LocalModel[];
  coverage: ModelListingCoverage;
}): InstalledModels {
  const { models, coverage } = listing;
  if (coverage.targetChanged) {
    throw new Error(
      `the ComfyUI target changed from ${coverage.targetChanged.startedBaseUrl} to ` +
        `${coverage.targetChanged.currentBaseUrl} during the model listing; list again`,
    );
  }
  if (coverage.localPathRecovered) {
    throw new Error("the local ComfyUI path was filled in during the model listing; list again");
  }
  const absentRaw = coverage.absent ?? [];
  if (coverage.answered.length === 0 && absentRaw.length === 0) {
    const why = coverage.httpUnavailable ?? coverage.unanswered[0]?.reason ?? "no folder was listed";
    throw new Error(`no model folder answered: ${why}`);
  }

  const namesByType = new Map<string, Set<string>>();
  for (const m of models) {
    if (m.path !== `${m.type}/${m.name}`) continue; // a filesystem-fallback entry
    let names = namesByType.get(m.type);
    if (!names) namesByType.set(m.type, (names = new Set()));
    names.add(m.name);
  }
  const entriesOf = (folder: string): ReadonlySet<string> => namesByType.get(folder) ?? new Set();

  const unanswered = new Map<string, string>();
  for (const u of coverage.unanswered) {
    if (!unanswered.has(u.dir)) unanswered.set(u.dir, u.reason);
  }
  const absent = new Set(absentRaw.filter((f) => !unanswered.has(f)));

  const folders: Record<string, string[]> = {};
  for (const folder of new Set(coverage.answered)) {
    if (unanswered.has(folder) || absent.has(folder)) continue;
    const own = entriesOf(folder);
    const key = folder.toLowerCase();
    const current = LEGACY_FOLDER_CURRENT[key];
    if (current !== undefined && own.size === 0 && entriesOf(current).size > 0) {
      unanswered.set(
        folder,
        `answered, but upstream may list its files under ${current}; its own contents are unknown`,
      );
      continue;
    }
    const backing = GGUF_VIEW_BACKING[key] ?? [];
    const sharing = backing.filter((b) => [...entriesOf(b)].some((n) => n.toLowerCase().endsWith(".gguf")));
    if (sharing.length > 0) {
      unanswered.set(
        folder,
        `answered, but upstream de-duplicates its .gguf files against ${sharing.join(", ")}; ` +
          "its own contents are unknown",
      );
      continue;
    }
    folders[folder] = [...own].sort();
  }

  return {
    folders,
    unanswered: [...unanswered].map(([folder, reason]) => ({ folder, reason })),
    absent: [...absent].sort(),
  };
}
