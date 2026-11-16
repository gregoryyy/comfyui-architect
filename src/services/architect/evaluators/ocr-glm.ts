// The OCR evaluator, `architect.ocr-glm` 1, for `text_in_image` criteria (spec §13.2; TODO
// 6.4.2; GAPS Q29; ARCH 2026-11-16, visual evaluators).
//
// The output image goes to `glm-ocr` on the Ollama host upstream uses, and only when that
// host is loopback: otherwise the image would leave the machine, so the verdict is `unknown`
// and nothing is sent, not even the model listing request (spec AT-09). The model is
// resolved from Ollama's `/api/tags`, since Ollama may hold it under a tag such as
// `glm-ocr:bf16` with no `latest`. The request runs at temperature 0 with `keep_alive` 0, so
// the model leaves memory afterwards, and the image is scaled to at most 2048 px on its long
// side.
//
// OCR uncertainty can't prove that text is there (spec §13.2): a reading passes only when it
// matches, fails only when it is non-empty and far from the text (best similarity below
// 0.5), and is `unknown` otherwise. The reading is text from an image, kept as data: it is
// compared and quoted, bounded, and never followed (spec §14.4).

import { z } from "zod";
import type { AcceptanceCriterion, Verdict } from "../schemas.js";
import { isLoopbackHostname } from "../validate.js";
import { OCR_GLM_EVALUATOR } from "./catalog.js";
import {
  type EvaluatorAvailability,
  type EvaluatorContext,
  type VisualEvaluator,
  type VisualVerdict,
  boundedText,
  combineVerdicts,
  messageOf,
  outputRef,
} from "./contract.js";

export const OCR_EVALUATOR_ID = OCR_GLM_EVALUATOR.id;
export const OCR_EVALUATOR_VERSION = OCR_GLM_EVALUATOR.version;
/** The Ollama model family the evaluator reads with; tags are `glm-ocr:<tag>`. */
export const OCR_MODEL_FAMILY = "glm-ocr";
/** The prompt GLM-OCR's model card gives for plain text. */
export const OCR_PROMPT = "Text Recognition:";
/** The long side, in pixels, an image is scaled down to before it is sent. */
export const OCR_MAX_SIDE = 2048;
/** How long the model may take for one image, a cold load included. */
export const DEFAULT_OCR_TIMEOUT_MS = 120_000;
/** How long `/api/tags` may take. */
export const OCR_TAGS_TIMEOUT_MS = 5_000;
/** Below this similarity a non-empty reading is a clear mismatch. */
export const OCR_FAIL_BELOW = 0.5;
/** The longest reading matched; a longer one is cut, and a cut reading never fails. */
export const OCR_MAX_READING_CHARS = 8_000;

type TextCriterion = Extract<AcceptanceCriterion, { kind: "text_in_image" }>;

// ---------------------------------------------------------------------------------------
// Matching

/** NFKC, whitespace runs folded to one space, trimmed, and lower case unless case-sensitive. */
export function normaliseText(text: string, caseSensitive: boolean): string {
  const folded = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return caseSensitive ? folded : folded.toLowerCase();
}

/** Levenshtein distance over code points. */
export function editDistance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}

