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
  resetObjectInfoCache,
} from "../../comfyui/client.js";
import type { ComfyUINodeDef, ObjectInfo, SystemStats } from "../../comfyui/types.js";
import { isApiNode, isExternalServiceNode } from "../api-nodes.js";
import { resolveOllamaHost, warmOllama } from "../ollama-vram.js";
import { type CancelQueuedResult, cancelQueuedJob } from "../queue-manager.js";
import { WorkflowExecutionError } from "../../utils/errors.js";
import { resolveToolSurfacePolicy, toolAllowed } from "../../tools/tool-surface-filter.js";
import { config, getComfyUIBaseUrl, isOwnHostAddress } from "../../config.js";
import { sharpUnavailableMessage, tryLoadSharp } from "../sharp-loader.js";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  type LocalModel,
  type ModelListingCoverage,
  listLocalModelsWithCoverage,
  localDownloadCacheIdentity,
  resolveDownloadTarget,
  shouldDispatchDownloadToManager,
} from "../model-resolver.js";
import {
  type DownloadJob,
  cancelDownloadJob,
  describeUnresolvedDownload,
  getDownloadJob,
  startDownloadJob,
} from "../download-jobs.js";
import { readDownloadProgress } from "../download-progress.js";
import { downloadFetch } from "../download-proxy.js";
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
  /**
   * Decode an image fully with sharp and return its pixel size. Throws when the data
   * doesn't decode (a truncated or corrupt file); throws ImageDecoderUnavailableError when
   * sharp can't be loaded, which says nothing about the file.
   */
  decodeImage(bytes: Buffer): Promise<{ width: number; height: number }>;
  /**
   * Whether a host is this machine: loopback, or an address of one of its interfaces
   * (upstream's `isOwnHostAddress`). False also for a name, which it doesn't resolve.
   */
  isOwnHostAddress(host: string): boolean;
  /** The Ollama host upstream would talk to (OLLAMA_HOST or the default). */
  ollamaHost(): string;
  /**
   * Load a model into Ollama with a keep-alive, by upstream's warm-up request. True when
   * Ollama answered OK; false only says the load wasn't confirmed (upstream swallows the
   * error), so the caller checks /api/ps before it reports the model as loaded or not.
   */
  loadOllama(host: string, model: string, keepAlive: string): Promise<boolean>;
  /**
   * Where upstream's downloader would write `<subfolder>/<file>` (its `resolveDownloadTarget`,
   * the resolver the write itself uses): `path` the absolute file path, `root` the directory
   * that holds the subfolder's directory, which for a one-segment folder is the model root.
   * Throws when upstream refuses the destination or can't resolve a local models directory.
   */
  resolveModelDestination(subfolder: string, file: string): Promise<{ root: string; path: string }>;
  /** Whether upstream would hand a download to ComfyUI-Manager instead of writing it locally. */
  downloadRoutesToManager(): Promise<boolean>;
  /**
   * Start a local download job (upstream's `startDownloadJob`) of `url` into
   * `<subfolder>/<filename>`, never through ComfyUI-Manager and with no auth override, so
   * upstream applies its own token rules. Returns the job's public id; a request already in
   * flight returns that job's id.
   */
  startDownload(args: { url: string; subfolder: string; filename: string; modelRoot?: string }): Promise<{ jobId: string }>;
  /** A download job's state; see `DownloadStatus`. Never throws for a job it can't find. */
  downloadStatus(jobId: string): Promise<DownloadStatus>;
  /** Abort a download job this process owns (upstream's `cancelDownloadJob`). */
  cancelDownload(jobId: string): Promise<{ cancelled: boolean; message: string }>;
  /**
   * Drop upstream's cached /object_info, so the next read sees what ComfyUI offers now: a
   * model file placed a moment ago shows up in its loader's choices only after this.
   */
  forgetNodeSchemas(): void;
  /**
   * Where upstream's downloader keeps `url` in its download cache, derived by the function
   * the writer itself uses (`localDownloadCacheIdentity`, no auth override): the cache
   * directory, the completed entry, its hidden `.partial` while the transfer runs, and the
   * entry's Content-Type sidecar. The writer downloads into the cache first and then links
   * or copies the entry into the destination; the entry stays unless upstream's LRU limit
   * (COMFYUI_LRU_CACHE_SIZE_GB) evicts it.
   */
  downloadCacheEntry(url: string): { dir: string; cachePath: string; partialPath: string; contentTypeSidecar: string };
  /**
   * A fetch with upstream's download network route: the same proxy decision
   * (`download-proxy.ts`) its downloader makes for this URL, so a check before a download
   * sees the hosts the download will see.
   */
  downloadFetch(url: string, init: RequestInit): Promise<Response>;
  /** The Hugging Face token upstream would send (HF_TOKEN, HUGGINGFACE_TOKEN or its env file). */
  huggingfaceToken(): string | undefined;
}

/**
 * A download job as upstream's registry reports it. `missing`: no record of the job, in
 * this process or persisted (a job of a previous process may be gone). `unknown`: a record
 * exists but upstream won't pick one (two live downloads share the id), which says nothing
 * about whether it finished (#796). `bytes` and `totalBytes` are the progress upstream's
 * tray rows show, present only where upstream writes them (a panel channel directory).
 */
export interface DownloadStatus {
  status: "downloading" | "done" | "error" | "cancelled" | "missing" | "unknown";
  path?: string;
  bytes?: number;
  totalBytes?: number;
  error?: string;
}

