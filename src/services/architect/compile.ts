// Recipe compiler: a recipe, a task and slot bindings to an API-format graph (spec §10.2).
//
// Data in, data out (STYLE): no store, no facade, no clock. The recipe is never mutated;
// the graph is a copy with every slot written. The compiler decides only the contract
// layer (spec §10.3): whether the recipe fits the task and whether every slot value is
// well-typed. Whether the graph runs on the target is the validator's job (validate.ts).

import { canonicalJson, sha256Hex } from "./hash.js";
import { type ApiGraph, type CheckResult, type PlanCandidate, type Recipe, type RecipeSlot, type TaskSpec, parseAssetId, taskInputPaths } from "./schemas.js";

/** Slot ID to value, as a `PlanCandidate` stores it. Values come from the agent or the user. */
export type Bindings = PlanCandidate["bindings"];

/** Re-exported for callers that already import it from here. */
export { canonicalJson };

/** What `compileRecipe` returns. `graph` and `fingerprint` are absent when a hard check failed. */
export interface CompileResult {
  graph?: ApiGraph;
  /** Each output role and each slot ID to its node ID in the graph (spec §10.2). */
  roleMap: Record<string, string>;
  /** sha256 over the canonical JSON of `graph` (spec §10.5). */
  fingerprint?: string;
  /** The value each slot resolved to; slots without a valid value are absent. */
  values: Record<string, string | number>;
  /** Contract-layer checks, one per decision. */
  checks: CheckResult[];
}

const ENFORCED_BY = "validator.contract";

function check(id: string, verdict: CheckResult["verdict"], hard: boolean, message: string, nodeId?: string): CheckResult {
  return { id, layer: "contract", verdict, hard, message, enforcedBy: ENFORCED_BY, ...(nodeId ? { nodeId } : {}) };
}

/** The canonical graph hash a candidate and its export carry (spec §10.5). */
export function graphFingerprint(graph: ApiGraph): string {
  return sha256Hex(canonicalJson(graph));
}

/**
 * Read a dotted path such as `media.output.width` from the task. Own properties only, so a
 * recipe's `fromTask` can't reach `__proto__` or `constructor`.
 */
function readTaskPath(task: TaskSpec, path: string): unknown {
  let cur: unknown = task;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur) || !Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** The value when it fits `slot`'s type and bounds, else the reason it doesn't. */
function checkSlotValue(slot: RecipeSlot, value: unknown): { value: string | number } | { problem: string } {
  switch (slot.valueType) {
    case "int":
    case "float":
    case "seed": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { problem: `expected a finite number, got ${JSON.stringify(value)}` };
      }
      if (slot.valueType === "int" && !Number.isInteger(value)) return { problem: `expected an integer, got ${value}` };
      // A seed above 2^53 can't be held exactly in a JS number; writing a rounded seed
      // would silently run a different seed than the one recorded (spec §10.2).
      if (slot.valueType === "seed" && (!Number.isSafeInteger(value) || value < 0)) {
        return { problem: `expected a non-negative safe integer seed, got ${value}` };
      }
      if (slot.min !== undefined && value < slot.min) return { problem: `${value} is below the minimum ${slot.min}` };
      if (slot.max !== undefined && value > slot.max) return { problem: `${value} is above the maximum ${slot.max}` };
      return { value };
    }
    case "string":
    case "model_file":
    case "input_image":
    case "enum": {
      if (typeof value !== "string" || value.trim().length === 0) {
        return { problem: `expected a non-empty string, got ${JSON.stringify(value)}` };
      }
      if (slot.valueType === "enum" && slot.choices === undefined) return { problem: "the recipe's enum slot lists no choices" };
      if (slot.choices !== undefined && !slot.choices.includes(value)) {
        return { problem: `"${value}" is not one of ${slot.choices.map((c) => `"${c}"`).join(", ")}` };
      }
      return { value };
    }
  }
}