/** The smallest edit distance between `pattern` and any substring of `text` (Sellers). */
export function substringDistance(pattern: string, text: string): number {
  const p = Array.from(pattern);
  const t = Array.from(text);
  // Row i: distances of pattern[0..i) against substrings of text ending at j; a match may
  // start anywhere, so row 0 is all zeros.
  let prev = new Array<number>(t.length + 1).fill(0);
  for (let i = 1; i <= p.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (p[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return Math.min(...prev);
}

/** A reading judged against the criterion. */
export interface ReadingVerdict {
  verdict: Verdict;
  /** 1 for a match; otherwise the best similarity found, 0 to 1. */
  similarity: number;
  note: string;
}

/**
 * The verdict rules: `pass` when the normalised reading matches (contains or equals the
 * text), `fail` when it is non-empty and its best match is below 0.5 similarity, `unknown`
 * otherwise: an empty reading, a near miss, or a reading cut at the length bound.
 */
export function judgeReading(reading: string, criterion: Pick<TextCriterion, "text" | "match" | "caseSensitive">, truncated = false): ReadingVerdict {
  const expected = normaliseText(criterion.text, criterion.caseSensitive);
  const got = normaliseText(reading, criterion.caseSensitive);
  if (expected === "") return { verdict: "unknown", similarity: 0, note: "the criterion's text is empty once whitespace is folded" };
  if (got === "") return { verdict: "unknown", similarity: 0, note: "the reading is empty, which doesn't show the text is absent" };
  const matched = criterion.match === "exact" ? got === expected : got.includes(expected);
  if (matched) return { verdict: "pass", similarity: 1, note: `the reading ${criterion.match === "exact" ? "is" : "contains"} the text` };
  const length = Array.from(expected).length;
  const similarity =
    criterion.match === "exact"
      ? 1 - editDistance(got, expected) / Math.max(length, Array.from(got).length)
      : 1 - substringDistance(expected, got) / length;
  const rounded = Math.round(Math.max(0, similarity) * 1000) / 1000;
  if (rounded < OCR_FAIL_BELOW && !truncated) {
    return { verdict: "fail", similarity: rounded, note: `the reading doesn't ${criterion.match === "exact" ? "equal" : "contain"} the text; its best match has similarity ${rounded}, below ${OCR_FAIL_BELOW}` };
  }
  return {
    verdict: "unknown",
    similarity: rounded,
    note: truncated
      ? `the reading was cut at ${OCR_MAX_READING_CHARS} characters and doesn't match within them (similarity ${rounded})`
      : `a near miss (similarity ${rounded}): OCR can misread text that is there, so this neither passes nor fails`,
  };
}

// ---------------------------------------------------------------------------------------
// The model

const TagsBody = z.object({
  models: z.array(z.object({ name: z.string().optional(), model: z.string().optional(), digest: z.string().optional() }).passthrough()),
});

/** The glm-ocr tag to use, or why there is none. */
export type OcrModel = { ok: true; name: string; digest?: string } | { ok: false; reason: string };

/**
 * The glm-ocr tag from `/api/tags`: names equal to `glm-ocr` or starting with `glm-ocr:`.
 * One such tag is used; with several, the one `preferred` (ARCHITECT_OCR_MODEL) names, and
 * none when it names none of them or is unset; with none, glm-ocr isn't installed.
 */
export function resolveOcrModel(tags: unknown, preferred: string | undefined): OcrModel {
  const parsed = TagsBody.safeParse(tags);
  if (!parsed.success) return { ok: false, reason: "Ollama's /api/tags answer isn't its model list" };
  const found = new Map<string, string | undefined>();
  for (const m of parsed.data.models) {
    const name = m.name ?? m.model;
    if (name === undefined) continue;
    if (name === OCR_MODEL_FAMILY || name.startsWith(`${OCR_MODEL_FAMILY}:`)) found.set(name, m.digest);
  }
  const names = [...found.keys()].sort();
  if (names.length === 0) return { ok: false, reason: `${OCR_MODEL_FAMILY} isn't installed in Ollama (ollama pull ${OCR_MODEL_FAMILY})` };
  const pick = (name: string): OcrModel => {
    const digest = found.get(name);
    return { ok: true, name, ...(digest ? { digest } : {}) };
  };
  if (names.length === 1) return pick(names[0]);
  if (preferred === undefined) {
    return { ok: false, reason: `Ollama has several ${OCR_MODEL_FAMILY} tags (${names.join(", ")}); ARCHITECT_OCR_MODEL names none, so which to use isn't decided` };
  }
  if (!found.has(preferred)) {
    return { ok: false, reason: `ARCHITECT_OCR_MODEL names ${boundedText(preferred, 100)}, which isn't one of Ollama's ${OCR_MODEL_FAMILY} tags (${names.join(", ")})` };
  }
  return pick(preferred);
}

const GenerateBody = z.object({ response: z.string() }).passthrough();
const ErrorBody = z.object({ error: z.string() }).passthrough();

/** The Ollama host, if it is a loopback URL; otherwise why OCR doesn't run. */
function loopbackHost(ctx: EvaluatorContext): { ok: true; host: string } | { ok: false; reason: string } {
  let host: string;
  let hostname: string;
  try {
    host = ctx.io.ollamaHost();
    hostname = new URL(host).hostname;
  } catch (err) {
    return { ok: false, reason: `the Ollama host isn't a URL: ${boundedText(messageOf(err), 200)}` };
  }
  if (!isLoopbackHostname(hostname)) {
    return { ok: false, reason: `Ollama at ${hostname} isn't loopback, and the output image would leave this machine; nothing was sent` };
  }
  return { ok: true, host };
}

/** One image read by the model: the reading, or why there is none. */
async function readImage(ctx: EvaluatorContext, host: string, model: string, bytes: Buffer): Promise<{ ok: true; reading: string } | { ok: false; reason: string }> {
  let png: Buffer;
  try {
    ({ png } = await ctx.io.imageForModel(bytes, OCR_MAX_SIDE));
  } catch (err) {
    return { ok: false, reason: `the image wasn't prepared for OCR: ${boundedText(messageOf(err), 300)}` };
  }
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_OCR_TIMEOUT_MS;
  let answer: { status: number; json: unknown };
  try {
    answer = await ctx.io.ollamaJson(host, "/api/generate", {
      body: { model, prompt: OCR_PROMPT, images: [png.toString("base64")], stream: false, keep_alive: 0, options: { temperature: 0 } },
      timeoutMs,
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { ok: false, reason: timedOut ? `${model} didn't answer within ${timeoutMs} ms` : `the OCR request failed: ${boundedText(messageOf(err), 300)}` };
  }
  if (answer.status !== 200) {
    const error = ErrorBody.safeParse(answer.json);
    const said = error.success ? `: ${boundedText(error.data.error, 200)}` : "";
    return {
      ok: false,
      reason: answer.status === 404 ? `Ollama doesn't have ${model} (HTTP 404${said})` : `Ollama answered HTTP ${answer.status}${said}`,
    };
  }
  const body = GenerateBody.safeParse(answer.json);
  if (!body.success) return { ok: false, reason: "Ollama's answer carries no reading" };
  return { ok: true, reading: body.data.response };
}

/** `architect.ocr-glm` 1: text in the output image, read by glm-ocr on a loopback Ollama. */
export const ocrGlmEvaluator: VisualEvaluator = {
  id: OCR_GLM_EVALUATOR.id,
  version: OCR_GLM_EVALUATOR.version,
  criterionKinds: OCR_GLM_EVALUATOR.criterionKinds,
  advisoryUnlessAccepted: OCR_GLM_EVALUATOR.advisoryUnlessAccepted,
  usesPool: true,
  availability: async (ctx): Promise<EvaluatorAvailability> => {
    const host = loopbackHost(ctx);
    return host.ok ? { available: true } : { available: false, reason: host.reason };
  },
  evaluate: async (criterion, ctx): Promise<VisualVerdict> => {
    if (criterion.kind !== "text_in_image") {
      return { verdict: "unknown", explanation: `${OCR_EVALUATOR_ID} doesn't judge ${criterion.kind} criteria`, evidence: [] };
    }
    return evaluateText(criterion, ctx);
  },
};

async function evaluateText(criterion: TextCriterion, ctx: EvaluatorContext): Promise<VisualVerdict> {
  const evidence = ctx.outputs.map((o) => outputRef(o.ref));
  const unknown = (explanation: string): VisualVerdict => ({ verdict: "unknown", explanation, evidence });
  // Checked again here: availability may have been decided before the host changed.
  const host = loopbackHost(ctx);
  if (!host.ok) return unknown(host.reason);
  if (ctx.outputs.length === 0) return unknown("the run listed no output file to read");

  let tags: { status: number; json: unknown };
  try {
    tags = await ctx.io.ollamaJson(host.host, "/api/tags", { timeoutMs: OCR_TAGS_TIMEOUT_MS });
  } catch (err) {
    return unknown(`Ollama's model list couldn't be read: ${boundedText(messageOf(err), 300)}`);
  }
  if (tags.status !== 200) return unknown(`Ollama's model list answered HTTP ${tags.status}`);
  const model = resolveOcrModel(tags.json, ctx.ocrModel);
  if (!model.ok) return unknown(model.reason);
  const using = `${model.name}${model.digest ? ` (digest ${boundedText(model.digest, 80)})` : ""}`;

  const verdicts: Verdict[] = [];
  const notes: string[] = [];
  let similarity: number | undefined;
  for (const out of ctx.outputs) {
    const ref = outputRef(out.ref);
    if (out.bytes === undefined) {
      verdicts.push("unknown");
      notes.push(`${ref}: not fetched (${out.reason ?? "no reason recorded"})`);
      continue;
    }
    const read = await readImage(ctx, host.host, model.name, out.bytes);
    if (!read.ok) {
      verdicts.push("unknown");
      notes.push(`${ref}: ${read.reason}`);
      continue;
    }
    const truncated = read.reading.length > OCR_MAX_READING_CHARS;
    const reading = truncated ? read.reading.slice(0, OCR_MAX_READING_CHARS) : read.reading;
    const judged = judgeReading(reading, criterion, truncated);
    verdicts.push(judged.verdict);
    similarity = similarity === undefined ? judged.similarity : Math.min(similarity, judged.similarity);
    notes.push(`${ref}: read ${JSON.stringify(boundedText(reading))}; ${judged.note}`);
  }
  const wanted = `${criterion.match === "exact" ? "exactly" : "containing"} ${JSON.stringify(boundedText(criterion.text))}${criterion.caseSensitive ? ", case-sensitive" : ""}`;
  return {
    verdict: combineVerdicts(verdicts),
    explanation: `${using} on ${host.host} looked for text ${wanted}; ${notes.join("; ")}`,
    ...(similarity !== undefined ? { measurement: { value: similarity, unit: "similarity" } } : {}),
    evidence,
  };
}
