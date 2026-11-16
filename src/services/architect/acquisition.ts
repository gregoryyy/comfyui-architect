// Approved model downloads: staging, verification and placement (TODO 4.4, 4.5; ARCH
// 2026-11-16, redirects, placement and after acquisition; GAPS Q25; SEC T4, T9).
//
// A run whose action plan carries an `acquire_models` effect acquires its files in
// PREPARING, one at a time, in the effect's order. For each file:
// - the URL is built from the pinned source only (`https://huggingface.co/<repo>/resolve/
//   <commit>/<path>`); the agent never supplies one (spec §9.2);
// - Architect follows the redirect chain itself with HEAD requests, allowing only https and
//   Hugging Face's hosts, then hands upstream's downloader the pinned URL. Upstream follows
//   the chain again unchecked; the sha256 below rejects any other content;
// - upstream downloads into its own download cache, then links or copies the entry into the
//   destination folder itself under a staged name, `<file>.architect-<run id>`, which no
//   loader lists, since ComfyUI lists only files with a model extension. The staged file is
//   resolved by the same upstream call as the destination, so both sit in the folder
//   upstream resolves for the category, also when the server's extra model paths move that
//   category to another root, and `link` places it on the same filesystem. Free disk
//   is checked on the model root's disk and the cache's, counting other runs' unfinished
//   downloads as reserved; after placement Architect removes upstream's cache copy of that
//   one file, which upstream would otherwise keep;
// - Architect hashes the staged file and compares sha256 and size with the pin; only a
//   match is placed, by `link` then `unlink`, so an existing file is never overwritten.
//
// Nothing here holds a lock across a download: `step` starts a job and returns, and the
// controller's next poll reads the job's state. All I/O comes in through `AcquisitionIo`,
// so the tests run on temporary folders with a fake downloader and a fake Hugging Face.

