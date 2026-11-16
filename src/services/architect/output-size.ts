// Output size from input images (TODO 5.4; ARCH 2026-11-16, output size; GAPS Q16).
//
// A recipe that edits or upscales an image writes an output whose size follows the input:
// `scaleOfInput` declares the factor. The task's width and height can then only be checked
// against the input's dimensions, which planning reads from the target through the facade
// (`readInputFile`, bounded by upstream's /view reader, and `decodeImage`) before it
// validates, and hands to the validator as data. A recipe that scales an input to the task's
// size (`scalesInputToTask`) gets a soft check when the aspect ratios differ, since the graph
// would stretch the image. An input whose size couldn't be read is a hard unknown, never a
// pass or a mismatch (#796).

import { probeMedia } from "./media-probe.js";
import { type CheckResult, type Recipe, type TaskSpec, parseAssetId, taskInputPaths } from "./schemas.js";
import type { UpstreamFacade } from "./upstream.js";

/** An input image's pixel size, or why it isn't known. */
export type InputDimensions =
  | { ok: true; width: number; height: number; sizeBytes: number; channels?: number }
  | { ok: false; reason: string };

/** Input file name (as in `comfyui-input:<name>`) to what was read of its size. */
export type InputSizes = ReadonlyMap<string, InputDimensions>;

/** A side longer than this isn't decoded: no task output can be larger (TaskSpec's bound). */
export const MAX_DECODED_SIDE = 16384;

/** Aspect ratios further apart than this, relatively, get the soft stretch check. */
export const ASPECT_TOLERANCE = 0.01;

/** Whether a recipe takes a mask and a source image, whose sizes must then agree. */
function takesMask(recipe: Pick<Recipe, "slots">): boolean {
  const paths = recipe.slots.filter((s) => s.valueType === "input_image").map((s) => s.fromTask);
  return paths.includes("inputs.mask") && paths.includes("inputs.source_image");
}

/** The input paths whose size a recipe's checks depend on: its output's, and a mask's with its source. */
export function sizedInputPaths(recipe: Pick<Recipe, "outputs" | "slots">): string[] {
  return [
    ...new Set([
      ...recipe.outputs.flatMap((o) => [...(o.scaleOfInput ? [o.scaleOfInput.input] : []), ...(o.scalesInputToTask ? [o.scalesInputToTask] : [])]),
      ...(takesMask(recipe) ? ["inputs.source_image", "inputs.mask"] : []),
    ]),
  ];
}

/** The input file names of `task` whose sizes `recipes` need, without duplicates. */
export function inputNamesToSize(recipes: readonly Pick<Recipe, "outputs" | "slots">[], task: Pick<TaskSpec, "inputs">): string[] {
  const paths = new Set(recipes.flatMap(sizedInputPaths));
  const names = new Set<string>();
  for (const { path, input } of taskInputPaths(task.inputs)) {
    if (!paths.has(path)) continue;
    const parsed = parseAssetId(input.assetId);
    if (parsed.ok) names.add(parsed.name);
  }
  return [...names];
}

/**
 * Read the sizes of input files for one validation, through the facade: the bytes bounded by
 * `readInputFile`, the header's sides checked before the full decode. Every name gets an
 * entry; a read or decode that fails records why. Nothing is kept past the call, so the next
 * validation reads the files again and sees a replaced one.
 */
export async function readInputSizes(
  facade: Pick<UpstreamFacade, "readInputFile" | "decodeImage">,
  names: readonly string[],
): Promise<Map<string, InputDimensions>> {
  // One entry per name, keeping the byte length it was decoded from: an input named under
  // two paths (a source that is also a reference) is read and decoded once.
  const out = new Map<string, InputDimensions>();
  for (const name of names) {
    if (out.has(name)) continue;
    let bytes: Buffer;
    try {
      ({ bytes } = await facade.readInputFile(name));
    } catch (err) {
      out.set(name, { ok: false, reason: `couldn't read ${name} from the target's input folder: ${messageOf(err)}` });
      continue;
    }
    out.set(name, await decodeSize(facade, name, bytes));
  }
  return out;
}

