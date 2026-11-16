// The protected-region evaluator, `architect.protected-region` 1 (spec §13.2; TODO 6.3; ARCH
// 2026-11-16, protected regions), and the planning check of the graph's guarantee.
//
// A `protected_region_exact` criterion says the pixels outside the mask are the source's.
// The source and the mask are task inputs: they are read again from the target's input
// folder and must have the sha256 the grant bound, since a file changed after the approval
// may or may not be what ComfyUI read. All three images are decoded as ComfyUI's loaders
// read them (8-bit RGB, EXIF orientation applied, alpha dropped). A protected pixel is one
// whose mask red channel is 0: the recipes read the mask's red channel, and white repaints.
// Each protected pixel may differ by at most the criterion's tolerance per channel.
//
// Colour handling is part of the criterion: a source or mask with an ICC profile, or more
// than 8 bits a sample, is decoded differently by sharp (which converts through the profile
// and reduces depth its own way) than by ComfyUI's PIL loader, which ignores the profile, so
// such a file makes the verdict `unknown`. The same holds for an output, though ComfyUI's
// SaveImage writes neither.

import { sha256Hex } from "../hash.js";
import { probeMedia } from "../media-probe.js";
import { MAX_DECODED_SIDE } from "../output-size.js";
import { type AcceptanceCriterion, parseAssetId } from "../schemas.js";
import { type DecodedPixels, ImageDecoderUnavailableError } from "../upstream.js";
import { PROTECTED_REGION_EVALUATOR } from "./catalog.js";
import {
  type EvaluatorContext,
  type VisualEvaluator,
  type VisualVerdict,
  boundedText,
  combineVerdicts,
  messageOf,
  outputRef,
} from "./contract.js";

export const PROTECTED_REGION_EVALUATOR_ID = PROTECTED_REGION_EVALUATOR.id;
export const PROTECTED_REGION_EVALUATOR_VERSION = PROTECTED_REGION_EVALUATOR.version;

type ProtectedRegionCriterion = Extract<AcceptanceCriterion, { kind: "protected_region_exact" }>;

/** The outcome of comparing one output with its source under a mask. */
export type RegionComparison =
  | { state: "compared"; protectedPixels: number; differingPixels: number; maxDifference: number }
  | { state: "size_mismatch"; detail: string };

/**
 * Compare an output with its source at every pixel the mask protects (red channel 0). A pixel
 * differs when any channel differs by more than `tolerance`. Pure: the images are decoded.
 */
export function compareProtectedRegion(source: DecodedPixels, mask: DecodedPixels, output: DecodedPixels, tolerance: number): RegionComparison {
  if (mask.width !== source.width || mask.height !== source.height) {
    return { state: "size_mismatch", detail: `the mask is ${mask.width}×${mask.height}, the source ${source.width}×${source.height}` };
  }
  if (output.width !== source.width || output.height !== source.height) {
    return { state: "size_mismatch", detail: `the output is ${output.width}×${output.height}, the source ${source.width}×${source.height}` };
  }
  let protectedPixels = 0;
  let differingPixels = 0;
  let maxDifference = 0;
  const pixels = source.width * source.height;
  for (let p = 0; p < pixels; p++) {
    const i = p * 3;
    if (mask.data[i] !== 0) continue;
    protectedPixels += 1;
    const d = Math.max(
      Math.abs(output.data[i] - source.data[i]),
      Math.abs(output.data[i + 1] - source.data[i + 1]),
      Math.abs(output.data[i + 2] - source.data[i + 2]),
    );
    if (d > maxDifference) maxDifference = d;
    if (d > tolerance) differingPixels += 1;
  }
  return { state: "compared", protectedPixels, differingPixels, maxDifference };
}

/** Why a decoded file can't be compared as ComfyUI read it, or undefined when it can. */
function colourProblem(what: string, d: DecodedPixels): string | undefined {
  if (d.hasIccProfile) return `${what} embeds an ICC profile, so ComfyUI's loader and this evaluator may read different colours`;
  if ((d.bitsPerSample !== undefined && d.bitsPerSample > 8) || (d.sampleFormat !== undefined && d.sampleFormat !== "uchar")) {
    return `${what} has more than 8 bits a sample (${d.sampleFormat ?? `${d.bitsPerSample} bits`}), which ComfyUI's loader reduces differently from this evaluator`;
  }
  return undefined;
}

type Decoded = { ok: true; pixels: DecodedPixels } | { ok: false; reason: string };

async function decode(ctx: EvaluatorContext, what: string, bytes: Buffer): Promise<Decoded> {
  // The header bounds the decode: no task image is larger than this.
  const header = probeMedia(bytes);
  if (header.readable && (header.width > MAX_DECODED_SIDE || header.height > MAX_DECODED_SIDE)) {
    return { ok: false, reason: `${what} is ${header.width}×${header.height}, over the ${MAX_DECODED_SIDE}-pixel side bound; it wasn't decoded` };
  }
  try {
    const pixels = await ctx.io.decodePixels(bytes);
    const problem = colourProblem(what, pixels);
    return problem === undefined ? { ok: true, pixels } : { ok: false, reason: problem };
  } catch (err) {
    const why = err instanceof ImageDecoderUnavailableError ? messageOf(err) : `it doesn't decode: ${boundedText(messageOf(err), 300)}`;
    return { ok: false, reason: `${what} wasn't decoded; ${why}` };
  }
}

