// Model families from safetensors headers (TODO 5.3; spec §8.1, §9.3; ARCH 2026-11-16,
// model families).
//
// A family rule names the tensors a family's files carry and lack. Architect reads only a
// file's header, the 8-byte little-endian length and the JSON after it, never the weights,
// and refuses a header longer than 100 MB. Files are located through upstream's resolver
// (the facade's `locateModelFile`), which on the reference machine takes seconds per call
// because it probes the running server, so each observation is cached in architect.db by
// folder, file, size and modification time, with the path the resolver gave: the next check
// of an unchanged file is one stat. A file that can't be located isn't cached, and its
// family stays unknown, never "no family" (#796).

import { open, stat } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "./hash.js";
import { FamilyRule, type ModelObservation } from "./schemas.js";
import type { ArchitectStore } from "./store.js";
import type { UpstreamFacade } from "./upstream.js";
import { type FamilyEvidence, observationKey } from "./validate.js";

/** `architect/families/` at the package root: three levels up from src/ and from dist/. */
export const SHIPPED_FAMILIES_DIR = fileURLToPath(new URL("../../../architect/families/", import.meta.url));

/** A header longer than this is refused: no model this project loads has one near it. */
export const MAX_HEADER_BYTES = 100 * 1024 * 1024;

/** How long one `observeAll` may spend locating files it has no usable cache entry for. */
export const DEFAULT_LOCATE_BUDGET_MS = 30_000;

export interface FamilyRuleLoadResult {
  rules: FamilyRule[];
  errors: { file: string; message: string }[];
  /** False when the directory doesn't exist: the rules are unknown, not none. */
  dirFound: boolean;
}

/** Load every `*.json` in `dir`, in file-name order; an invalid file or a duplicate id is reported. */
export function loadFamilyRules(dir: string = SHIPPED_FAMILIES_DIR): FamilyRuleLoadResult {
  if (!existsSync(dir)) return { rules: [], errors: [], dirFound: false };
  const rules: FamilyRule[] = [];
  const errors: FamilyRuleLoadResult["errors"] = [];
  const names = new Map<string, string>();
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const file = join(dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf-8"));
    } catch (err) {
      errors.push({ file, message: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const parsed = FamilyRule.safeParse(raw);
    if (!parsed.success) {
      errors.push({ file, message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") });
      continue;
    }
    // An alias that is another rule's id or alias would let one recipe name mean two rules.
    const claimed = [parsed.data.id, ...(parsed.data.aliases ?? [])];
    const clash = claimed.find((n) => names.has(n));
    if (clash !== undefined) {
      errors.push({ file, message: `family name ${clash} is already used in ${names.get(clash)}` });
      continue;
    }
    for (const n of claimed) names.set(n, file);
    rules.push(parsed.data);
  }
  return { rules, errors, dirFound: true };
}

/** sha256 over the rules, so an observation made against other rules is read again. */
export function rulesDigest(rules: readonly FamilyRule[]): string {
  return sha256Hex(canonicalJson([...rules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))));
}

/** One tensor's entry in a safetensors header; `__metadata__` is a string map and skipped. */
const HeaderTensor = z
  .object({
    dtype: z.string().min(1),
    shape: z.array(z.number().int().nonnegative()),
    data_offsets: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  })
  .passthrough();

/** Tensor name to shape, from a safetensors header. */
export type TensorShapes = ReadonlyMap<string, readonly number[]>;

/** Why a header couldn't be read; the family stays unknown. */
export class HeaderReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeaderReadError";
  }
}

/**
 * The header length a safetensors file's 8-byte little-endian prefix gives, checked against
 * the bound and, when given, against the file's size, so a truncated or foreign file isn't
 * read as a header.
 */
export function headerLength(prefix: Buffer, fileSize?: number): number {
  if (prefix.length < 8) throw new HeaderReadError("the file is shorter than a safetensors length prefix");
  const length = prefix.readBigUInt64LE(0);
  if (length > BigInt(MAX_HEADER_BYTES)) throw new HeaderReadError(`the header length ${length} is over the ${MAX_HEADER_BYTES}-byte bound`);
  const n = Number(length);
  if (n < 2) throw new HeaderReadError(`the header length ${n} can't hold a JSON object`);
  if (fileSize !== undefined && 8 + n > fileSize) throw new HeaderReadError(`the header length ${n} runs past the end of the file (${fileSize} bytes)`);
  return n;
}

/** Tensor names and shapes from a header's JSON body; `__metadata__` is skipped. */
export function parseHeaderJson(body: Buffer): TensorShapes {
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString("utf-8"));
  } catch (err) {
    throw new HeaderReadError(`the header isn't JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new HeaderReadError("the header isn't a JSON object");
  const shapes = new Map<string, readonly number[]>();
  for (const [name, entry] of Object.entries(raw)) {
    if (name === "__metadata__") continue;
    const parsed = HeaderTensor.safeParse(entry);
    if (!parsed.success) throw new HeaderReadError(`tensor ${JSON.stringify(name.slice(0, 120))} has no dtype, shape and offsets`);
    shapes.set(name, parsed.data.shape);
  }
  if (shapes.size === 0) throw new HeaderReadError("the header lists no tensors");
  return shapes;
}

/** Read a safetensors file's header: the prefix and the JSON only, never the weights. */
export async function readSafetensorsHeader(path: string): Promise<TensorShapes> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const prefix = Buffer.alloc(8);
    const { bytesRead } = await handle.read(prefix, 0, 8, 0);
    const n = headerLength(prefix.subarray(0, bytesRead), info.size);
    const body = Buffer.alloc(n);
    const read = await handle.read(body, 0, n, 8);
    if (read.bytesRead !== n) throw new HeaderReadError(`read ${read.bytesRead} of the header's ${n} bytes`);
    return parseHeaderJson(body);
  } finally {
    await handle.close();
  }
}