async function decodeSize(facade: Pick<UpstreamFacade, "decodeImage">, name: string, bytes: Buffer): Promise<InputDimensions> {
  // The header gives the size cheaply; an image larger than any task output isn't decoded.
  // A format the header reader doesn't know (TIFF, AVIF) goes to the decoder, which has a
  // pixel limit of its own.
  const header = probeMedia(bytes);
  if (header.readable && (header.width > MAX_DECODED_SIDE || header.height > MAX_DECODED_SIDE)) {
    return { ok: false, reason: `${name} is ${header.width}×${header.height}, over the ${MAX_DECODED_SIDE}-pixel side bound; it wasn't decoded` };
  }
  try {
    const { width, height, channels } = await facade.decodeImage(bytes);
    return { ok: true, width, height, sizeBytes: bytes.length, ...(channels !== undefined ? { channels } : {}) };
  } catch (err) {
    return { ok: false, reason: `couldn't decode ${name} (${bytes.length} bytes): ${messageOf(err)}` };
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function check(id: string, verdict: CheckResult["verdict"], hard: boolean, message: string): CheckResult {
  return { id, layer: "contract", verdict, hard, message, enforcedBy: "validator.contract" };
}

/** The input file a task gives for `path`, or why there is none to measure. */
function inputAt(task: TaskSpec, path: string): { name: string } | { problem: string } {
  const entry = taskInputPaths(task.inputs).find((e) => e.path === path);
  if (entry === undefined) return { problem: `the task gives no ${path}` };
  const parsed = parseAssetId(entry.input.assetId);
  return parsed.ok ? { name: parsed.name } : { problem: parsed.problem };
}

/**
 * The contract checks of a recipe's output size against an input (ARCH 2026-11-16, output
 * size). For `scaleOfInput`: `contract.task.width` and `contract.task.height`, each passing
 * when the input's side times the factor is the task's, failing (hard, naming both sizes)
 * when it isn't or when the graph would round it down, unknown (hard) when the input's size
 * wasn't read. For `scalesInputToTask`: a soft `contract.input_aspect` check. Empty for a
 * recipe whose size comes from the task alone; the compiler checks that.
 */
export function outputSizeChecks(recipe: Pick<Recipe, "outputs" | "slots">, task: TaskSpec, sizes: InputSizes | undefined): CheckResult[] {
  if (task.media.kind !== "image") return [];
  const want = task.media.output;
  const primary = recipe.outputs[0];
  const out: CheckResult[] = [];
  const scale = primary.scaleOfInput;
  if (scale) {
    const both = (verdict: CheckResult["verdict"], message: string) =>
      (["width", "height"] as const).map((dim) => check(`contract.task.${dim}`, verdict, true, message));
    const at = inputAt(task, scale.input);
    const dims = "name" in at ? sizes?.get(at.name) : undefined;
    const factor = scale.factor === 1 ? "the size of" : `${scale.factor}× the size of`;
    if ("problem" in at) {
      out.push(...both("unknown", `the output is ${factor} ${scale.input}, and ${at.problem}; whether it is ${want.width}×${want.height} isn't known`));
    } else if (dims === undefined) {
      out.push(...both("unknown", `the output is ${factor} ${at.name}, whose size wasn't read; whether it is ${want.width}×${want.height} isn't known`));
    } else if (!dims.ok) {
      out.push(...both("unknown", `the output is ${factor} ${at.name}, whose size isn't known (${dims.reason}); whether it is ${want.width}×${want.height} isn't known`));
    } else {
      const source = `${at.name} (${dims.width}×${dims.height})`;
      for (const dim of ["width", "height"] as const) {
        const id = `contract.task.${dim}`;
        const exact = dims[dim] * scale.factor;
        const rounded = scale.multipleOf === undefined ? exact : Math.floor(exact / scale.multipleOf) * scale.multipleOf;
        if (!Number.isInteger(exact)) {
          out.push(check(id, "fail", true, `the output ${dim} would be ${exact}, ${factor} ${source}, not a whole number of pixels; the task asks for ${want.width}×${want.height}`));
        } else if (rounded !== exact) {
          out.push(
            check(
              id,
              "fail",
              true,
              `the output ${dim} would be ${rounded}: ${factor} ${source} is ${exact}, which the graph rounds down to a multiple of ${scale.multipleOf}; the task asks for ${want.width}×${want.height}`,
            ),
          );
        } else if (exact === want[dim]) {
          out.push(check(id, "pass", true, `the output is ${factor} ${source}: ${dims.width * scale.factor}×${dims.height * scale.factor}, as the task asks`));
        } else {
          out.push(
            check(
              id,
              "fail",
              true,
              `the output would be ${dims.width * scale.factor}×${dims.height * scale.factor}, ${factor} ${source}; the task asks for ${want.width}×${want.height}`,
            ),
          );
        }
      }
    }
  }
  if (primary.scalesInputToTask) {
    const path = primary.scalesInputToTask;
    const id = `contract.input_aspect.${path}`;
    const at = inputAt(task, path);
    const dims = "name" in at ? sizes?.get(at.name) : undefined;
    if ("problem" in at) {
      out.push(check(id, "unknown", false, `the graph scales ${path} to ${want.width}×${want.height}, and ${at.problem}`));
    } else if (dims === undefined || !dims.ok) {
      const why = dims === undefined ? "its size wasn't read" : dims.reason;
      out.push(check(id, "unknown", false, `the graph scales ${at.name} to ${want.width}×${want.height}; whether that stretches it isn't known: ${why}`));
    } else {
      const ratio = dims.width / dims.height / (want.width / want.height);
      const source = `${at.name} (${dims.width}×${dims.height})`;
      out.push(
        Math.abs(ratio - 1) > ASPECT_TOLERANCE
          ? check(id, "fail", false, `the graph scales ${source} to ${want.width}×${want.height}, another aspect ratio: the image would be stretched; a task size with the input's aspect ratio avoids it`)
          : check(id, "pass", false, `the graph scales ${source} to ${want.width}×${want.height}, the same aspect ratio within ${ASPECT_TOLERANCE * 100}%`),
      );
    }
  }
  out.push(...maskChecks(recipe, task, sizes));
  return out;
}

/**
 * A mask is read at the source image's pixels: one of another size would be stretched over
 * it, and the repainted area wouldn't be the one the user drew, so the sizes must be equal
 * (a hard check). The mask loaders read one channel; a file the decoder reports with one
 * channel holds the mask unambiguously, while a colour file's red channel is read as it is,
 * which a soft check says (GAPS Q33).
 */
export function maskChecks(recipe: Pick<Recipe, "slots">, task: TaskSpec, sizes: InputSizes | undefined): CheckResult[] {
  if (!takesMask(recipe)) return [];
  const source = inputAt(task, "inputs.source_image");
  const mask = inputAt(task, "inputs.mask");
  // A missing input fails its slot check; there is nothing to compare.
  if ("problem" in source || "problem" in mask) return [];
  const s = sizes?.get(source.name);
  const m = sizes?.get(mask.name);
  const out: CheckResult[] = [];
  if (s === undefined || m === undefined || !s.ok || !m.ok) {
    const why = [s, m].flatMap((d, i) => (d === undefined ? [`${i === 0 ? source.name : mask.name}'s size wasn't read`] : d.ok ? [] : [d.reason])).join("; ");
    out.push(check("contract.mask_size", "unknown", true, `whether mask ${mask.name} has the size of source ${source.name} isn't known: ${why}`));
  } else if (s.width === m.width && s.height === m.height) {
    out.push(check("contract.mask_size", "pass", true, `mask ${mask.name} has the source's size, ${s.width}×${s.height}`));
  } else {
    out.push(check("contract.mask_size", "fail", true, `mask ${mask.name} is ${m.width}×${m.height}, source ${source.name} is ${s.width}×${s.height}; the mask would be stretched over the image, so give a mask of the source's size`));
  }
  out.push(
    m?.ok === true && m.channels === 1
      ? check("contract.mask_channels", "pass", false, `mask ${mask.name} has one channel`)
      : check(
          "contract.mask_channels",
          "unknown",
          false,
          `mask channels unverified: ${mask.name} ${m?.ok === true && m.channels !== undefined ? `has ${m.channels} channels` : "wasn't decoded to a channel count"}; the graph reads its red channel as the mask (white repaints)`,
        ),
  );
  return out;
}