/** A task input re-read and checked against the sha256 the grant bound, then decoded. */
async function approvedInput(ctx: EvaluatorContext, assetId: string, role: string): Promise<Decoded> {
  const approved = ctx.approvedInputs.find((i) => i.assetId === assetId);
  if (approved === undefined) return { ok: false, reason: `the grant binds no ${role} ${assetId}, so the content ComfyUI read isn't known` };
  const parsed = parseAssetId(assetId);
  if (!parsed.ok) return { ok: false, reason: parsed.problem };
  let bytes: Buffer;
  try {
    ({ bytes } = await ctx.io.readInputFile(parsed.name));
  } catch (err) {
    return { ok: false, reason: `the ${role} ${assetId} couldn't be read again: ${boundedText(messageOf(err), 300)}` };
  }
  const sha256 = sha256Hex(bytes);
  if (sha256 !== approved.sha256 || bytes.length !== approved.sizeBytes) {
    return {
      ok: false,
      reason: `the ${role} ${assetId} changed since the approval (sha256 ${approved.sha256.slice(0, 8)}, now ${sha256.slice(0, 8)}), so whether ComfyUI read the approved file isn't known`,
    };
  }
  return decode(ctx, `the ${role} ${assetId}`, bytes);
}

/** `architect.protected-region` 1: the pixels outside the mask against the source's. */
export const protectedRegionEvaluator: VisualEvaluator = {
  id: PROTECTED_REGION_EVALUATOR.id,
  version: PROTECTED_REGION_EVALUATOR.version,
  criterionKinds: PROTECTED_REGION_EVALUATOR.criterionKinds,
  advisoryUnlessAccepted: PROTECTED_REGION_EVALUATOR.advisoryUnlessAccepted,
  usesPool: false,
  availability: async () => ({ available: true }),
  evaluate: async (criterion, ctx): Promise<VisualVerdict> => {
    if (criterion.kind !== "protected_region_exact") {
      return { verdict: "unknown", explanation: `${PROTECTED_REGION_EVALUATOR_ID} doesn't judge ${criterion.kind} criteria`, evidence: [] };
    }
    return evaluateRegion(criterion, ctx);
  },
};

async function evaluateRegion(criterion: ProtectedRegionCriterion, ctx: EvaluatorContext): Promise<VisualVerdict> {
  const tolerance = criterion.tolerance ?? 0;
  const inputs = [criterion.sourceAssetId, criterion.maskAssetId];
  const evidence = [...inputs, ...ctx.outputs.map((o) => outputRef(o.ref))];
  const unknown = (explanation: string): VisualVerdict => ({ verdict: "unknown", explanation, evidence });
  if (ctx.outputs.length === 0) return unknown("the run listed no output file to compare");

  const source = await approvedInput(ctx, criterion.sourceAssetId, "source");
  if (!source.ok) return unknown(source.reason);
  const mask = await approvedInput(ctx, criterion.maskAssetId, "mask");
  if (!mask.ok) return unknown(mask.reason);

  const verdicts: VisualVerdict["verdict"][] = [];
  const notes: string[] = [];
  let differing = 0;
  let compared = 0;
  for (const out of ctx.outputs) {
    const ref = outputRef(out.ref);
    if (out.bytes === undefined) {
      verdicts.push("unknown");
      notes.push(`${ref}: not fetched (${out.reason ?? "no reason recorded"})`);
      continue;
    }
    const decoded = await decode(ctx, `the output ${ref}`, out.bytes);
    if (!decoded.ok) {
      verdicts.push("unknown");
      notes.push(decoded.reason);
      continue;
    }
    const result = compareProtectedRegion(source.pixels, mask.pixels, decoded.pixels, tolerance);
    if (result.state === "size_mismatch") {
      // A mask of another size leaves the region undefined in source pixels; an output of
      // another size can't keep the source's pixels where they were.
      const maskProblem = result.detail.startsWith("the mask");
      verdicts.push(maskProblem ? "unknown" : "fail");
      notes.push(`${ref}: ${result.detail}`);
      continue;
    }
    compared += 1;
    if (result.protectedPixels === 0) {
      verdicts.push("not_applicable");
      notes.push(`${ref}: the mask protects no pixel`);
      continue;
    }
    differing += result.differingPixels;
    verdicts.push(result.differingPixels === 0 ? "pass" : "fail");
    notes.push(
      `${ref}: ${result.differingPixels} of ${result.protectedPixels} protected pixels differ by more than ${tolerance} per channel; the largest difference is ${result.maxDifference}`,
    );
  }
  const verdict = combineVerdicts(verdicts);
  return {
    verdict,
    explanation: `protected pixels are the mask's red channel at 0, compared with the source in 8-bit RGB after EXIF orientation; ${notes.join("; ")}`,
    ...(compared > 0 ? { measurement: { value: differing, unit: "pixels" } } : {}),
    evidence,
  };
}