/** A `*` pattern as an anchored regular expression; every other character is literal. */
function patternRegex(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

/** Whether a header matches a rule, and if not, the first reason. */
export function matchRule(rule: FamilyRule, tensors: TensorShapes): { matches: true } | { matches: false; reason: string } {
  const names = [...tensors.keys()];
  for (const p of rule.requiredTensors) {
    const re = patternRegex(p);
    if (!names.some((n) => re.test(n))) return { matches: false, reason: `${rule.id}: no tensor ${p}` };
  }
  for (const p of rule.forbiddenTensors ?? []) {
    const re = patternRegex(p);
    const hit = names.find((n) => re.test(n));
    if (hit !== undefined) return { matches: false, reason: `${rule.id}: has ${hit}, which the family lacks` };
  }
  for (const [p, dims] of Object.entries(rule.shapes ?? {})) {
    const re = patternRegex(p);
    const hits = names.filter((n) => re.test(n));
    if (hits.length === 0) return { matches: false, reason: `${rule.id}: no tensor ${p} to check the shape of` };
    const wrong = hits.find((n) => JSON.stringify(tensors.get(n)) !== JSON.stringify(dims));
    if (wrong !== undefined) {
      return { matches: false, reason: `${rule.id}: ${wrong} is [${(tensors.get(wrong) ?? []).join(", ")}], the family has [${dims.join(", ")}]` };
    }
  }
  return { matches: true };
}

/** The outcome, matches and reason an observation records for a header. */
export function classifyHeader(rules: readonly FamilyRule[], tensors: TensorShapes): Pick<ModelObservation, "outcome" | "family" | "matches" | "reason"> {
  const results = rules.map((rule) => ({ rule, result: matchRule(rule, tensors) }));
  const matches = results.filter((r) => r.result.matches).map((r) => r.rule.id);
  if (matches.length === 1) return { outcome: "matched", family: matches[0], matches, reason: `${tensors.size} tensors; matches ${matches[0]}` };
  if (matches.length > 1) return { outcome: "ambiguous", matches, reason: `${tensors.size} tensors; matches ${matches.join(", ")}` };
  const reasons = results.flatMap((r) => (r.result.matches ? [] : [r.result.reason]));
  return { outcome: "no_match", matches, reason: `${tensors.size} tensors; ${reasons.join("; ") || "no family rules are loaded"}` };
}

/** What the observer needs; tests inject all of it. */
export interface FamilyObserverDeps {
  store: Pick<ArchitectStore, "getModelObservation" | "putModelObservation">;
  /** Upstream's resolver for an installed file (the facade's `locateModelFile`). */
  locate: UpstreamFacade["locateModelFile"];
  rules: readonly FamilyRule[];
  now: () => Date;
  /** A file's size and modification time now; `fs.stat` by default. */
  statFile?: (path: string) => Promise<{ size: number; mtimeMs: number; isFile: () => boolean }>;
  /** A file's header; `readSafetensorsHeader` by default. */
  readHeader?: (path: string) => Promise<TensorShapes>;
  locateBudgetMs?: number;
}

/** A file the observer didn't observe, and why; its family stays unknown. */
export interface Unobserved {
  folder: string;
  file: string;
  reason: string;
}

/**
 * Observes model files' families and caches the observations (TODO 5.3). Calls for one file
 * share one read while it runs; located paths are kept for the process.
 */
export class FamilyObserver {
  private readonly digest: string;
  private readonly inFlight = new Map<string, Promise<ModelObservation | Unobserved>>();

  constructor(private readonly deps: FamilyObserverDeps) {
    this.digest = rulesDigest(deps.rules);
  }

  get rules(): readonly FamilyRule[] {
    return this.deps.rules;
  }

  /**
   * Observe each file once, cached ones first; files that need upstream's resolver are
   * located only while the budget lasts, and the rest are returned as unobserved, so one
   * tool call never waits on a whole folder (each locate can take seconds).
   */
  async observeAll(files: readonly { folder: string; file: string }[]): Promise<{ evidence: FamilyEvidence; unobserved: Unobserved[] }> {
    const observations = new Map<string, ModelObservation>();
    const unobserved: Unobserved[] = [];
    const unique = [...new Map(files.map((f) => [observationKey(f.folder, f.file), f])).values()];
    const started = this.deps.now().getTime();
    const budget = this.deps.locateBudgetMs ?? DEFAULT_LOCATE_BUDGET_MS;
    for (const f of unique) {
      const allowLocate = this.deps.now().getTime() - started < budget;
      const result = await this.observe(f.folder, f.file, { allowLocate });
      if ("outcome" in result) observations.set(observationKey(f.folder, f.file), result);
      else unobserved.push(result);
    }
    return { evidence: { rules: this.deps.rules, observations }, unobserved };
  }

  /** The family observation of one installed file, from the cache when the file is unchanged. */
  observe(folder: string, file: string, options: { allowLocate?: boolean } = {}): Promise<ModelObservation | Unobserved> {
    const key = observationKey(folder, file);
    const running = this.inFlight.get(key);
    if (running) return running;
    const work = this.observeUncached(folder, file, options.allowLocate ?? true).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }

  private async observeUncached(folder: string, file: string, allowLocate: boolean): Promise<ModelObservation | Unobserved> {
    const statFile = this.deps.statFile ?? ((p: string) => stat(p));
    const stored = this.deps.store.getModelObservation(folder, file);
    if (stored) {
      try {
        const info = await statFile(stored.path);
        if (info.isFile() && info.size === stored.sizeBytes && info.mtimeMs === stored.mtimeMs && stored.rulesDigest === this.digest) return stored;
      } catch {
        // The cached path is gone or unreadable: locate the file again below.
      }
    }
    if (!allowLocate) return { folder, file, reason: "not located in this call: the time for locating files ran out; validate again to read it" };
    let located: { path: string; sizeBytes: number; mtimeMs: number };
    try {
      located = await this.deps.locate(folder, file);
    } catch (err) {
      return { folder, file, reason: `upstream couldn't locate ${folder}/${file}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (stored && stored.path === located.path && stored.sizeBytes === located.sizeBytes && stored.mtimeMs === located.mtimeMs && stored.rulesDigest === this.digest) {
      return stored;
    }
    const base = {
      schemaVersion: 1 as const,
      folder,
      file,
      sizeBytes: located.sizeBytes,
      mtimeMs: located.mtimeMs,
      path: located.path,
      rulesDigest: this.digest,
      observedAt: this.deps.now().toISOString(),
    };
    if (!file.toLowerCase().endsWith(".safetensors")) {
      // Other formats (.ckpt, .pt, .pth, .gguf) aren't read: a pickle can run code when loaded.
      return this.deps.store.putModelObservation({ ...base, outcome: "unreadable", matches: [], reason: "not a .safetensors file; only safetensors headers are read" });
    }
    let tensors: TensorShapes;
    try {
      tensors = await (this.deps.readHeader ?? readSafetensorsHeader)(located.path);
    } catch (err) {
      // A malformed header is a property of this file version and is cached with it; an I/O
      // error says nothing about the file and isn't.
      if (err instanceof HeaderReadError) {
        return this.deps.store.putModelObservation({ ...base, outcome: "unreadable", matches: [], reason: err.message });
      }
      return { folder, file, reason: `couldn't read the header of ${folder}/${file}: ${err instanceof Error ? err.message : String(err)}` };
    }
    return this.deps.store.putModelObservation({ ...base, ...classifyHeader(this.deps.rules, tensors) });
  }
}
