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
// - upstream writes the file into `<model root>/.architect-staging/<run id>/`, a folder
//   ComfyUI doesn't list;
// - Architect hashes the staged file and compares sha256 and size with the pin; only a
//   match is placed, by `link` then `unlink`, so an existing file is never overwritten.
//
// Nothing here holds a lock across a download: `step` starts a job and returns, and the
// controller's next poll reads the job's state. All I/O comes in through `AcquisitionIo`,
// so the tests run on temporary folders with a fake downloader and a fake Hugging Face.

import { createHash } from "node:crypto";
import { constants as fsConstants, statfsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
import type { UpstreamFacade } from "./upstream.js";

/** The folder under a model root that holds a run's staged files. */
export const STAGING_DIR = ".architect-staging";
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
  "resolveModelDestination" | "downloadRoutesToManager" | "startDownload" | "downloadStatus" | "cancelDownload" | "forgetNodeSchemas"
>;

/** A HEAD request without following redirects: the subset of `fetch` the preflight uses. */
export type HeadFetch = (
  url: string,
  init: { method: "HEAD"; redirect: "manual"; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

/** File operations acquisition performs; node:fs by default, injectable for tests. */
export interface AcquisitionFs {
  lstat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number }>;
  realpath(path: string): Promise<string>;
  mkdir(path: string, mode: number): Promise<void>;
  link(existing: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  /** sha256 and size of a regular file, read without following a symbolic link. */
  hashFile(path: string): Promise<{ sha256: string; bytes: number }>;
  /** Bytes available to this user on the filesystem holding `path` (statfs bavail * bsize). */
  freeDiskBytes(path: string): Promise<number>;
}

/** Everything acquisition reaches outside the process. */
export interface AcquisitionIo {
  facade: AcquisitionFacade;
  fetch: HeadFetch;
  fs: AcquisitionFs;
  /** The environment: `HF_ENDPOINT` and `HF_TOKEN` are read from it. */
  env: Readonly<Record<string, string | undefined>>;
}

/** sha256 and size of a file opened with O_NOFOLLOW, so a symbolic link is never read through. */
async function hashFileNoFollow(path: string): Promise<{ sha256: string; bytes: number }> {
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
    return { sha256: hash.digest("hex"), bytes };
  } finally {
    await handle.close();
  }
}

/** node:fs behind `AcquisitionFs`. */
export const NODE_ACQUISITION_FS: AcquisitionFs = {
  lstat: (p) => fsp.lstat(p),
  realpath: (p) => fsp.realpath(p),
  mkdir: async (p, mode) => {
    await fsp.mkdir(p, { mode });
  },
  link: (a, b) => fsp.link(a, b),
  unlink: (p) => fsp.unlink(p),
  rmdir: (p) => fsp.rmdir(p),
  hashFile: hashFileNoFollow,
  freeDiskBytes: async (p) => {
    const s = await fsp.statfs(p);
    return Number(s.bavail) * Number(s.bsize);
  },
};

/** The live I/O: upstream through the facade, the global fetch, node:fs and process.env. */
export function defaultAcquisitionIo(facade: AcquisitionFacade): AcquisitionIo {
  return { facade, fetch: (url, init) => fetch(url, init), fs: NODE_ACQUISITION_FS, env: process.env };
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
  | { ok: true; finalUrl: string; hops: number }
  | { ok: false; refused: true; message: string }
  | { ok: false; refused: false; message: string };

/**
 * Follow the redirect chain of `url` with HEAD requests (redirect: "manual"): at most five
 * hops, every URL `https:` on a Hugging Face host, a relative Location resolved against the
 * URL it came from, and a final 2xx answer. `HF_TOKEN` is sent only to huggingface.co, and
 * only after it answered 401 without one: a token only for gated repositories (GAPS Q25). A
 * request that fails is `refused: false`, a failed observation, never a refusal of the host.
 */
export async function preflightRedirects(url: string, fetchFn: HeadFetch, env: AcquisitionIo["env"] = {}): Promise<PreflightResult> {
  const endpoint = hfEndpointRefusal(env);
  if (endpoint) return { ok: false, refused: true, message: endpoint };
  const token = env.HF_TOKEN?.trim();
  let current = url;
  let withToken = false;
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

/** A run's staging folder under a model root. */
export function stagingDirOf(root: string, runId: string): string {
  return join(root, STAGING_DIR, runId);
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

/**
 * Create `<root>/.architect-staging/<run id>/` (mode 0700) and check it: both levels real
 * directories, not symbolic links (lstat), and the run's folder resolving to the same path
 * under the root's real path, so nothing redirects the staged bytes (SEC T9).
 */
export async function prepareStaging(fs: AcquisitionFs, root: string, runId: string): Promise<{ ok: true; dir: string } | StepRefusal> {
  if (!isAbsolute(root)) return { ok: false, message: `the model root ${root} isn't absolute` };
  const levels = [join(root, STAGING_DIR), stagingDirOf(root, runId)];
  for (const dir of levels) {
    try {
      await fs.mkdir(dir, 0o700);
    } catch (err) {
      if (errnoOf(err) !== "EEXIST") return { ok: false, message: `couldn't create the staging folder ${dir}: ${messageOf(err)}` };
    }
    let st: Awaited<ReturnType<AcquisitionFs["lstat"]>>;
    try {
      st = await fs.lstat(dir);
    } catch (err) {
      return { ok: false, message: `couldn't read the staging folder ${dir}: ${messageOf(err)}` };
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return { ok: false, message: `the staging folder ${dir} is ${st.isSymbolicLink() ? "a symbolic link" : "not a directory"}; refusing to stage through it` };
    }
  }
  try {
    const realRoot = await fs.realpath(root);
    const real = await fs.realpath(levels[1]);
    if (real !== join(realRoot, STAGING_DIR, runId)) {
      return { ok: false, message: `the staging folder ${levels[1]} resolves to ${real}, outside ${realRoot}` };
    }
  } catch (err) {
    return { ok: false, message: `couldn't resolve the staging folder ${levels[1]}: ${messageOf(err)}` };
  }
  return { ok: true, dir: levels[1] };
}

/** What a check of a staged file found. */
export type VerifyResult =
  | { kind: "match"; sha256: string; bytes: number }
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
  let hashed: { sha256: string; bytes: number };
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
  return { kind: "match", ...hashed };
}

/** What placement did. */
export type PlaceResult =
  | { ok: true; path: string; preexisting: boolean }
  | StepRefusal;

/**
 * Place a verified staged file as `<root>/<folder>/<file>` with `link` and `unlink`, so the
 * destination is created only if it doesn't exist. Refused: a staging folder or file that is
 * a symbolic link, and a destination whose parent's real path isn't inside the root's (SEC
 * T9). When the destination exists, it is hashed: the pinned bytes count as placed (someone
 * installed the file meanwhile); anything else fails and is left untouched. The staged file
 * is removed either way.
 */
export async function placeStaged(
  fs: AcquisitionFs,
  args: { root: string; folder: string; file: string; stagedPath: string; source: ModelSource },
): Promise<PlaceResult> {
  const { root, folder, file, stagedPath, source } = args;
  const dest = join(root, folder, file);
  const removeStaged = async () => {
    try {
      await fs.unlink(stagedPath);
    } catch {
      // Already gone, or left for the staging folder's removal; it is never placed unverified.
    }
  };
  try {
    for (const p of [dirname(stagedPath), stagedPath]) {
      const st = await fs.lstat(p);
      if (st.isSymbolicLink()) return { ok: false, message: `the staged ${p} is a symbolic link; nothing was placed` };
    }
  } catch (err) {
    return { ok: false, message: `couldn't read the staged file ${stagedPath}: ${messageOf(err)}` };
  }
  const parent = dirname(dest);
  try {
    await fs.mkdir(parent, 0o755);
  } catch (err) {
    if (errnoOf(err) !== "EEXIST") return { ok: false, message: `couldn't create the model folder ${parent}: ${messageOf(err)}` };
  }
  try {
    const realRoot = await fs.realpath(root);
    const realParent = await fs.realpath(parent);
    if (!within(realRoot, realParent) || realParent === realRoot) {
      return { ok: false, message: `the model folder ${parent} resolves to ${realParent}, outside ${realRoot}; nothing was placed` };
    }
  } catch (err) {
    return { ok: false, message: `couldn't resolve the model folder ${parent}: ${messageOf(err)}` };
  }
  try {
    await fs.link(stagedPath, dest);
  } catch (err) {
    if (errnoOf(err) !== "EEXIST") {
      return { ok: false, message: `couldn't place ${dest}: ${messageOf(err)} (the staging folder must be on the model folder's filesystem)` };
    }
    // Someone else's file, or the pinned one installed meanwhile: hash it, never replace it.
    let existing: { sha256: string; bytes: number };
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

/** Remove a run's staging folder and, when empty, the staging root; errors are reported, not thrown. */
export async function removeStaging(fs: AcquisitionFs, root: string, runId: string, files: readonly string[]): Promise<string[]> {
  const problems: string[] = [];
  const dir = stagingDirOf(root, runId);
  for (const f of files) {
    try {
      await fs.unlink(join(dir, f));
    } catch (err) {
      if (errnoOf(err) !== "ENOENT") problems.push(`couldn't delete ${join(dir, f)}: ${messageOf(err)}`);
    }
  }
  for (const d of [dir, join(root, STAGING_DIR)]) {
    try {
      const st = await fs.lstat(d);
      if (st.isSymbolicLink()) {
        problems.push(`${d} is a symbolic link; it was left as it is`);
        break;
      }
      await fs.rmdir(d);
    } catch (err) {
      const code = errnoOf(err);
      // Another run's files keep the staging root; a folder never created needs no removal.
      if (code === "ENOENT" || (d !== dir && (code === "ENOTEMPTY" || code === "EEXIST"))) continue;
      problems.push(`couldn't remove ${d}: ${messageOf(err)}`);
    }
  }
  return problems;
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
          bytesSoFar = (await this.deps.io.facade.downloadStatus(r.jobId)).bytes;
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

    // GAPS Q25: at least 50 GB stays free after each file. A free-disk reading that fails
    // is a hard unknown and blocks the download (spec §7.3).
    let free: number;
    try {
      free = await io.fs.freeDiskBytes(rec.destinationRoot);
    } catch (err) {
      return void fail(`the free disk under ${rec.destinationRoot} couldn't be read (${messageOf(err)}); nothing was downloaded`);
    }
    if (free - rec.source.sizeBytes < effect.minFreeBytes) {
      return void fail(
        `${formatBytes(free)} free under ${rec.destinationRoot}; after ${formatBytes(rec.source.sizeBytes)} less than ` +
          `${formatBytes(effect.minFreeBytes)} would remain`,
      );
    }

    const staging = await prepareStaging(io.fs, rec.destinationRoot, run.id);
    if (!staging.ok) return void fail(staging.message);
    const stagedPath = join(staging.dir, rec.file);
    // A file left by an earlier attempt isn't verified and isn't trusted: it goes.
    try {
      await io.fs.unlink(stagedPath);
      this.note(run, rec, `removed an unverified staged file left by an earlier attempt`);
    } catch (err) {
      if (errnoOf(err) !== "ENOENT") return void fail(`couldn't remove the earlier staged file ${stagedPath}: ${messageOf(err)}`);
    }
    // Upstream's resolver must put the staged file exactly here: under the same root as the
    // destination, so `link` places it without a copy, and in the folder checked above.
    const subfolder = `${STAGING_DIR}/${run.id}`;
    try {
      const target = await io.facade.resolveModelDestination(subfolder, rec.file);
      if (resolve(target.path) !== resolve(stagedPath)) {
        return void fail(`upstream would stage ${rec.file} at ${target.path}, not at ${stagedPath}`);
      }
    } catch (err) {
      return void fail(`upstream can't resolve the staging folder: ${messageOf(err)}`);
    }
    if (await io.facade.downloadRoutesToManager()) {
      return void fail("upstream would hand this download to ComfyUI-Manager, whose file can't be checked before placement");
    }

    const attempt = attempts + 1;
    const url = pinnedUrl(rec.source);
    const pre = await preflightRedirects(url, io.fetch, io.env);
    if (!pre.ok) {
      if (pre.refused) return void fail(`redirect check: ${pre.message}`);
      this.note(run, rec, `download attempt ${attempt}: ${pre.message}`, { attempt });
      return;
    }
    let jobId: string;
    try {
      ({ jobId } = await io.facade.startDownload({ url, subfolder, filename: rec.file }));
    } catch (err) {
      this.note(run, rec, `download attempt ${attempt}: upstream didn't start the download: ${messageOf(err)}`, { attempt });
      return;
    }
    this.note(run, rec, `download attempt ${attempt}: job ${jobId}, redirects checked (${pre.hops} hop(s), ending at ${new URL(pre.finalUrl).hostname})`, {
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
        // stopped rather than left to fill the disk.
        const over =
          status.totalBytes !== undefined && status.totalBytes !== rec.source.sizeBytes
            ? `the server announced ${status.totalBytes} bytes, the pin says ${rec.source.sizeBytes}`
            : status.bytes !== undefined && status.bytes > rec.source.sizeBytes
              ? `${status.bytes} bytes received, more than the pinned ${rec.source.sizeBytes}`
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
          // Never touched: it isn't in the staging folder, so it isn't Architect's to delete.
          return void fail(`upstream reports the file at ${status.path}, not at the staging path ${rec.stagedPath}; nothing was placed`);
        }
        const verifying = this.move(run, rec, "verifying", {}, `job ${rec.jobId ?? "?"} finished`);
        if (verifying) await this.verifyAndPlace(run, verifying, true);
        return;
      }
      case "error":
      case "cancelled":
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
        const placed = await placeStaged(io.fs, { root: rec.destinationRoot, folder: rec.folder, file: rec.file, stagedPath: rec.stagedPath, source: rec.source });
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
        if (done) this.verified.add(done.id);
        return;
      }
    }
  }

  /**
   * A placement this instance didn't verify (a restart, another process) is hashed again
   * before it counts (ARCH 2026-11-16, after acquisition). Undefined when all check out.
   */
  private async recheckPlaced(run: RunRecord, records: readonly AcquisitionRecord[]): Promise<{ code: ArchitectErrorCode; message: string } | undefined> {
    for (const r of records) {
      if (this.verified.has(r.id) || r.placedPath === undefined) continue;
      let found: { sha256: string; bytes: number };
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

  /** Remove the run's staging folders once every acquisition is final. */
  private async cleanup(run: RunRecord, records: readonly AcquisitionRecord[]): Promise<void> {
    if (!records.every((r) => FINAL_ACQUISITION_STATES.includes(r.state))) return;
    const roots = [...new Set(records.map((r) => r.destinationRoot))];
    for (const root of roots) {
      const files = records.filter((r) => r.destinationRoot === root).map((r) => r.file);
      const problems = await removeStaging(this.deps.io.fs, root, run.id, files);
      for (const p of problems) {
        this.deps.store.appendRunEvent({ runId: run.id, kind: "note", principal: "controller", reason: p, at: this.deps.now() });
      }
    }
  }

  private async deleteStaged(rec: AcquisitionRecord): Promise<void> {
    if (rec.stagedPath === undefined) return;
    try {
      await this.deps.io.fs.unlink(rec.stagedPath);
    } catch {
      // Gone already, or removed with the staging folder; never placed unverified either way.
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
    placedPath: r.placedPath,
    ...(r.source.license ? { license: r.source.license } : {}),
  };
}