import { createHash } from "node:crypto";
import { constants as fsConstants, statfsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { formatBytes } from "./acquisition-policy.js";
import {
  type AcquireModelsEffect,
  type AcquisitionRecord,
  type AcquisitionState,
  type ArchitectErrorCode,
  FINAL_ACQUISITION_STATES,
  type ModelSource,
  type RunRecord,
} from "./schemas.js";
import { type AcquisitionPatch, type ArchitectStore, StoreConflictError } from "./store.js";
import type { DownloadStatus, UpstreamFacade } from "./upstream.js";

/**
 * Extensions ComfyUI's folder listing offers to loaders (`folder_paths.supported_pt_extensions`,
 * plus `.gguf` for ComfyUI-GGUF). A staged name must not end in one, or a loader would list
 * the unverified file.
 */
export const MODEL_FILE_EXTENSIONS: readonly string[] = [".safetensors", ".pth", ".ckpt", ".pt", ".pt2", ".bin", ".pkl", ".sft", ".gguf"];
/** Redirects followed before the chain is refused (ARCH 2026-11-16, redirects). */
export const MAX_REDIRECT_HOPS = 5;
/** Download attempts per file: the first and two restarts (TODO 4.5.3). */
export const MAX_DOWNLOAD_ATTEMPTS = 3;
/** The only endpoint upstream may use for Hugging Face; another one would rewrite the host. */
export const HF_ORIGIN = "https://huggingface.co";
const PREFLIGHT_TIMEOUT_MS = 30_000;

/** The facade methods acquisition uses. */
export type AcquisitionFacade = Pick<
  UpstreamFacade,
  | "resolveModelDestination"
  | "downloadRoutesToManager"
  | "startDownload"
  | "downloadStatus"
  | "cancelDownload"
  | "forgetNodeSchemas"
  | "downloadCacheEntry"
  | "huggingfaceToken"
>;

/** A HEAD request without following redirects: the subset of `fetch` the preflight uses. */
export type HeadFetch = (
  url: string,
  init: { method: "HEAD"; redirect: "manual"; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

/** File operations acquisition performs; node:fs by default, injectable for tests. */
/** A file's identity on disk: placement compares it before and after the link. */
export interface FileIdentity {
  dev: number;
  ino: number;
}

/** What hashing a file read from the open handle: its digest, size and identity. */
export interface HashedFile extends FileIdentity {
  sha256: string;
  bytes: number;
}

export interface AcquisitionFs {
  lstat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; dev: number; ino: number }>;
  realpath(path: string): Promise<string>;
  link(existing: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  /**
   * sha256 and size of a regular file, read without following a symbolic link, with the
   * device and inode of the open handle (fstat), so the bytes hashed are tied to one file.
   */
  hashFile(path: string): Promise<HashedFile>;
  /**
   * Bytes available to this user on the filesystem holding `path` (statfs bavail * bsize),
   * read at its nearest existing ancestor, since a cache directory may not exist yet.
   */
  freeDiskBytes(path: string): Promise<number>;
  /** The device id of the filesystem holding `path`, at its nearest existing ancestor. */
  deviceOf(path: string): Promise<number>;
}

/** Everything acquisition reaches outside the process. */
export interface AcquisitionIo {
  facade: AcquisitionFacade;
  /** HEAD requests for the preflight; live, upstream's download fetch with its proxy route. */
  fetch: HeadFetch;
  fs: AcquisitionFs;
  /** The environment: `HF_ENDPOINT` is read from it. */
  env: Readonly<Record<string, string | undefined>>;
}

/** sha256 and size of a file opened with O_NOFOLLOW, so a symbolic link is never read through. */
async function hashFileNoFollow(path: string): Promise<HashedFile> {
  const handle = await fsp.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
    }
    return { sha256: hash.digest("hex"), bytes, dev: stat.dev, ino: stat.ino };
  } finally {
    await handle.close();
  }
}

/** The nearest ancestor of `path` that exists (the path itself when it does). */
async function existingAncestor(path: string): Promise<string> {
  let p = resolve(path);
  for (;;) {
    try {
      await fsp.stat(p);
      return p;
    } catch (err) {
      const parent = dirname(p);
      if (errnoOf(err) !== "ENOENT" || parent === p) throw err;
      p = parent;
    }
  }
}

/** node:fs behind `AcquisitionFs`. */
export const NODE_ACQUISITION_FS: AcquisitionFs = {
  lstat: (p) => fsp.lstat(p),
  realpath: (p) => fsp.realpath(p),
  link: (a, b) => fsp.link(a, b),
  unlink: (p) => fsp.unlink(p),
  hashFile: hashFileNoFollow,
  freeDiskBytes: async (p) => {
    const s = await fsp.statfs(await existingAncestor(p));
    return Number(s.bavail) * Number(s.bsize);
  },
  deviceOf: async (p) => (await fsp.stat(await existingAncestor(p))).dev,
};

/**
 * The live I/O: upstream through the facade, its download fetch for the preflight (so the
 * HEADs take the proxy route the download takes), node:fs and process.env.
 */
export function defaultAcquisitionIo(facade: AcquisitionFacade & Pick<UpstreamFacade, "downloadFetch">): AcquisitionIo {
  return { facade, fetch: (url, init) => facade.downloadFetch(url, init), fs: NODE_ACQUISITION_FS, env: process.env };
}

/**
 * Free disk for an approval dialog, read synchronously. A failed read is reported as such,
 * never as a number (#796).
 */
export function freeDiskBytesSync(path: string): { known: true; bytes: number } | { known: false; reason: string } {
  try {
    const s = statfsSync(path);
    return { known: true, bytes: Number(s.bavail) * Number(s.bsize) };
  } catch (err) {
    return { known: false, reason: messageOf(err) };
  }
}

function messageOf(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.trim() === "" ? "(no message)" : m;
}

function errnoOf(err: unknown): string | undefined {
  return err !== null && typeof err === "object" && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

/** The first eight hex digits of a digest, as messages show it. */
function short(hash: string): string {
  return hash.slice(0, 8);
}

// ---------------------------------------------------------------------------------------
// URL and redirect preflight (TODO 4.4)

/** The commit-pinned download URL of a source; each path segment is encoded. */
export function pinnedUrl(source: ModelSource): string {
  const path = source.path.split("/").map(encodeURIComponent).join("/");
  return `${HF_ORIGIN}/${source.repo}/resolve/${source.revision}/${path}`;
}

/** Whether a host is Hugging Face's: huggingface.co, *.huggingface.co or *.hf.co. */
export function isHuggingFaceHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "huggingface.co" || h.endsWith(".huggingface.co") || h.endsWith(".hf.co");
}

/**
 * Upstream rewrites huggingface.co URLs to `HF_ENDPOINT` when it is set (issue #127 there),
 * so the bytes would come from a host the preflight never checked. Undefined when the
 * variable is unset, empty, or Hugging Face itself.
 */
export function hfEndpointRefusal(env: AcquisitionIo["env"]): string | undefined {
  const raw = env.HF_ENDPOINT?.trim().replace(/\/+$/, "");
  if (!raw || raw === HF_ORIGIN) return undefined;
  return `HF_ENDPOINT is set to ${raw}; upstream would download from there instead of ${HF_ORIGIN}, which no approval covers`;
}

/** The preflight's answer: the chain is allowed, refused by policy, or couldn't be read. */
export type PreflightResult =
  /** `headRefused`: the last host refused HEAD (403/405) on a URL Hugging Face redirected to with the pinned size and hash. */
  | { ok: true; finalUrl: string; hops: number; headRefused?: number }
  | { ok: false; refused: true; message: string }
  | { ok: false; refused: false; message: string };

/** What the preflight is given besides the URL. */
export interface PreflightOptions {
  env?: AcquisitionIo["env"];
  /** Upstream's Hugging Face token; sent only to huggingface.co after a 401. */
  token?: string;
  /** The pin, compared with the X-Linked-Size and X-Linked-Etag Hugging Face sends with its redirect. */
  pinned?: Pick<ModelSource, "sha256" | "sizeBytes">;
}

/** An X-Linked-Etag value without quotes or a weak prefix. */
function linkedEtag(raw: string | null): string | undefined {
  const v = raw?.trim().replace(/^W\//, "").replace(/^"|"$/g, "").toLowerCase();
  return v ? v : undefined;
}

/**
 * Follow the redirect chain of `url` with HEAD requests (redirect: "manual"): at most five
 * hops, every URL `https:` on a Hugging Face host, a relative Location resolved against the
 * URL it came from, and a final 2xx answer. The token is sent only to huggingface.co, and
 * only after it answered 401 without one: a token only for gated repositories (GAPS Q25).
 *
 * Hugging Face's redirect to its CDN carries X-Linked-Size and X-Linked-Etag (the file's
 * sha256 for LFS files). With a pin, a mismatch refuses before anything is downloaded; a
 * match lets the last hop answer 403 or 405 instead of 2xx, since a pre-signed CDN URL may
 * be signed for GET only. The sha256 check before placement still decides about the bytes.
 * A request that fails is `refused: false`, a failed observation, never a refusal.
 */
export async function preflightRedirects(url: string, fetchFn: HeadFetch, opts: PreflightOptions = {}): Promise<PreflightResult> {
  const endpoint = hfEndpointRefusal(opts.env ?? {});
  if (endpoint) return { ok: false, refused: true, message: endpoint };
  const token = opts.token?.trim();
  let current = url;
  let withToken = false;
  let linkedMatch = false;
  for (let hop = 0; ; ) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return { ok: false, refused: true, message: `the redirect chain led to an unparsable URL` };
    }
    if (parsed.protocol !== "https:") {
      return { ok: false, refused: true, message: `the redirect chain left https: ${parsed.protocol}//${parsed.host}` };
    }
    if (!isHuggingFaceHost(parsed.hostname)) {
      return { ok: false, refused: true, message: `the redirect chain led to ${parsed.hostname}, which isn't a Hugging Face host` };
    }
    const headers: Record<string, string> = {};
    if (withToken && token && parsed.hostname.toLowerCase() === "huggingface.co") headers.Authorization = `Bearer ${token}`;
    let res: Awaited<ReturnType<HeadFetch>>;
    try {
      res = await fetchFn(parsed.toString(), { method: "HEAD", redirect: "manual", headers, signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS) });
    } catch (err) {
      return { ok: false, refused: false, message: `HEAD ${parsed.hostname} failed: ${messageOf(err)}` };
    }
    if (res.status === 401 && token && !withToken && parsed.hostname.toLowerCase() === "huggingface.co") {
      withToken = true;
      continue;
    }
    if (res.status >= 300 && res.status < 400) {
      if (opts.pinned && parsed.hostname.toLowerCase() === "huggingface.co") {
        const size = res.headers.get("x-linked-size");
        const etag = linkedEtag(res.headers.get("x-linked-etag"));
        if (size !== null && Number(size) !== opts.pinned.sizeBytes) {
          return { ok: false, refused: true, message: `Hugging Face reports ${size} bytes for this commit and path, the pin says ${opts.pinned.sizeBytes}` };
        }
        if (etag !== undefined && /^[0-9a-f]{64}$/.test(etag) && etag !== opts.pinned.sha256) {
          return { ok: false, refused: true, message: `Hugging Face reports sha256 ${short(etag)}… for this commit and path, the pin says ${short(opts.pinned.sha256)}…` };
        }
        linkedMatch = size !== null && etag === opts.pinned.sha256;
      }
      const location = res.headers.get("location");
      if (!location) return { ok: false, refused: true, message: `${parsed.hostname} answered ${res.status} without a Location` };
      hop += 1;
      if (hop > MAX_REDIRECT_HOPS) {
        return { ok: false, refused: true, message: `the redirect chain is longer than ${MAX_REDIRECT_HOPS} hops (last host ${parsed.hostname})` };
      }
      try {
        current = new URL(location, parsed).toString();
      } catch {
        return { ok: false, refused: true, message: `${parsed.hostname} redirected to an unparsable Location` };
      }
      continue;
    }
    if (res.status >= 200 && res.status < 300) return { ok: true, finalUrl: parsed.toString(), hops: hop };
    if ((res.status === 403 || res.status === 405) && hop > 0 && linkedMatch) {
      return { ok: true, finalUrl: parsed.toString(), hops: hop, headRefused: res.status };
    }
    return {
      ok: false,
      refused: true,
      message:
        `${parsed.hostname} answered ${res.status}` +
        (res.status === 401 || res.status === 403 ? " (a gated repository needs HF_TOKEN and accepted terms)" : ""),
    };
  }
}