/**
 * Whether upstream's operator preset withholds a tool when nothing else is configured: the
 * check managed mode uses to refuse an allow list that would re-admit such a tool (#873).
 */
export function presetWithholds(preset: string, toolName: string): boolean {
  return !toolAllowed(toolName, resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: preset }));
}

/** sharp couldn't be loaded, so no image was decoded: not a verdict on the image. */
export class ImageDecoderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageDecoderUnavailableError";
  }
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
        return isComfyRefusal(err) ? { kind: "rejected", message } : { kind: "unknown", message };
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
    decodeImage: async (bytes) => {
      const loaded = await tryLoadSharp();
      if (!loaded.ok) throw new ImageDecoderUnavailableError(sharpUnavailableMessage("Image decoding", loaded.err));
      const { info } = await loaded.sharp(bytes).raw().toBuffer({ resolveWithObject: true });
      return { width: info.width, height: info.height };
    },
    isOwnHostAddress: (host) => isOwnHostAddress(host),
    ollamaHost: () => resolveOllamaHost(),
    loadOllama: (host, model, keepAlive) => warmOllama(host, model, keepAlive),
    resolveModelDestination: async (subfolder, file) => {
      // The URL only names the file when `filename` is omitted; it is always given here.
      const target = await resolveDownloadTarget("https://huggingface.co/", subfolder, file);
      return { root: dirname(target.targetDir), path: target.targetPath };
    },
    downloadRoutesToManager: () => shouldDispatchDownloadToManager(),
    startDownload: async ({ url, subfolder, filename, modelRoot }) => {
      // dispatchToManagerOverride=false: the route is decided here, never left to upstream,
      // so a Manager dispatch (a server-side write nobody can hash first) can't happen.
      const entry = await startDownloadJob(url, subfolder, filename, undefined, undefined, false, modelRoot);
      return { jobId: entry.job.id };
    },
    downloadStatus: async (jobId) => downloadStatusOf(jobId, getDownloadJob(jobId)),
    cancelDownload: async (jobId) => {
      const r = cancelDownloadJob(jobId);
      if (r.aborted || r.reclaimed) return { cancelled: true, message: `download ${jobId} aborted` };
      if (r.found && r.status !== undefined && r.status !== "downloading") return { cancelled: true, message: `download ${jobId} had already stopped (${r.status})` };
      if (!r.found) return { cancelled: false, message: `no download ${jobId} is known to upstream` };
      return {
        cancelled: false,
        message: r.ambiguous
          ? `download ${jobId} names more than one transfer; none was aborted`
          : `download ${jobId} belongs to another process${r.reclaimDenied ? ` (${r.reclaimDenied})` : ""}; it wasn't aborted`,
      };
    },
    forgetNodeSchemas: () => resetObjectInfoCache(),
    downloadCacheEntry: (url) => {
      const id = localDownloadCacheIdentity(url);
      return {
        dir: dirname(id.cachePath),
        cachePath: id.cachePath,
        partialPath: id.partialPath,
        // download-cache.ts `cacheCtSidecar`, which upstream doesn't export.
        contentTypeSidecar: join(dirname(id.cachePath), `.${basename(id.cachePath)}.ct`),
      };
    },
    downloadFetch: (url, init) => downloadFetch(url, init),
    huggingfaceToken: () => config.huggingfaceToken?.trim() || undefined,
  };
}

/**
 * Map upstream's job record to `DownloadStatus`. A Manager dispatch, which Architect never
 * starts, reads as an error, since its file can't be hashed before placement; a record whose
 * writer process is proven gone reads as an error too, because nothing will finish it.
 */
export function downloadStatusOf(jobId: string, job: DownloadJob | undefined): DownloadStatus {
  if (!job) {
    const why = describeUnresolvedDownload(jobId);
    return why === undefined ? { status: "missing" } : { status: "unknown", error: why };
  }
  const progress = readDownloadProgress(job.progressId ?? job.trayId);
  const counts = {
    ...(progress && Number.isFinite(progress.downloaded) ? { bytes: progress.downloaded } : {}),
    ...(progress && Number.isFinite(progress.total) && progress.total > 0 ? { totalBytes: progress.total } : {}),
  };
  if (job.viaManager) return { status: "error", error: `download ${jobId} was dispatched to ComfyUI-Manager`, ...counts };
  if (job.status === "downloading" && job.writerProvenGone) {
    return { status: "error", error: `the process writing download ${jobId} is gone`, ...counts };
  }
  return {
    status: job.status,
    ...(job.path ? { path: job.path } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...counts,
  };
}

// The details upstream's `buildEnqueueError` attaches to the WorkflowExecutionError it
// builds from a JSON error body: the HTTP status, ComfyUI's `error` and its `node_errors`.
const EnqueueErrorDetails = z.object({ status: z.number() }).passthrough();

/**
 * Whether a failed POST /prompt is ComfyUI's own refusal, which proves the prompt wasn't
 * queued. ComfyUI answers a prompt that fails validation with HTTP 400. Upstream also
 * builds a WorkflowExecutionError from any JSON `{error: {message}}` body, which a gateway
 * sends with a 502 or 504 while ComfyUI may have queued the prompt, so only a 400 counts;
 * every other failure stays open and is reconciled by prompt id (spec §15.4).
 */
export function isComfyRefusal(err: unknown): boolean {
  if (!(err instanceof WorkflowExecutionError)) return false;
  const details = EnqueueErrorDetails.safeParse(err.details);
  return details.success && details.data.status === 400;
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
