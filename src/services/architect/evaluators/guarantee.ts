// The planning check of a protected region (TODO 6.3.2; ARCH 2026-11-16, protected regions):
// whether the compiled graph keeps the pixels outside the task's mask, so a
// `protected_region_exact` criterion can hold before anything runs. Data in, data out; the
// comparison after the run is protected-region.ts.

import type { InputSizes } from "../output-size.js";
import { type AcceptanceCriterion, type ApiGraph, type CheckResult, type Recipe, type TaskSpec, parseAssetId, taskInputPaths } from "../schemas.js";

type ProtectedRegionCriterion = Extract<AcceptanceCriterion, { kind: "protected_region_exact" }>;

function isLink(v: unknown): v is [string, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number";
}

/** The node a slot fed from a task input path loads, if the recipe has one. */
function loaderFor(recipe: Pick<Recipe, "slots">, path: string): string | undefined {
  return recipe.slots.find((s) => s.valueType === "input_image" && s.fromTask === path)?.target.node;
}

/** The asset id the task gives for an input path. */
function assetAt(task: TaskSpec, path: string): string | undefined {
  return taskInputPaths(task.inputs).find((e) => e.path === path)?.input.assetId;
}

/** A reason the graph doesn't guarantee the protected region. */
type GuaranteeProblem = { verdict: "fail" | "unknown"; why: string };

/**
 * Why the graph doesn't keep the pixels outside the mask (a `fail`, or an `unknown` when that
 * can't be decided), or undefined when it does: every recipe output must save an
 * `ImageCompositeMasked` at x 0, y 0 without resizing, whose destination is the source's
 * `LoadImage` (through an `ImageScale` only to the source's own size) and whose mask is the
 * mask's `LoadImageMask` reading the red channel. `compiled` is false for the recipe's own
 * graph, whose literal sizes aren't the task's.
 */