// ---------------------------------------------------------------------------------------
// Staging, verification and placement (TODO 4.5.2)

/**
 * The name a run stages a file under, next to its destination: `<file>.architect-<run id>`.
 * Throws if it would end in a model extension (it can't with run ids as Architect makes them;
 * the check keeps it so).
 */
export function stagedNameOf(file: string, runId: string): string {
  const name = `${file}.architect-${runId}`;
  const lower = name.toLowerCase();
  if (MODEL_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))) throw new Error(`the staged name ${name} would look like a model file`);
  return name;
}

/** Whether `child` is `parent` or inside it, by path. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** A refusal or failure of one step, with the reason the record keeps. */
export interface StepRefusal {
  ok: false;
  message: string;
}

/** What a check of a staged file found. */
export type VerifyResult =
  | { kind: "match"; sha256: string; bytes: number; dev: number; ino: number }
  /** The bytes aren't the pinned ones; the staged file has been deleted. */
  | { kind: "mismatch"; sha256?: string; bytes: number; message: string }
  | { kind: "missing" }
  /** The file couldn't be read: nothing was learnt about it, and it stays where it is. */
  | { kind: "unreadable"; message: string };

/**
 * Check a staged file against its pin: a regular file (never a symbolic link), the pinned
 * size, then the pinned sha256, streamed. A mismatch deletes the staged file, so it can't be
 * placed later by mistake.
 */