/**
 * Whether the recipe honours every output-shape field and input the task sets (spec §7.3,
 * §10.3; GAPS Q16). A field is honoured when a slot fills from it, or when what the recipe
 * declares it writes matches. A definite mismatch fails, as unsupported; a field nothing
 * decides is a hard unknown, never a pass, so a task isn't relaxed by being ignored.
 */
function taskFieldChecks(recipe: Recipe, task: TaskSpec): CheckResult[] {
  const out: CheckResult[] = [];
  const consumed = new Set(recipe.slots.flatMap((s) => (s.fromTask !== undefined ? [s.fromTask] : [])));
  // A slot with a divisor writes a fraction of the task's value; the recipe declares that its
  // graph scales the result back, as an output declaration states the format it writes.
  const divisors = new Map(
    recipe.slots.flatMap((s) => (s.fromTask !== undefined && s.fromTaskDivisor !== undefined ? [[s.fromTask, s.fromTaskDivisor] as const] : [])),
  );
  const primary = recipe.outputs[0];
  const media = task.media;
  if (media.kind !== "image") return out;
  // A size taken from an input image needs that image's dimensions, which the compiler
  // doesn't read: the validator's contract layer decides width and height (output-size.ts).
  for (const dim of primary.scaleOfInput ? [] : (["width", "height"] as const)) {
    const path = `media.output.${dim}`;
    const divisor = divisors.get(path);
    out.push(
      consumed.has(path)
        ? check(
            `contract.task.${dim}`,
            "pass",
            true,
            divisor === undefined
              ? `the recipe sets the output ${dim} from the task (${media.output[dim]})`
              : `the recipe sets the output ${dim} from the task (${media.output[dim]}): it generates at 1/${divisor} and its graph scales back`,
          )
        : check(
            `contract.task.${dim}`,
            "unknown",
            true,
            `the recipe doesn't set the output ${dim}; whether the result is ${media.output[dim]} isn't known`,
          ),
    );
  }
  const declared = (field: "count" | "format", want: string | number): CheckResult => {
    const id = `contract.task.${field}`;
    if (consumed.has(`media.output.${field}`)) return check(id, "pass", true, `the recipe sets the output ${field} from the task`);
    const has = primary[field];
    if (has === undefined) return check(id, "unknown", true, `the recipe doesn't declare its output ${field}; the task asks for ${want}`);
    return has === want
      ? check(id, "pass", true, `the recipe writes ${field} ${has}, as the task asks`)
      : check(id, "fail", true, `the recipe writes ${field} ${has}, the task asks for ${want}`);
  };
  out.push(declared("count", media.output.count), declared("format", media.output.format));
  out.push(...taskInputChecks(recipe, task));
  return out;
}

/**
 * One check per task input (GAPS Q16, Q33): it passes when an `input_image` slot takes it
 * and its asset names a file in the target's input folder. An asset of another form, or a
 * name that would leave the folder, fails; so does an input no slot takes, as unsupported,
 * because rendering without it would drop part of the task silently (spec §4.3).
 */
function taskInputChecks(recipe: Pick<Recipe, "id" | "slots">, task: TaskSpec): CheckResult[] {
  return taskInputPaths(task.inputs).map(({ path, input }) => {
    const id = `contract.task.${path}`;
    const parsed = parseAssetId(input.assetId);
    if (!parsed.ok) return check(id, "fail", true, `task ${path} (${input.role}): ${parsed.problem}`);
    const takers = recipe.slots.filter((s) => s.valueType === "input_image" && s.fromTask === path).map((s) => s.id);
    return takers.length > 0
      ? check(id, "pass", true, `task ${path} (${parsed.name} in the input folder) goes to slot ${takers.join(", ")}`)
      : check(
          id,
          "fail",
          true,
          `unsupported: recipe ${recipe.id} has no slot for task ${path} (${input.role}, ${input.assetId}); it would be ignored`,
        );
  });
}