function guaranteeProblem(
  graph: ApiGraph,
  compiled: boolean,
  recipe: Pick<Recipe, "slots" | "outputs">,
  task: TaskSpec,
  criterion: ProtectedRegionCriterion,
  sizes: InputSizes | undefined,
): GuaranteeProblem | undefined {
  const fail = (why: string): GuaranteeProblem => ({ verdict: "fail", why });
  const sourceNode = loaderFor(recipe, "inputs.source_image");
  const maskNode = loaderFor(recipe, "inputs.mask");
  if (sourceNode === undefined || maskNode === undefined) return fail("the recipe takes no source image and mask to composite");
  const sourceAsset = assetAt(task, "inputs.source_image");
  const maskAsset = assetAt(task, "inputs.mask");
  if (criterion.sourceAssetId !== sourceAsset) {
    return fail(`the criterion protects ${criterion.sourceAssetId}, but the image the recipe edits is ${sourceAsset ?? "not given"} (inputs.source_image)`);
  }
  if (criterion.maskAssetId !== maskAsset) {
    return fail(`the criterion's mask is ${criterion.maskAssetId}, but the mask the recipe reads is ${maskAsset ?? "not given"} (inputs.mask)`);
  }
  if (graph[sourceNode]?.class_type !== "LoadImage") return fail(`the source is loaded by ${graph[sourceNode]?.class_type ?? "no node"}, not LoadImage`);
  const maskLoader = graph[maskNode];
  if (maskLoader?.class_type !== "LoadImageMask" || maskLoader.inputs.channel !== "red") {
    const channel = maskLoader?.inputs.channel !== undefined ? `, channel ${JSON.stringify(maskLoader.inputs.channel)}` : "";
    return fail(`the mask isn't read from its red channel by LoadImageMask (${maskLoader?.class_type ?? "no node"}${channel})`);
  }
  for (const o of recipe.outputs) {
    const images = graph[o.node]?.inputs.images;
    if (!isLink(images) || images[1] !== 0) return fail(`output ${o.role} (node ${o.node}) doesn't save a composited image`);
    const composite = graph[images[0]];
    if (composite?.class_type !== "ImageCompositeMasked") {
      return fail(`output ${o.role} saves ${composite?.class_type ?? "nothing"} (node ${images[0]}), not an ImageCompositeMasked of the repainted area over the source`);
    }
    const c = composite.inputs;
    if (c.x !== 0 || c.y !== 0 || c.resize_source !== false) {
      return fail(`the composite (node ${images[0]}) shifts or resizes the repainted area (x ${JSON.stringify(c.x)}, y ${JSON.stringify(c.y)}, resize_source ${JSON.stringify(c.resize_source)})`);
    }
    if (!isLink(c.mask) || c.mask[0] !== maskNode || c.mask[1] !== 0) return fail(`the composite (node ${images[0]}) doesn't take its mask from the mask's loader (node ${maskNode})`);
    const dest = c.destination;
    if (!isLink(dest) || dest[1] !== 0) return fail(`the composite (node ${images[0]}) has no destination image`);
    if (dest[0] === sourceNode) continue;
    const scale: ApiGraph[string] | undefined = graph[dest[0]];
    if (scale?.class_type !== "ImageScale" || !isLink(scale.inputs.image) || scale.inputs.image[0] !== sourceNode || scale.inputs.image[1] !== 0) {
      return fail(`the composite's destination is ${scale?.class_type ?? "no node"} (node ${dest[0]}), not the source's loader`);
    }
    // A scale to the source's own size keeps every pixel; to another size it resamples them.
    if (!compiled) return { verdict: "unknown", why: "the graph scales the source before compositing, and without a compiled graph the size it scales to isn't known" };
    const parsed = parseAssetId(criterion.sourceAssetId);
    const dims = parsed.ok ? sizes?.get(parsed.name) : undefined;
    if (dims === undefined || !dims.ok) {
      return { verdict: "unknown", why: `the graph scales the source before compositing, and the source's size ${dims === undefined ? "wasn't read" : `isn't known (${dims.reason})`}` };
    }
    if (scale.inputs.width !== dims.width || scale.inputs.height !== dims.height) {
      return fail(
        `the graph scales the source (${dims.width}×${dims.height}) to ${JSON.stringify(scale.inputs.width)}×${JSON.stringify(scale.inputs.height)} before compositing, so the pixels outside the mask are resampled`,
      );
    }
  }
  return undefined;
}

/**
 * The planning checks of the task's `protected_region_exact` criteria (TODO 6.3.2): whether
 * the compiled graph keeps the pixels outside the mask. A required criterion on a graph
 * without that guarantee is a hard failure, an optional one a soft one, since only the
 * comparison after the run would show whether the pixels happened to survive.
 */
export function protectedRegionChecks(
  graph: ApiGraph | undefined,
  recipe: Pick<Recipe, "slots" | "outputs" | "graph">,
  task: TaskSpec,
  sizes: InputSizes | undefined,
): CheckResult[] {
  const out: CheckResult[] = [];
  for (const criterion of task.acceptance) {
    if (criterion.kind !== "protected_region_exact") continue;
    const check = (verdict: CheckResult["verdict"], message: string): CheckResult => ({
      id: `contract.protected_region.${criterion.id}`,
      layer: "contract",
      verdict,
      hard: criterion.required,
      message,
      enforcedBy: "validator.contract",
    });
    // Without a compiled graph (the contract failed), the recipe's own graph still shows a
    // structure that can't composite; only a pass needs the compiled one.
    const problem = guaranteeProblem(graph ?? recipe.graph, graph !== undefined, recipe, task, criterion, sizes);
    if (problem === undefined && graph === undefined) {
      out.push(check("unknown", `criterion ${criterion.id}: the recipe's graph composites over the source, but it didn't compile for this task, so the guarantee isn't confirmed`));
    } else if (problem === undefined) {
      out.push(
        check("pass", `criterion ${criterion.id}: every output composites the repainted area over the unchanged source with the task's mask, so the pixels outside the mask are the source's`),
      );
    } else if (problem.verdict === "unknown") {
      out.push(check("unknown", `criterion ${criterion.id}: ${problem.why}`));
    } else {
      out.push(check("fail", `criterion ${criterion.id}: the recipe doesn't guarantee the protected region: ${problem.why}`));
    }
  }
  return out;
}