export async function verifyStaged(fs: AcquisitionFs, stagedPath: string, source: ModelSource): Promise<VerifyResult> {
  let st: Awaited<ReturnType<AcquisitionFs["lstat"]>>;
  try {
    st = await fs.lstat(stagedPath);
  } catch (err) {
    if (errnoOf(err) === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", message: `couldn't read ${stagedPath}: ${messageOf(err)}` };
  }
  const discard = async (result: Extract<VerifyResult, { kind: "mismatch" }>): Promise<VerifyResult> => {
    try {
      await fs.unlink(stagedPath);
    } catch (err) {
      if (errnoOf(err) !== "ENOENT") return { ...result, message: `${result.message}; deleting the staged file failed: ${messageOf(err)}` };
    }
    return result;
  };
  if (st.isSymbolicLink() || !st.isFile()) {
    return discard({ kind: "mismatch", bytes: 0, message: `the staged ${stagedPath} is ${st.isSymbolicLink() ? "a symbolic link" : "not a regular file"}` });
  }
  if (st.size !== source.sizeBytes) {
    return discard({
      kind: "mismatch",
      bytes: st.size,
      message: `size mismatch: expected ${source.sizeBytes} bytes (${formatBytes(source.sizeBytes)}), observed ${st.size}`,
    });
  }
  let hashed: HashedFile;
  try {
    hashed = await fs.hashFile(stagedPath);
  } catch (err) {
    return { kind: "unreadable", message: `couldn't hash ${stagedPath}: ${messageOf(err)}` };
  }
  if (hashed.bytes !== source.sizeBytes || hashed.sha256 !== source.sha256) {
    return discard({
      kind: "mismatch",
      sha256: hashed.sha256,
      bytes: hashed.bytes,
      message: `sha256 mismatch: expected ${short(source.sha256)}…, observed ${short(hashed.sha256)}… (${hashed.bytes} of ${source.sizeBytes} bytes)`,
    });
  }
  return { kind: "match", sha256: hashed.sha256, bytes: hashed.bytes, dev: hashed.dev, ino: hashed.ino };
}

/** What placement did. */
export type PlaceResult =
  | { ok: true; path: string; preexisting: boolean }
  | StepRefusal;

/**
 * Place a verified staged file as `<root>/<folder>/<file>` with `link` and `unlink`, so the
 * destination is created only if it doesn't exist. The staged file must sit in the same
 * folder as the destination. Refused: a staged file that is a symbolic link, and a folder
 * whose real path isn't inside the real path of the root upstream reported for it (SEC
 * T9). That root is the folder's parent, also when an extra model path moves the category:
 * upstream then resolves the configured category directory, and its parent holds it, so
 * the check is on the folder alone. A category directory that is itself a link out of its
 * parent is refused (fail closed). `verified` is the device and inode of the handle that was hashed: the staged file
 * must still be that inode just before the link, and the new destination must be it just
 * after; otherwise only the link just made is removed and placement fails, so a file
 * swapped in after hashing never stays in a model folder. When the destination exists, it
 * is hashed: the pinned bytes count as placed (someone installed the file meanwhile);
 * anything else fails and is left untouched. The staged file is removed either way.
 */
export async function placeStaged(
  fs: AcquisitionFs,
  args: { root: string; folder: string; file: string; stagedPath: string; source: ModelSource; verified: FileIdentity },
): Promise<PlaceResult> {
  const { root, folder, file, stagedPath, source, verified } = args;
  const same = (a: FileIdentity) => a.dev === verified.dev && a.ino === verified.ino;
  const dest = join(root, folder, file);
  const removeStaged = async () => {
    try {
      await fs.unlink(stagedPath);
    } catch {
      // Already gone; it is never placed unverified either way.
    }
  };
  const parent = dirname(dest);
  if (dirname(stagedPath) !== parent) {
    await removeStaged();
    return { ok: false, message: `the staged ${stagedPath} isn't in the destination folder ${parent}; nothing was placed` };
  }
  try {
    const st = await fs.lstat(stagedPath);
    if (st.isSymbolicLink()) {
      await removeStaged();
      return { ok: false, message: `the staged ${stagedPath} is a symbolic link; nothing was placed` };
    }
  } catch (err) {
    return { ok: false, message: `couldn't read the staged file ${stagedPath}: ${messageOf(err)}` };
  }
  try {
    const realRoot = await fs.realpath(root);
    const realParent = await fs.realpath(parent);
    if (!within(realRoot, realParent) || realParent === realRoot) {
      await removeStaged();
      return { ok: false, message: `the model folder ${parent} resolves to ${realParent}, outside ${realRoot}; nothing was placed` };
    }
  } catch (err) {
    return { ok: false, message: `couldn't resolve the model folder ${parent}: ${messageOf(err)}` };
  }
  try {
    const before = await fs.lstat(stagedPath);
    if (before.isSymbolicLink() || !same(before)) {
      await removeStaged();
      return { ok: false, message: `the staged ${stagedPath} was replaced after it was verified; nothing was placed` };
    }
  } catch (err) {
    return { ok: false, message: `couldn't read the staged file ${stagedPath}: ${messageOf(err)}` };
  }
  try {
    await fs.link(stagedPath, dest);
    let placedOk = false;
    try {
      const after = await fs.lstat(dest);
      placedOk = !after.isSymbolicLink() && same(after);
    } catch {
      // Unreadable right after the link: it can't be shown to be the verified file.
    }
    if (!placedOk) {
      // The link just made is Architect's own: the destination didn't exist before it.
      try {
        await fs.unlink(dest);
      } catch (e) {
        await removeStaged();
        return { ok: false, message: `${dest} isn't the verified file after the link, and removing the link failed: ${messageOf(e)}` };
      }
      await removeStaged();
      return { ok: false, message: `the staged file changed between verification and placement; the new link at ${dest} was removed` };
    }
  } catch (err) {
    if (errnoOf(err) !== "EEXIST") {
      return { ok: false, message: `couldn't place ${dest}: ${messageOf(err)}` };
    }
    // Someone else's file, or the pinned one installed meanwhile: hash it, never replace it.
    let existing: HashedFile;
    try {
      const st = await fs.lstat(dest);
      if (st.isSymbolicLink() || !st.isFile()) {
        await removeStaged();
        return { ok: false, message: `${dest} already exists and isn't a regular file; it was left as it is` };
      }
      existing = await fs.hashFile(dest);
    } catch (e) {
      return { ok: false, message: `${dest} already exists and couldn't be read: ${messageOf(e)}; it was left as it is` };
    }
    await removeStaged();
    if (existing.sha256 === source.sha256 && existing.bytes === source.sizeBytes) return { ok: true, path: dest, preexisting: true };
    return {
      ok: false,
      message: `${dest} already exists with other content (sha256 ${short(existing.sha256)}…, pinned ${short(source.sha256)}…); it was left as it is`,
    };
  }
  await removeStaged();
  return { ok: true, path: dest, preexisting: false };
}

// ---------------------------------------------------------------------------------------
// Free disk (GAPS Q25: at least 50 GB stays free)

/** Bytes of a file a download still has to write: its size less the cache `.partial` so far. */
async function remainingBytes(io: AcquisitionIo, rec: AcquisitionRecord): Promise<number> {
  if (rec.state !== "downloading") return rec.source.sizeBytes;
  try {
    const st = await io.fs.lstat(io.facade.downloadCacheEntry(pinnedUrl(rec.source)).partialPath);
    return Math.max(0, rec.source.sizeBytes - st.size);
  } catch {
    // No partial readable: the whole file is still to come, the conservative reading.
    return rec.source.sizeBytes;
  }
}

/**
 * Whether downloading `files` leaves at least `minFreeBytes` free on every disk it writes:
 * the model root's, and upstream's download cache's when that is another device (upstream
 * writes the file into its cache first, then links it into the destination folder on the same
 * device or copies it on another, so a file counts once per device it lands on). The
 * unfinished downloads of other runs count as reserved on their devices. A disk that can't
 * be read is refused, not passed (spec §7.3). Undefined when every disk has room.
 */
export async function diskShortfall(
  io: AcquisitionIo,
  store: Pick<ArchitectStore, "listOpenAcquisitions">,
  files: readonly { destinationRoot: string; source: ModelSource }[],
  minFreeBytes: number,
  opts: { exceptRunId?: string } = {},
): Promise<string | undefined> {
  const devices = new Map<number, { path: string; need: number; reserved: number }>();
  const add = async (path: string, field: "need" | "reserved", bytes: number) => {
    const dev = await io.fs.deviceOf(path);
    const d = devices.get(dev) ?? { path, need: 0, reserved: 0 };
    d[field] += bytes;
    devices.set(dev, d);
    return dev;
  };
  const count = async (root: string, source: ModelSource, field: "need" | "reserved", bytes: number) => {
    const rootDev = await add(root, field, bytes);
    const cacheDir = io.facade.downloadCacheEntry(pinnedUrl(source)).dir;
    if ((await io.fs.deviceOf(cacheDir)) !== rootDev) await add(cacheDir, field, bytes);
  };
  try {
    for (const f of files) await count(f.destinationRoot, f.source, "need", f.source.sizeBytes);
    for (const other of store.listOpenAcquisitions()) {
      if (other.runId === opts.exceptRunId) continue;
      await count(other.destinationRoot, other.source, "reserved", await remainingBytes(io, other));
    }
  } catch (err) {
    return `the disks the download writes couldn't be identified: ${messageOf(err)}`;
  }
  for (const d of devices.values()) {
    let free: number;
    try {
      free = await io.fs.freeDiskBytes(d.path);
    } catch (err) {
      return `the free disk under ${d.path} couldn't be read (${messageOf(err)})`;
    }
    if (free - d.need - d.reserved < minFreeBytes) {
      return (
        `${formatBytes(free)} free on the disk of ${d.path}; ${formatBytes(d.need)} to download` +
        (d.reserved > 0 ? ` and ${formatBytes(d.reserved)} still to come for other runs' downloads` : "") +
        ` would leave less than ${formatBytes(minFreeBytes)}`
      );
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------
// Driving a run's acquisitions (TODO 4.5, 4.5.3)

/** Where a run's acquisitions stand after one step. */
export type AcquisitionProgress =
  | { kind: "in_progress"; records: AcquisitionRecord[] }
  | { kind: "placed"; records: AcquisitionRecord[] }
  | { kind: "failed"; error: { code: ArchitectErrorCode; message: string }; records: AcquisitionRecord[] };

export interface ModelAcquirerDeps {
  store: ArchitectStore;
  io: AcquisitionIo;
  now: () => Date;
  newId: () => string;
}

const AttemptData = z.object({ acquisitionId: z.string(), attempt: z.number().int().positive() });

/** One acquisition's line for a status reply. */
export interface AcquisitionView {
  id: string;
  file: string;
  state: AcquisitionState;
  size: string;
  sizeBytes: number;
  source: string;
  bytesSoFar?: number;
  placedPath?: string;
  error?: string;
}

/** Drives the acquisitions of runs in PREPARING; see the file comment. */
export class ModelAcquirer {
  /** Placements this instance verified; a placement from another process is hashed again. */
  private readonly verified = new Set<string>();

  constructor(private readonly deps: ModelAcquirerDeps) {}

  /** Drop upstream's cached node schemas, so a fresh snapshot sees the placed files. */
  forgetNodeSchemas(): void {
    this.deps.io.facade.forgetNodeSchemas();
  }

  /**
   * One step of a run's acquisitions: create them on first call (from the run's action
   * plan, never from an argument), then move the first unfinished one as far as it goes
   * without waiting for a download. A failed file stops the others.
   */
  async step(run: RunRecord, effect: AcquireModelsEffect): Promise<AcquisitionProgress> {
    const { store } = this.deps;
    let records = store.createAcquisitions({ runId: run.id, now: this.deps.now(), newId: () => this.deps.newId() });
    for (const rec of records) {
      if (FINAL_ACQUISITION_STATES.includes(rec.state)) {
        if (rec.state === "placed") continue;
        break;
      }
      await this.advanceOne(run, effect, rec);
      const now = store.getAcquisition(rec.id);
      if (now?.state !== "placed") break;
    }
    records = store.listAcquisitions(run.id);
    const failed = records.find((r) => r.state === "failed" || r.state === "cancelled");
    if (failed) {
      const error = failed.error ?? { code: "DEPENDENCY_UNAVAILABLE" as const, message: `${failed.folder}/${failed.file} was ${failed.state}` };
      await this.stop(run, { failed: { code: error.code, message: `stopped: ${failed.folder}/${failed.file} failed` } });
      return { kind: "failed", error: { code: error.code, message: `${failed.folder}/${failed.file}: ${error.message}` }, records: store.listAcquisitions(run.id) };
    }
    if (records.every((r) => r.state === "placed")) {
      const recheck = await this.recheckPlaced(run, records);
      if (recheck) return { kind: "failed", error: recheck, records };
      await this.cleanup(run, records);
      return { kind: "placed", records };
    }
    return { kind: "in_progress", records };
  }

  /**
   * Stop a run's unfinished acquisitions: abort the run's own download jobs (by the job ids
   * stored on its acquisitions, never another), delete staged files, and end each record as
   * `cancelled`, or `failed` with the given error. Verifying can't be cancelled, so it fails.
   */
  async stop(run: RunRecord, how: "cancelled" | { failed: { code: ArchitectErrorCode; message: string } }): Promise<void> {
    const records = this.deps.store.listAcquisitions(run.id);
    for (const rec of records) {
      if (FINAL_ACQUISITION_STATES.includes(rec.state)) continue;
      if (rec.state === "downloading" && rec.jobId) {
        let outcome: { cancelled: boolean; message: string };
        try {
          outcome = await this.deps.io.facade.cancelDownload(rec.jobId);
        } catch (err) {
          outcome = { cancelled: false, message: messageOf(err) };
        }
        this.note(run, rec, `download job ${rec.jobId}: ${outcome.message}`, { jobId: rec.jobId, cancelled: outcome.cancelled });
      }
      const to: AcquisitionState = how === "cancelled" && rec.state !== "verifying" ? "cancelled" : "failed";
      const error =
        how === "cancelled"
          ? { code: "DEPENDENCY_UNAVAILABLE" as const, message: "the run was cancelled before this file was verified" }
          : how.failed;
      this.move(run, rec, to, to === "failed" ? { error } : {}, how === "cancelled" ? "the run was cancelled" : error.message);
    }
    await this.cleanup(run, this.deps.store.listAcquisitions(run.id));
  }

  /** The run's acquisitions for a status reply, with the bytes so far where upstream reports them. */
  async view(runId: string): Promise<AcquisitionView[]> {
    const out: AcquisitionView[] = [];
    for (const r of this.deps.store.listAcquisitions(runId)) {
      let bytesSoFar: number | undefined;
      if (r.state === "downloading" && r.jobId) {
        try {
          bytesSoFar = await this.bytesSoFar(r, await this.deps.io.facade.downloadStatus(r.jobId));
        } catch {
          // Progress is shown only when upstream reports it; its absence claims nothing.
        }
      }
      out.push(acquisitionView(r, bytesSoFar));
    }
    return out;
  }

  private async advanceOne(run: RunRecord, effect: AcquireModelsEffect, rec: AcquisitionRecord): Promise<void> {
    switch (rec.state) {
      case "planned":
        return this.startOne(run, effect, rec);
      case "downloading":
        return this.followOne(run, rec);
      case "verifying":
        // Left by a process that stopped while it checked the file: check it again.
        return this.verifyAndPlace(run, rec, false);
      default:
        return;
    }
  }

  private attempts(runId: string, acquisitionId: string): number {
    let n = 0;
    for (const e of this.deps.store.listRunEvents(runId)) {
      const d = AttemptData.safeParse(e.data);
      if (e.kind === "note" && d.success && d.data.acquisitionId === acquisitionId) n = Math.max(n, d.data.attempt);
    }
    return n;
  }

  private async startOne(run: RunRecord, effect: AcquireModelsEffect, rec: AcquisitionRecord): Promise<void> {
    const { io } = this.deps;
    const fail = (message: string) => this.move(run, rec, "failed", { error: { code: "DEPENDENCY_UNAVAILABLE", message } }, message);
    const attempts = this.attempts(run.id, rec.id);
    if (attempts >= MAX_DOWNLOAD_ATTEMPTS) {
      const last = [...this.deps.store.listRunEvents(run.id)].reverse().find((e) => e.kind === "note" && e.data?.acquisitionId === rec.id);
      fail(`gave up after ${attempts} download attempts${last ? `; last: ${last.reason}` : ""}`);
      return;
    }
    const endpoint = hfEndpointRefusal(io.env);
    if (endpoint) return void fail(endpoint);

    // GAPS Q25: at least 50 GB stays free after each file, on the model root's disk and the
    // download cache's, with other runs' downloads reserved. A reading that fails is a hard
    // unknown and blocks the download (spec §7.3).
    const shortfall = await diskShortfall(io, this.deps.store, [rec], effect.minFreeBytes, { exceptRunId: run.id });
    if (shortfall) return void fail(`${shortfall}; nothing was downloaded`);

    // The staged name is resolved by the same upstream call as the destination, so both land
    // in the folder upstream resolves for the category, wherever its extra model paths put
    // it. The destination must still be the approved one.
    const stagedName = stagedNameOf(rec.file, run.id);
    let stagedPath: string;
    try {
      const dest = await io.facade.resolveModelDestination(rec.folder, rec.file);
      const staged = await io.facade.resolveModelDestination(rec.folder, stagedName);
      const approved = join(rec.destinationRoot, rec.folder, rec.file);
      if (resolve(dest.path) !== resolve(approved)) {
        return void fail(`upstream now resolves ${rec.folder}/${rec.file} to ${dest.path}, not to the approved ${approved}`);
      }
      if (dirname(resolve(staged.path)) !== dirname(resolve(dest.path)) || basename(staged.path) !== stagedName) {
        return void fail(`upstream would stage ${rec.file} at ${staged.path}, not next to its destination ${dest.path}`);
      }
      stagedPath = resolve(staged.path);
    } catch (err) {
      return void fail(`upstream can't resolve where ${rec.folder}/${rec.file} would go: ${messageOf(err)}`);
    }
    // A file left under this run's staged name by an earlier attempt isn't verified and isn't
    // trusted: it goes. Only that exact name; nothing else in the folder is touched.
    try {
      await io.fs.unlink(stagedPath);
      this.note(run, rec, `removed an unverified staged file left by an earlier attempt`);
    } catch (err) {
      if (errnoOf(err) !== "ENOENT") return void fail(`couldn't remove the earlier staged file ${stagedPath}: ${messageOf(err)}`);
    }
    if (await io.facade.downloadRoutesToManager()) {
      return void fail("upstream would hand this download to ComfyUI-Manager, whose file can't be checked before placement");
    }

    const attempt = attempts + 1;
    const url = pinnedUrl(rec.source);
    const pre = await preflightRedirects(url, io.fetch, { env: io.env, token: io.facade.huggingfaceToken(), pinned: rec.source });
    if (!pre.ok) {
      if (pre.refused) return void fail(`redirect check: ${pre.message}`);
      this.note(run, rec, `download attempt ${attempt}: ${pre.message}`, { attempt });
      return;
    }
    let jobId: string;
    try {
      ({ jobId } = await io.facade.startDownload({ url, subfolder: rec.folder, filename: stagedName }));
    } catch (err) {
      this.note(run, rec, `download attempt ${attempt}: upstream didn't start the download: ${messageOf(err)}`, { attempt });
      return;
    }
    this.note(
      run,
      rec,
      `download attempt ${attempt}: job ${jobId}, redirects checked (${pre.hops} hop(s), ending at ${new URL(pre.finalUrl).hostname}` +
        `${pre.headRefused ? `, which refused HEAD with ${pre.headRefused} after Hugging Face named the pinned size and sha256` : ""})`,
      {
      attempt,
      jobId,
    });
    this.move(run, rec, "downloading", { jobId, stagedPath }, `job ${jobId}`);
  }

  private async followOne(run: RunRecord, rec: AcquisitionRecord): Promise<void> {
    const { io } = this.deps;
    let status: Awaited<ReturnType<AcquisitionFacade["downloadStatus"]>>;
    if (!rec.jobId) {
      status = { status: "missing" };
    } else {
      try {
        status = await io.facade.downloadStatus(rec.jobId);
      } catch (err) {
        status = { status: "unknown", error: messageOf(err) };
      }
    }
    const fail = (message: string) => this.move(run, rec, "failed", { error: { code: "DEPENDENCY_UNAVAILABLE", message } }, message);
    switch (status.status) {
      case "unknown":
        // Nothing learnt; the next poll asks again, and the run's wall time bounds the wait.
        return;
      case "downloading": {
        // The pin says how big the file is: a transfer that announces or reaches more is
        // stopped rather than left to fill the disk. Without upstream's progress channel
        // (stdio) the bytes so far are the size of upstream's cache `.partial`.
        const bytes = await this.bytesSoFar(rec, status);
        const over =
          status.totalBytes !== undefined && status.totalBytes !== rec.source.sizeBytes
            ? `the server announced ${status.totalBytes} bytes, the pin says ${rec.source.sizeBytes}`
            : bytes !== undefined && bytes > rec.source.sizeBytes
              ? `${bytes} bytes received, more than the pinned ${rec.source.sizeBytes}`
              : undefined;
        if (over && rec.jobId) {
          let cancelled: { cancelled: boolean; message: string };
          try {
            cancelled = await io.facade.cancelDownload(rec.jobId);
          } catch (err) {
            cancelled = { cancelled: false, message: messageOf(err) };
          }
          this.note(run, rec, `download job ${rec.jobId}: ${cancelled.message}`, { jobId: rec.jobId, cancelled: cancelled.cancelled });
          await this.deleteStaged(rec);
          fail(`size over the pin: ${over}`);
        }
        return;
      }
      case "done": {
        if (status.path !== undefined && rec.stagedPath !== undefined && resolve(status.path) !== resolve(rec.stagedPath)) {
          // Never touched: it isn't the staged name, so it isn't Architect's to delete.
          return void fail(`upstream reports the file at ${status.path}, not at the staged path ${rec.stagedPath}; nothing was placed`);
        }
        const verifying = this.move(run, rec, "verifying", {}, `job ${rec.jobId ?? "?"} finished`);
        if (verifying) await this.verifyAndPlace(run, verifying, true);
        return;
      }
      case "cancelled": {
        // Someone stopped the job outside the run (upstream's download tray, its download
        // tool): that is their decision, so the download isn't started again.
        await this.deleteStaged(rec);
        this.move(
          run,
          rec,
          "cancelled",
          { error: { code: "DEPENDENCY_UNAVAILABLE", message: "the download was cancelled outside the run" } },
          `job ${rec.jobId ?? "(none)"} was cancelled outside the run; it isn't restarted`,
        );
        return;
      }
      case "error":
      case "missing": {
        const why = `job ${rec.jobId ?? "(none)"} is ${status.status}${status.error ? `: ${status.error}` : ""}`;
        // A staged file may be whole: the job's record can be lost with the process after the
        // file landed. It is verified, never placed on the job's word.
        if (rec.stagedPath !== undefined && (await this.exists(rec.stagedPath))) {
          const verifying = this.move(run, rec, "verifying", {}, `${why}; checking the staged file`);
          if (verifying) await this.verifyAndPlace(run, verifying, false);
          return;
        }
        this.move(run, rec, "planned", { jobId: null }, `${why}; nothing staged, the download starts again`);
        return;
      }
    }
  }

  /**
   * Verify the staged file and place it. `afterDone`: the job reported the file complete, so
   * a mismatch is a failure. Otherwise the file may be a partial one left by a crash, and a
   * mismatch sends the acquisition back to `planned` for a fresh download.
   */
  private async verifyAndPlace(run: RunRecord, rec: AcquisitionRecord, afterDone: boolean): Promise<void> {
    const { io } = this.deps;
    if (rec.stagedPath === undefined) {
      const back = this.move(run, rec, "downloading", {}, "no staged path recorded");
      if (back) this.move(run, back, "planned", { jobId: null }, "the download starts again");
      return;
    }
    const v = await verifyStaged(io.fs, rec.stagedPath, rec.source);
    switch (v.kind) {
      case "unreadable":
        this.note(run, rec, v.message);
        return;
      case "missing": {
        const back = this.move(run, rec, "downloading", {}, "the staged file is gone");
        if (back) this.move(run, back, "planned", { jobId: null }, "the download starts again");
        return;
      }
      case "mismatch": {
        const observed = { observedBytes: v.bytes, ...(v.sha256 ? { observedSha256: v.sha256 } : {}) };
        if (afterDone) {
          this.move(run, rec, "failed", { ...observed, error: { code: "DEPENDENCY_UNAVAILABLE", message: v.message } }, `${v.message}; the staged file was deleted`);
          return;
        }
        const back = this.move(run, rec, "downloading", observed, `${v.message}; the staged file was incomplete or wrong and was deleted`);
        if (back) this.move(run, back, "planned", { jobId: null }, "the download starts again");
        return;
      }
      case "match": {
        const placed = await placeStaged(io.fs, {
          root: rec.destinationRoot,
          folder: rec.folder,
          file: rec.file,
          stagedPath: rec.stagedPath,
          source: rec.source,
          verified: { dev: v.dev, ino: v.ino },
        });
        if (!placed.ok) {
          this.move(run, rec, "failed", { observedSha256: v.sha256, observedBytes: v.bytes, error: { code: "DEPENDENCY_UNAVAILABLE", message: placed.message } }, placed.message);
          return;
        }
        const done = this.move(
          run,
          rec,
          "placed",
          { placedPath: placed.path, observedSha256: v.sha256, observedBytes: v.bytes, error: null },
          placed.preexisting ? `${placed.path} already held the pinned file` : `placed as ${placed.path}`,
        );
        if (done) {
          this.verified.add(done.id);
          await this.evictCacheCopy(run, done, placed.path);
        }
        return;
      }
    }
  }

  /** Bytes so far: upstream's progress when it reports it, else the size of its cache `.partial`. */
  private async bytesSoFar(rec: AcquisitionRecord, status: DownloadStatus): Promise<number | undefined> {
    if (status.bytes !== undefined) return status.bytes;
    try {
      return (await this.deps.io.fs.lstat(this.deps.io.facade.downloadCacheEntry(pinnedUrl(rec.source)).partialPath)).size;
    } catch {
      // No partial to read (not started, or already renamed into the cache): not a size.
      return undefined;
    }
  }

  /**
   * Remove upstream's download-cache copy of a file just placed: upstream keeps every cache
   * entry unless COMFYUI_LRU_CACHE_SIZE_GB sets a limit, so the file would take its disk twice
   * when the cache is on another device, and stay there after the user deletes the model. Only that entry, found by upstream's own derivation of
   * the cache path for the pinned URL, and only when it is the placed file's inode (the
   * cache's hard link) or holds exactly the pinned bytes; then its Content-Type sidecar.
   * Anything else is left, with a note.
   */
  private async evictCacheCopy(run: RunRecord, rec: AcquisitionRecord, placedPath: string): Promise<void> {
    const { fs, facade } = this.deps.io;
    const entry = facade.downloadCacheEntry(pinnedUrl(rec.source));
    const label = `<download cache>/${basename(entry.cachePath)}`;
    let st: Awaited<ReturnType<AcquisitionFs["lstat"]>>;
    try {
      st = await fs.lstat(entry.cachePath);
    } catch (err) {
      if (errnoOf(err) !== "ENOENT") this.note(run, rec, `upstream's cache copy ${label} couldn't be read, so it was left: ${messageOf(err)}`);
      return;
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      this.note(run, rec, `upstream's cache entry ${label} isn't a regular file; it was left`);
      return;
    }
    let ours = false;
    try {
      const placed = await fs.lstat(placedPath);
      ours = placed.dev === st.dev && placed.ino === st.ino;
      if (!ours && st.size === rec.source.sizeBytes) {
        const h = await fs.hashFile(entry.cachePath);
        ours = h.sha256 === rec.source.sha256 && h.bytes === rec.source.sizeBytes;
      }
    } catch (err) {
      this.note(run, rec, `upstream's cache copy ${label} couldn't be compared with the placed file, so it was left: ${messageOf(err)}`);
      return;
    }
    if (!ours) {
      this.note(run, rec, `upstream's cache entry ${label} isn't the placed file's bytes; it was left`);
      return;
    }
    const removed: string[] = [];
    for (const p of [entry.cachePath, entry.contentTypeSidecar]) {
      try {
        await fs.unlink(p);
        removed.push(`<download cache>/${basename(p)}`);
      } catch (err) {
        if (errnoOf(err) !== "ENOENT") {
          this.note(run, rec, `couldn't remove ${`<download cache>/${basename(p)}`}: ${messageOf(err)}`);
          if (p === entry.cachePath) return;
        }
      }
    }
    this.note(run, rec, `removed upstream's cache copy: ${removed.join(", ")}`, { cacheRemoved: removed });
  }

  /**
   * A placement this instance didn't verify (a restart, another process) is hashed again
   * before it counts (ARCH 2026-11-16, after acquisition). Undefined when all check out.
   */
  private async recheckPlaced(run: RunRecord, records: readonly AcquisitionRecord[]): Promise<{ code: ArchitectErrorCode; message: string } | undefined> {
    for (const r of records) {
      if (this.verified.has(r.id) || r.placedPath === undefined) continue;
      let found: HashedFile;
      try {
        const st = await this.deps.io.fs.lstat(r.placedPath);
        if (st.isSymbolicLink() || !st.isFile()) return { code: "DEPENDENCY_UNAVAILABLE", message: `${r.placedPath} is no longer a regular file` };
        found = await this.deps.io.fs.hashFile(r.placedPath);
      } catch (err) {
        return { code: "DEPENDENCY_UNAVAILABLE", message: `${r.placedPath} couldn't be checked again: ${messageOf(err)}` };
      }
      if (found.sha256 !== r.source.sha256 || found.bytes !== r.source.sizeBytes) {
        return { code: "DEPENDENCY_UNAVAILABLE", message: `${r.placedPath} changed since it was placed (sha256 ${short(found.sha256)}…, pinned ${short(r.source.sha256)}…)` };
      }
      this.verified.add(r.id);
      this.note(run, r, `checked ${r.placedPath} again: the pinned sha256`);
    }
    return undefined;
  }

  /**
   * Once every acquisition is final, delete the run's staged files that weren't placed, each
   * by its exact staged name for this run (nothing else in a model folder is touched).
   */
  private async cleanup(run: RunRecord, records: readonly AcquisitionRecord[]): Promise<void> {
    if (!records.every((r) => FINAL_ACQUISITION_STATES.includes(r.state))) return;
    for (const r of records) {
      const staged = r.stagedPath ?? join(r.destinationRoot, r.folder, stagedNameOf(r.file, run.id));
      try {
        await this.deps.io.fs.unlink(staged);
      } catch (err) {
        if (errnoOf(err) !== "ENOENT") {
          this.deps.store.appendRunEvent({ runId: run.id, kind: "note", principal: "controller", reason: `couldn't delete the staged ${staged}: ${messageOf(err)}`, at: this.deps.now() });
        }
      }
    }
  }

  private async deleteStaged(rec: AcquisitionRecord): Promise<void> {
    if (rec.stagedPath === undefined) return;
    try {
      await this.deps.io.fs.unlink(rec.stagedPath);
    } catch {
      // Gone already, or removed by the cleanup; never placed unverified either way.
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await this.deps.io.fs.lstat(path);
      return true;
    } catch (err) {
      // Only ENOENT shows the file absent; any other error leaves it possibly there, and the
      // check that follows (verifyStaged) reports it as unreadable rather than missing.
      return errnoOf(err) !== "ENOENT";
    }
  }

  /**
   * Transition one acquisition and record it on the run, so `status` can show progress. A
   * record another process moved first is left to it: undefined is returned.
   */
  private move(run: RunRecord, rec: AcquisitionRecord, to: AcquisitionState, patch: AcquisitionPatch, reason: string): AcquisitionRecord | undefined {
    let next: AcquisitionRecord;
    try {
      next = this.deps.store.transitionAcquisition({ id: rec.id, from: rec.state, to, patch, at: this.deps.now() });
    } catch (err) {
      if (err instanceof StoreConflictError) return undefined;
      throw err;
    }
    this.deps.store.appendRunEvent({
      runId: run.id,
      kind: "note",
      principal: "controller",
      reason: `acquisition ${rec.folder}/${rec.file}: ${rec.state} → ${to}: ${reason}`,
      data: {
        acquisitionId: rec.id,
        file: `${rec.folder}/${rec.file}`,
        acquisitionFrom: rec.state,
        acquisitionTo: to,
        ...(next.jobId ? { jobId: next.jobId } : {}),
        ...(next.placedPath ? { placedPath: next.placedPath } : {}),
        ...(next.observedSha256 ? { observedSha256: next.observedSha256 } : {}),
      },
      at: this.deps.now(),
    });
    return next;
  }

  private note(run: RunRecord, rec: AcquisitionRecord, reason: string, data: Record<string, unknown> = {}): void {
    this.deps.store.appendRunEvent({
      runId: run.id,
      kind: "note",
      principal: "controller",
      reason: `acquisition ${rec.folder}/${rec.file}: ${reason}`,
      data: { acquisitionId: rec.id, file: `${rec.folder}/${rec.file}`, ...data },
      at: this.deps.now(),
    });
  }
}

/** One acquisition as a status reply shows it. */
export function acquisitionView(r: AcquisitionRecord, bytesSoFar?: number): AcquisitionView {
  return {
    id: r.id,
    file: `${r.folder}/${r.file}`,
    state: r.state,
    size: formatBytes(r.source.sizeBytes),
    sizeBytes: r.source.sizeBytes,
    source: `${r.source.repo}@${r.source.revision.slice(0, 8)}:${r.source.path}`,
    ...(bytesSoFar !== undefined ? { bytesSoFar } : {}),
    ...(r.placedPath ? { placedPath: r.placedPath } : {}),
    ...(r.error ? { error: `${r.error.code}: ${r.error.message}` } : {}),
  };
}

/** What a run's lineage records of an acquired file (FR-11). */
export function acquiredLockEntry(r: AcquisitionRecord) {
  return {
    folder: r.folder,
    file: r.file,
    repo: r.source.repo,
    commit: r.source.revision,
    path: r.source.path,
    sha256: r.observedSha256,
    sizeBytes: r.observedBytes,
    ...(r.source.license ? { license: r.source.license } : {}),
  };
}