/** The asset name an `input_image` slot takes from the task, or why it has none. */
function inputForSlot(slot: RecipeSlot, task: TaskSpec): { name: string } | { missing: string } | { problem: string } {
  const entry = taskInputPaths(task.inputs).find((e) => e.path === slot.fromTask);
  if (entry === undefined) return { missing: `the task gives no ${slot.fromTask}` };
  const parsed = parseAssetId(entry.input.assetId);
  return parsed.ok ? { name: parsed.name } : { problem: parsed.problem };
}

/**
 * Compile `recipe` for `task` with `bindings` (spec §10.2). Each slot takes, in order, its
 * explicit binding, the value at its `fromTask` path (divided by `fromTaskDivisor` when the
 * slot sets one), its default. An `input_image` slot takes only the task input its
 * `fromTask` names, written as the file's name in the input folder. A binding for a slot the
 * recipe doesn't have fails: an agent's typo must not be ignored while the default runs.
 * When any hard check fails, no graph is returned.
 */
export function compileRecipe(recipe: Recipe, task: TaskSpec, bindings: Bindings): CompileResult {
  const checks: CheckResult[] = [];
  const values: Record<string, string | number> = {};

  checks.push(
    recipe.kind === task.media.kind
      ? check("contract.kind", "pass", true, `recipe and task are both ${recipe.kind}`)
      : check("contract.kind", "fail", true, `recipe is ${recipe.kind}, task is ${task.media.kind}`),
  );
  checks.push(
    recipe.operations.includes(task.media.operation)
      ? check("contract.operation", "pass", true, `recipe supports ${task.media.operation}`)
      : check(
          "contract.operation",
          "fail",
          true,
          `recipe supports ${recipe.operations.join(", ")}, not ${task.media.operation}`,
        ),
  );

  checks.push(...taskFieldChecks(recipe, task));

  const slotIds = new Set(recipe.slots.map((s) => s.id));
  for (const id of Object.keys(bindings)) {
    if (!slotIds.has(id)) {
      checks.push(check(`contract.binding.${id}`, "fail", true, `binding "${id}" names no slot of recipe ${recipe.id}`));
    }
  }

  // structuredClone: the recipe is shared catalog data, and a compiled candidate must never
  // write back into it.
  const graph: ApiGraph = structuredClone(recipe.graph);

  for (const slot of recipe.slots) {
    const id = `contract.slot.${slot.id}`;
    const nodeId = slot.target.node;
    if (slot.valueType === "input_image") {
      // An input file comes from the task only, so the plan's approval names every file the
      // graph reads (GAPS Q33); a binding would put another file in the graph.
      if (Object.hasOwn(bindings, slot.id)) {
        checks.push(check(id, "fail", true, `slot ${slot.id} takes the task's ${slot.fromTask}; it can't be bound, revise the task's inputs instead`, nodeId));
        continue;
      }
      const resolved = inputForSlot(slot, task);
      if ("missing" in resolved) {
        checks.push(
          slot.required
            ? check(id, "fail", true, `missing input: required slot ${slot.id} needs ${slot.fromTask}, and ${resolved.missing}`, nodeId)
            : check(id, "not_applicable", false, `optional slot ${slot.id}: ${resolved.missing}; it keeps the recipe's value`, nodeId),
        );
        continue;
      }
      if ("problem" in resolved) {
        checks.push(check(id, "fail", true, `slot ${slot.id}: ${resolved.problem}`, nodeId));
        continue;
      }
      const node = graph[nodeId];
      if (node === undefined || Array.isArray(node.inputs[slot.target.input])) {
        checks.push(check(id, "fail", true, `slot ${slot.id} targets ${nodeId}.${slot.target.input}, which holds a link`, nodeId));
        continue;
      }
      node.inputs[slot.target.input] = resolved.name;
      values[slot.id] = resolved.name;
      checks.push(check(id, "pass", true, `slot ${slot.id} = ${JSON.stringify(resolved.name)} (task ${slot.fromTask})`, nodeId));
      continue;
    }
    const fromTaskRaw = slot.fromTask !== undefined ? readTaskPath(task, slot.fromTask) : undefined;
    const divisor = slot.fromTaskDivisor;
    const taskPath = divisor === undefined ? slot.fromTask : `${slot.fromTask} / ${divisor}`;
    let fromTask: unknown = fromTaskRaw;
    if (fromTaskRaw !== undefined && divisor !== undefined) {
      // Rounding would write a size the task didn't ask for, and the scaled-back output would
      // miss the task's size by a pixel: refuse instead (spec §4.3, nothing relaxed silently).
      if (typeof fromTaskRaw !== "number" || !Number.isInteger(fromTaskRaw / divisor)) {
        checks.push(
          check(
            id,
            "fail",
            true,
            `slot ${slot.id}: the task's ${slot.fromTask} (${JSON.stringify(fromTaskRaw)}) isn't divisible by ${divisor}, ` +
              `the factor this recipe generates at; choose a size divisible by ${divisor} or another recipe`,
            nodeId,
          ),
        );
        continue;
      }
      fromTask = fromTaskRaw / divisor;
    }
    let value: unknown;
    let source: string;
    if (Object.hasOwn(bindings, slot.id) && fromTask !== undefined && bindings[slot.id] !== fromTask) {
      // A slot the task fills can't be overridden by a binding: a smaller size or another
      // prompt would relax the task silently (AGENTS, spec §4.3; GAPS Q15). A change goes
      // through a new task revision. With a divisor, the binding is held to the divided value.
      checks.push(
        check(
          id,
          "fail",
          true,
          `slot ${slot.id}: binding ${JSON.stringify(bindings[slot.id])} differs from the task's ${taskPath} ` +
            `(${JSON.stringify(fromTask)}); revise the task instead`,
          nodeId,
        ),
      );
      continue;
    } else if (Object.hasOwn(bindings, slot.id)) {
      value = bindings[slot.id];
      source = "binding";
    } else if (fromTask !== undefined) {
      value = fromTask;
      source = `task ${taskPath}`;
    } else if (slot.default !== undefined) {
      value = slot.default;
      source = "default";
    } else {
      checks.push(
        slot.required
          ? check(id, "fail", true, `required slot ${slot.id} has no binding, task value or default`, nodeId)
          : check(id, "not_applicable", false, `optional slot ${slot.id} keeps the recipe's value`, nodeId),
      );
      continue;
    }

    const checked = checkSlotValue(slot, value);
    if ("problem" in checked) {
      checks.push(check(id, "fail", true, `slot ${slot.id} (${source}): ${checked.problem}`, nodeId));
      continue;
    }
    const accepted = checked.value;

    const node = graph[nodeId];
    // Recipe's schema guarantees the node exists; the input may still hold a link, and
    // overwriting a link with a literal would silently cut the graph.
    if (node === undefined || Array.isArray(node.inputs[slot.target.input])) {
      checks.push(
        check(id, "fail", true, `slot ${slot.id} targets ${nodeId}.${slot.target.input}, which holds a link`, nodeId),
      );
      continue;
    }
    node.inputs[slot.target.input] = accepted;
    values[slot.id] = accepted;
    checks.push(check(id, "pass", true, `slot ${slot.id} = ${JSON.stringify(accepted)} (${source})`, nodeId));
  }

  const roleMap: Record<string, string> = {};
  const collisions: string[] = [];
  for (const [key, nodeId] of [
    ...recipe.outputs.map((o) => [o.role, o.node] as const),
    ...recipe.slots.map((s) => [s.id, s.target.node] as const),
  ]) {
    if (Object.hasOwn(roleMap, key) && roleMap[key] !== nodeId) collisions.push(key);
    else roleMap[key] = nodeId;
  }
  if (collisions.length > 0) {
    checks.push(
      check("contract.role_map", "fail", true, `role or slot names map to different nodes: ${collisions.join(", ")}`),
    );
  }

  const hardFail = checks.some((c) => c.hard && c.verdict === "fail");
  if (hardFail) return { roleMap, values, checks };
  return { graph, roleMap, fingerprint: graphFingerprint(graph), values, checks };
}
