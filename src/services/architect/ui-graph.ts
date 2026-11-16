// The UI graph an export writes, and the round trip it must survive (FR-07, spec §10.4,
// AT-11; TODO 5.5; ARCH 2026-11-16, UI export).
//
// The API graph stays the execution authority. The UI graph is made from it with
// upstream's `convertApiToUi`, and is offered only when converting it back with
// `convertUiToApi` gives the same executable graph, modulo the fields below. Each of them
// is something the frontend writes or drops on its own, so it doesn't change what runs:
//
// - `_meta` on any node: titles and layout hints, which ComfyUI doesn't execute.
// - An input the API graph leaves out that comes back holding the node schema's default
//   (its `default`, else a COMBO's first choice): the frontend writes every widget when it
//   queues, so the default is what an omitted widget runs with from the canvas.
// - The form of a link: `["4", 0]` and `[4, 0]` name the same output.
//
// Every other change is a difference, named by node and input.

import type { ObjectInfo } from "../../comfyui/types.js";
import type { ApiGraph } from "./schemas.js";
import { apiToUi, uiToApi } from "./upstream.js";

/** One way the graph that came back differs from the one exported. */
export interface RoundTripDifference {
  node: string;
  input?: string;
  problem: string;
}

/** What converting a graph to the UI format and back gave. */
export interface RoundTrip {
  ui: Record<string, unknown>;
  /** Warnings of both conversions, as upstream wrote them. */
  warnings: string[];
  differences: RoundTripDifference[];
}

/** The default a node schema declares for an input: `default`, else a COMBO's first choice. */
function schemaDefault(objectInfo: ObjectInfo, classType: string, input: string): { value: unknown } | undefined {
  const def = objectInfo[classType];
  const spec = def?.input.optional?.[input] ?? def?.input.required?.[input];
  if (!spec) return undefined;
  const [type, options] = spec;
  if (options && "default" in options) return { value: options.default };
  if (Array.isArray(type) && type.length > 0) return { value: type[0] };
  const choices = options?.options;
  if (type === "COMBO" && Array.isArray(choices) && choices.length > 0) return { value: choices[0] };
  return undefined;
}

/** A value with links in one form, so `["4", 0]` and `[4, 0]` compare equal. */
function normalised(value: unknown): string {
  if (Array.isArray(value) && value.length === 2 && (typeof value[0] === "string" || typeof value[0] === "number") && typeof value[1] === "number") {
    return JSON.stringify([String(value[0]), value[1]]);
  }
  return JSON.stringify(value);
}

/**
 * Convert `graph` to a UI workflow and back, and list how the result differs from `graph`
 * outside the nonsemantic fields this file documents. Empty `differences` means the UI
 * workflow loads to the same executable graph.
 */
export function uiRoundTrip(graph: ApiGraph, objectInfo: ObjectInfo): RoundTrip {
  const ui = apiToUi(graph, objectInfo);
  const back = uiToApi(ui.workflow, objectInfo);
  const differences: RoundTripDifference[] = [];
  for (const [id, node] of Object.entries(graph)) {
    const other = back.graph[id];
    if (!other) {
      differences.push({ node: id, problem: `${node.class_type} is missing after the round trip` });
      continue;
    }
    if (other.class_type !== node.class_type) {
      differences.push({ node: id, problem: `class ${node.class_type} came back as ${other.class_type}` });
      continue;
    }
    const names = new Set([...Object.keys(node.inputs), ...Object.keys(other.inputs)]);
    for (const input of [...names].sort()) {
      const had = Object.hasOwn(node.inputs, input);
      const has = Object.hasOwn(other.inputs, input);
      if (had && !has) {
        differences.push({ node: id, input, problem: `${node.class_type}.${input} was dropped` });
      } else if (!had && has) {
        const d = schemaDefault(objectInfo, node.class_type, input);
        if (!d || normalised(d.value) !== normalised(other.inputs[input])) {
          differences.push({ node: id, input, problem: `${node.class_type}.${input} was added as ${normalised(other.inputs[input])}` });
        }
      } else if (normalised(node.inputs[input]) !== normalised(other.inputs[input])) {
        differences.push({
          node: id,
          input,
          problem: `${node.class_type}.${input} was ${normalised(node.inputs[input])}, came back as ${normalised(other.inputs[input])}`,
        });
      }
    }
  }
  for (const [id, node] of Object.entries(back.graph)) {
    if (!Object.hasOwn(graph, id)) differences.push({ node: id, problem: `${node.class_type} appeared in the round trip` });
  }
  return { ui: ui.workflow, warnings: [...ui.warnings, ...back.warnings], differences };
}

/** The UI workflow to export, or why there is none. */
export type UiExport =
  | { ok: true; workflow: Record<string, unknown>; warnings: string[] }
  | { ok: false; reason: string; differences: RoundTripDifference[] };

/**
 * The UI workflow of an API graph, offered only when it round-trips (spec §10.4: no claim
 * of a lossless UI graph that doesn't load back to the same execution graph).
 */
export function exportUiGraph(graph: ApiGraph, objectInfo: ObjectInfo): UiExport {
  let rt: RoundTrip;
  try {
    rt = uiRoundTrip(graph, objectInfo);
  } catch (err) {
    return { ok: false, reason: `upstream's converter failed: ${err instanceof Error ? err.message : String(err)}`, differences: [] };
  }
  if (rt.differences.length > 0) {
    const named = rt.differences.slice(0, 5).map((d) => `node ${d.node}${d.input ? `.${d.input}` : ""}: ${d.problem}`);
    return { ok: false, reason: `the UI graph doesn't load back to the same graph (${named.join("; ")})`, differences: rt.differences };
  }
  return { ok: true, workflow: rt.ui, warnings: rt.warnings };
}
