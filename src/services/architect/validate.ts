// Layered graph validation (spec §10.3): contract, structure, native types, semantic types,
// dependencies, policy, runtime.
//
// Data in, data out: the caller passes the target's node schemas (/object_info) and the
// environment snapshot it already holds. A schema the probe could not read is unknown, and
// every check that needs it says unknown and stays hard, never pass (#796). Each check names
// the layer that decided it (`validator.<layer>`).

import type { ComfyUINodeDef, NodeInputSpec, ObjectInfo } from "../../comfyui/types.js";
import { compileRecipe, graphFingerprint, type Bindings, type CompileResult } from "./compile.js";
import { type InputSizes, outputSizeChecks } from "./output-size.js";
import type {
  ApiGraph,
  CheckResult,
  EnvironmentSnapshot,
  FamilyRule,
  ModelObservation,
  PlanCandidate,
  Recipe,
  RecipeSlot,
  TaskSpec,
  ValidationLayer,
  ValidationReport,
} from "./schemas.js";

/**
 * What planning read of the bound model files' families (TODO 5.3): the shipped rules and
 * the observations keyed `<folder>/<file>`. A file with no observation here is checked as
 * before observations existed, so validation runs without a reader (tests, offline).
 */
export interface FamilyEvidence {
  rules: readonly FamilyRule[];
  observations: ReadonlyMap<string, ModelObservation>;
}

/** The key of a model file in `FamilyEvidence.observations`. */
export function observationKey(folder: string, file: string): string {
  return `${folder}/${file}`;
}

/** The rule a slot's `modelFamily` names, by id or alias, for the slot's folder. */
export function ruleForFamily(rules: readonly FamilyRule[], family: string, folder: string): FamilyRule | undefined {
  return rules.find((r) => (r.id === family || (r.aliases ?? []).includes(family)) && r.folders.includes(folder));
}

/** What `validateGraph` checks. */
export interface ValidateInput {
  /** The graph to check. Absent: the graph `compileRecipe` yields for these bindings. */
  graph?: ApiGraph;
  recipe: Recipe;
  task: TaskSpec;
  bindings: Bindings;
  /** Graph transformations the candidate applies; none are allowlisted in milestone 2. */
  transforms?: PlanCandidate["transforms"];
  /** The target's /object_info. Undefined when the probe failed: unknown, not empty. */
  objectInfo?: ObjectInfo;
  snapshot: EnvironmentSnapshot;
  /** Decides whether a node definition spends money remotely. Defaults to `isPaidRenderNode`. */
  isPaidNode?: (def: ComfyUINodeDef) => boolean;
  /** Observed model families; absent, every family check stays unknown (GAPS Q14). */
  families?: FamilyEvidence;
  /**
   * The sizes of the task's input files a recipe sizes its output from (output-size.ts);
   * absent, those size checks are hard unknowns.
   */
  inputSizes?: InputSizes;
}

/** The report and the dependencies found missing, for `PlanCandidate.dependencyDelta`. */
export interface ValidationOutcome {
  report: ValidationReport;
  /** Only definite answers: a folder or node list that wasn't read adds nothing here (#796). */
  dependencyDelta: PlanCandidate["dependencyDelta"];
}

type Verdict = CheckResult["verdict"];

function mk(layer: ValidationLayer) {
  return (id: string, verdict: Verdict, hard: boolean, message: string, nodeId?: string): CheckResult => ({
    id: `${layer}.${id}`,
    layer,
    verdict,
    hard,
    message,
    enforcedBy: `validator.${layer}`,
    ...(nodeId !== undefined ? { nodeId } : {}),
  });
}

const NO_SCHEMAS = "the target's node schemas (/object_info) could not be read";

/** A link value in API format: `[sourceNodeId, outputIndex]`. */
function isLink(v: unknown): v is [string, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number";
}

/** The declared spec of an input, from the required or optional group. Hidden inputs are filled by ComfyUI. */
function inputSpec(def: ComfyUINodeDef, name: string): NodeInputSpec | undefined {
  const req = def.input?.required ?? {};
  if (Object.hasOwn(req, name)) return req[name];
  const opt = def.input?.optional ?? {};
  if (Object.hasOwn(opt, name)) return opt[name];
  return undefined;
}

/** The choices of a COMBO input, classic (`[[...choices]]`) or V3 (`["COMBO", { options }]`). */
function comboChoices(spec: NodeInputSpec): { combo: false } | { combo: true; choices?: unknown[] } {
  const [type, opts] = spec;
  if (Array.isArray(type)) return { combo: true, choices: type };
  if (type === "COMBO") {
    const options = opts?.options;
    return { combo: true, ...(Array.isArray(options) ? { choices: options } : {}) };
  }
  return { combo: false };
}

/** Truthy for an explicit marker: `true`, or a string naming a provider (not "false"). */
function marked(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const s = value.trim().toLowerCase();
  return s.length > 0 && s !== "false";
}

/** Input names that authenticate to a remote service, after camelCase is folded to snake_case. */
const CREDENTIAL_INPUT_RE =
  /^(?:.*_)?(?:api_key|api_token|api_secret|access_token|auth_token|bearer_token|client_secret)$/;

/**
 * Whether a node definition spends money on a remote service. ComfyUI's /object_info marks
 * partner API nodes with `api_node: true` and an "api node/…" category; third-party packs
 * may mark themselves with `external_api_node` / `EXTERNAL_API_NODE`; a node that asks for
 * an API credential can't be confirmed free. These are the signals upstream's
 * `isApiNode` and `isExternalServiceNode` (src/services/api-nodes.ts) read, minus their
 * registry of known paid packs. Planning passes upstream's classifier from the facade as
 * `ValidateInput.isPaidNode`; this rule is the fallback when a caller passes none.
 */
export function isPaidRenderNode(def: ComfyUINodeDef): boolean {
  if (def.api_node === true) return true;
  const category = (def.category ?? "").toLowerCase();
  if (category === "api node" || category.startsWith("api node/")) return true;
  if (marked(def.external_api_node) || marked(def.EXTERNAL_API_NODE)) return true;
  for (const group of [def.input?.required, def.input?.optional]) {
    for (const name of Object.keys(group ?? {})) {
      const snake = name
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toLowerCase()
        .replace(/[\s-]+/g, "_");
      if (CREDENTIAL_INPUT_RE.test(snake)) return true;
    }
  }
  return false;
}

/** Loopback hosts, as upstream's `isLoopbackHost` lists them, plus the rest of 127.0.0.0/8. */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0.0.0.0" || h === "::") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// ---------------------------------------------------------------------------------------
// Layers

/** True when the snapshot can't say what a model folder holds (#796): unread, not empty. */
function folderUnread(snapshot: EnvironmentSnapshot, folder: string): boolean {
  const installed = snapshot.installedModels;
  return installed === undefined || (!Object.hasOwn(installed.folders, folder) && !installed.absent.includes(folder));
}

function contractLayer(input: ValidateInput, compiled: CompileResult): CheckResult[] {
  const c = mk("contract");
  // A required model slot left empty because its folder couldn't be read has no file for a
  // reason the target didn't state: unknown, not the definite failure the compiler reports.
  const checks = compiled.checks.map((check) => {
    const slot = input.recipe.slots.find((s) => `contract.slot.${s.id}` === check.id);
    if (
      slot === undefined ||
      check.verdict !== "fail" ||
      slot.valueType !== "model_file" ||
      Object.hasOwn(compiled.values, slot.id) ||
      Object.hasOwn(input.bindings, slot.id) ||
      !folderUnread(input.snapshot, slot.modelFolder ?? "")
    ) {
      return check;
    }
    const why = input.snapshot.installedModels?.unanswered.find((u) => u.folder === slot.modelFolder)?.reason ?? "the folder wasn't probed";
    return { ...check, verdict: "unknown" as const, message: `slot ${slot.id}: no file to bind, ${slot.modelFolder} couldn't be read (${why})` };
  });
  checks.push(...outputSizeChecks(input.recipe, input.task, input.inputSizes));
  const transforms = input.transforms ?? [];
  checks.push(
    transforms.length === 0
      ? c("transforms", "pass", true, "no graph transformations")
      : c(
          "transforms",
          "fail",
          true,
          `transformations not allowlisted in milestone 2: ${transforms.map((t) => t.kind).join(", ")}`,
        ),
  );
  // With no transformation allowlisted, the graph must be exactly the recipe compiled with
  // these bindings; any other difference is an edit nobody recorded.
  if (input.graph !== undefined && compiled.fingerprint !== undefined) {
    checks.push(
      graphFingerprint(input.graph) === compiled.fingerprint
        ? c("compiled_from_recipe", "pass", true, "graph is the recipe compiled with these bindings")
        : c("compiled_from_recipe", "fail", true, "graph differs from the recipe compiled with these bindings"),
    );
  }
  return checks;
}

function structureLayer(graph: ApiGraph, recipe: Recipe, objectInfo: ObjectInfo | undefined): CheckResult[] {
  const c = mk("structure");
  const checks: CheckResult[] = [];
  const known = (cls: string): ComfyUINodeDef | undefined =>
    objectInfo !== undefined && Object.hasOwn(objectInfo, cls) ? objectInfo[cls] : undefined;

  if (objectInfo === undefined) {
    checks.push(
      c("node_schemas", "unknown", true, `${NO_SCHEMAS}: node classes, required inputs, output indices and output nodes are unchecked`),
    );
  }

  for (const [nodeId, node] of Object.entries(graph)) {
    const def = known(node.class_type);
    if (objectInfo !== undefined) {
      if (def === undefined) {
        checks.push(c(`class.${nodeId}`, "fail", true, `node class ${node.class_type} is not installed on the target`, nodeId));
      } else {
        checks.push(c(`class.${nodeId}`, "pass", true, `node class ${node.class_type} is installed`, nodeId));
        const missing = Object.keys(def.input?.required ?? {}).filter(
          (name) => node.inputs[name] === undefined || node.inputs[name] === null,
        );
        checks.push(
          missing.length === 0
            ? c(`required_inputs.${nodeId}`, "pass", true, `${node.class_type} has every required input`, nodeId)
            : c(`required_inputs.${nodeId}`, "fail", true, `${node.class_type} lacks required inputs: ${missing.join(", ")}`, nodeId),
        );
      }
    }

    for (const [name, value] of Object.entries(node.inputs)) {
      if (!isLink(value)) continue;
      const id = `link.${nodeId}.${name}`;
      const [src, index] = value;
      if (!Object.hasOwn(graph, src)) {
        checks.push(c(id, "fail", true, `${nodeId}.${name} links to missing node ${src}`, nodeId));
        continue;
      }
      if (objectInfo === undefined) continue; // covered by node_schemas
      const srcDef = known(graph[src].class_type);
      if (srcDef === undefined) {
        checks.push(c(id, "unknown", true, `${nodeId}.${name}: source ${src} has an unknown class, its outputs can't be checked`, nodeId));
      } else if (!Number.isInteger(index) || index < 0 || index >= (srcDef.output ?? []).length) {
        checks.push(
          c(id, "fail", true, `${nodeId}.${name} reads output ${index} of ${src}, which has ${(srcDef.output ?? []).length}`, nodeId),
        );
      } else {
        checks.push(c(id, "pass", true, `${nodeId}.${name} reads output ${index} of ${src}`, nodeId));
      }
    }
  }

  if (objectInfo !== undefined) {
    const outputNodes = Object.entries(graph).filter(([, n]) => known(n.class_type)?.output_node === true);
    checks.push(
      outputNodes.length > 0
        ? c("output_nodes", "pass", true, `output nodes: ${outputNodes.map(([id]) => id).join(", ")}`)
        : c("output_nodes", "fail", true, "the graph has no output node, so ComfyUI would execute nothing"),
    );
    for (const o of recipe.outputs) {
      const node = graph[o.node];
      const def = node !== undefined ? known(node.class_type) : undefined;
      checks.push(
        def?.output_node === true
          ? c(`recipe_output.${o.role}`, "pass", true, `output ${o.role} is output node ${o.node}`, o.node)
          : c(`recipe_output.${o.role}`, "fail", true, `output ${o.role} names ${o.node}, which is not an output node`, o.node),
      );
    }
  }

  // Cycles: ComfyUI's API format has no loop construct, so any cycle is unsupported.
  const state = new Map<string, "visiting" | "done">();
  let cycleAt: string | undefined;
  const visit = (id: string): boolean => {
    const s = state.get(id);
    if (s === "done") return false;
    if (s === "visiting") return true;
    state.set(id, "visiting");
    for (const v of Object.values(graph[id].inputs)) {
      if (isLink(v) && Object.hasOwn(graph, v[0]) && visit(v[0])) return true;
    }
    state.set(id, "done");
    return false;
  };
  for (const id of Object.keys(graph)) {
    if (visit(id)) {
      cycleAt = id;
      break;
    }
  }
  checks.push(
    cycleAt === undefined
      ? c("acyclic", "pass", true, "the graph has no cycles")
      : c("acyclic", "fail", true, `the graph has a cycle through node ${cycleAt}`, cycleAt),
  );
  return checks;
}

function nativeTypesLayer(graph: ApiGraph, recipe: Recipe, objectInfo: ObjectInfo | undefined): CheckResult[] {
  const c = mk("native_types");
  if (objectInfo === undefined) return [c("node_schemas", "unknown", true, `${NO_SCHEMAS}: port types are unchecked`)];
  const checks: CheckResult[] = [];
  const known = (cls: string): ComfyUINodeDef | undefined => (Object.hasOwn(objectInfo, cls) ? objectInfo[cls] : undefined);
  const modelInputs = new Set(
    recipe.slots.filter((s) => s.valueType === "model_file").map((s) => `${s.target.node}\u0000${s.target.input}`),
  );
  const imageInputs = new Set(
    recipe.slots.filter((s) => s.valueType === "input_image").map((s) => `${s.target.node}\u0000${s.target.input}`),
  );

  for (const [nodeId, node] of Object.entries(graph)) {
    const def = known(node.class_type);
    for (const [name, value] of Object.entries(node.inputs)) {
      const spec = def !== undefined ? inputSpec(def, name) : undefined;
      if (isLink(value)) {
        const id = `link.${nodeId}.${name}`;
        const srcNode = graph[value[0]];
        const srcDef = srcNode !== undefined ? known(srcNode.class_type) : undefined;
        const srcType = srcDef?.output?.[value[1]];
        if (def === undefined || srcDef === undefined || spec === undefined || srcType === undefined) {
          checks.push(c(id, "unknown", false, `${nodeId}.${name}: the source output or target input has no schema to compare`, nodeId));
          continue;
        }
        const [target] = spec;
        if (typeof srcType !== "string" || Array.isArray(target) || target === "COMBO") {
          checks.push(c(id, "unknown", false, `${nodeId}.${name}: link into or out of a COMBO isn't compared`, nodeId));
        } else if (srcType === "*" || target === "*") {
          checks.push(c(id, "unknown", false, `${nodeId}.${name}: wildcard type (${srcType} -> ${target}) can't be decided from schemas`, nodeId));
        } else if (srcType.includes(",") || target.includes(",")) {
          checks.push(c(id, "unknown", false, `${nodeId}.${name}: union type (${srcType} -> ${target}) isn't compared`, nodeId));
        } else if (srcType === target) {
          checks.push(c(id, "pass", true, `${nodeId}.${name}: ${srcType}`, nodeId));
        } else {
          checks.push(c(id, "fail", true, `${nodeId}.${name} expects ${target}, gets ${srcType} from ${value[0]}`, nodeId));
        }
        continue;
      }
      if (spec === undefined) {
        // A literal the node doesn't declare is dropped by ComfyUI, so the value the recipe
        // meant is never applied; with the node's schema known, that is a definite fault.
        if (def !== undefined) {
          checks.push(c(`input.${nodeId}.${name}`, "fail", true, `${nodeId}.${name}: ${node.class_type} declares no input ${name}`, nodeId));
        }
        continue;
      }
      const combo = comboChoices(spec);
      if (imageInputs.has(`${nodeId}\u0000${name}`)) {
        // An input image must be a file the loader lists from the target's input folder;
        // Architect uploads nothing (GAPS Q33), so an unlisted name has no remedy here, and a
        // loader whose schema lists nothing leaves the file unverified: a hard unknown.
        const id = `combo.${nodeId}.${name}`;
        if (!combo.combo || combo.choices === undefined) {
          checks.push(c(id, "unknown", true, `${nodeId}.${name} takes an input image, but ${node.class_type}'s schema lists no input files to check ${JSON.stringify(value)} against`, nodeId));
        } else {
          checks.push(
            combo.choices.includes(value)
              ? c(id, "pass", true, `${nodeId}.${name} = ${JSON.stringify(value)} is a file ${node.class_type} lists in the target's input folder`, nodeId)
              : c(id, "fail", true, `${nodeId}.${name} = ${JSON.stringify(value)} is not a file ${node.class_type} lists in the target's input folder; put it there or upload it in ComfyUI, then validate again`, nodeId),
          );
        }
        continue;
      }
      if (!combo.combo) continue;
      const id = `combo.${nodeId}.${name}`;
      if (modelInputs.has(`${nodeId}\u0000${name}`) && combo.choices === undefined) {
        // Whether the file is installed is the dependencies layer's call; that the loader
        // offers it isn't known here.
        checks.push(c(id, "unknown", false, `${nodeId}.${name} holds a model file; the loader's schema lists no choices`, nodeId));
      } else if (modelInputs.has(`${nodeId}\u0000${name}`)) {
        // A file can be installed in the slot's folder and still not be offered by the loader
        // (another folder, a filtered extension), and then fails at /prompt (GAPS Q13).
        checks.push(
          combo.choices?.includes(value)
            ? c(id, "pass", true, `${nodeId}.${name} = ${JSON.stringify(value)} is offered by ${node.class_type}`, nodeId)
            : c(id, "fail", true, `${nodeId}.${name} = ${JSON.stringify(value)} is not a file ${node.class_type} offers on the target`, nodeId),
        );
      } else if (combo.choices === undefined) {
        checks.push(c(id, "unknown", false, `${nodeId}.${name}: the schema lists no choices`, nodeId));
      } else if (combo.choices.includes(value)) {
        checks.push(c(id, "pass", true, `${nodeId}.${name} = ${JSON.stringify(value)} is a listed choice`, nodeId));
      } else {
        checks.push(c(id, "fail", true, `${nodeId}.${name} = ${JSON.stringify(value)} is not a choice the target lists`, nodeId));
      }
    }
  }
  if (checks.length === 0) checks.push(c("ports", "not_applicable", false, "the graph has no links or COMBO inputs"));
  return checks;
}

/**
 * Model families (spec §10.3, §9.3). With an observation of the bound file's safetensors
 * header (TODO 5.3): a header that matches the slot's family rule passes; one that matches
 * another family's rule fails, since an incompatible component can't be offset. Without a
 * decisive observation (none, unreadable, no rule matched, no rule for the slot's family)
 * the check is unknown under GAPS Q14's rule: soft for the recipe's default file, which
 * its author named, hard for any other file, so such a candidate stays diagnostic.
 */
function semanticTypesLayer(recipe: Recipe, values: Record<string, string | number>, families: FamilyEvidence | undefined): CheckResult[] {
  const c = mk("semantic_types");
  const modelSlots = recipe.slots.filter((s) => s.valueType === "model_file");
  if (modelSlots.length === 0) return [c("models", "not_applicable", false, "the recipe binds no model files")];
  return modelSlots.map((s) => {
    const id = `model_family.${s.id}`;
    if (s.modelFamily === undefined) return c(id, "not_applicable", false, `slot ${s.id} is annotated with no model family`, s.target.node);
    const bound = values[s.id];
    if (bound === undefined) return c(id, "not_applicable", false, `slot ${s.id} has no file bound`, s.target.node);
    const unverified = (why: string): CheckResult =>
      bound === s.default
        ? c(id, "unknown", false, `slot ${s.id} expects family ${s.modelFamily}; the recipe names ${bound}, ${why}`, s.target.node)
        : c(id, "unknown", true, `slot ${s.id} expects family ${s.modelFamily}; ${JSON.stringify(bound)} isn't the recipe's file, and ${why}`, s.target.node);
    const observation = families?.observations.get(observationKey(s.modelFolder ?? "", String(bound)));
    if (families === undefined || observation === undefined) return unverified("whose family isn't verified yet");
    return familyCheck(c, id, s, String(bound), observation, families.rules, unverified);
  });
}

/** The family check of one slot against an observation of its bound file. */
function familyCheck(
  c: ReturnType<typeof mk>,
  id: string,
  slot: RecipeSlot,
  file: string,
  observation: ModelObservation,
  rules: readonly FamilyRule[],
  unverified: (why: string) => CheckResult,
): CheckResult {
  const family = slot.modelFamily ?? "";
  const rule = ruleForFamily(rules, family, slot.modelFolder ?? "");
  const seen = `observed ${observation.observedAt}`;
  const others = observation.matches.filter((m) => m !== rule?.id);
  // Another family's rule matching is decisive whether or not this family has a rule: the
  // header shows the file is something else (spec §9.3).
  if (others.length > 0 && (rule === undefined || !observation.matches.includes(rule.id))) {
    return c(id, "fail", true, `slot ${slot.id} expects family ${family}; the header of ${file} matches family ${others.join(", ")} instead (${seen})`, slot.target.node);
  }
  if (rule === undefined) return unverified(`no family rule for ${family} applies to ${slot.modelFolder}, so its header can't be checked`);
  if (observation.outcome === "matched") {
    const twins = rule.indistinguishableFrom ?? [];
    if (twins.length === 0) {
      return c(id, "pass", true, `slot ${slot.id}: the header of ${file} matches family rule ${rule.id} (${seen})`, slot.target.node);
    }
    // The header confirms the architecture, not which variant the file is: the recipe's
    // author named the default, so it passes with the limit stated; another file of the same
    // architecture could be the other variant, which the recipe wasn't written for (GAPS Q14).
    const limit = `the header can't tell ${rule.id} from ${twins.join(", ")}`;
    return file === String(slot.default)
      ? c(id, "pass", true, `slot ${slot.id}: the header of ${file}, the recipe's file, matches family rule ${rule.id}; ${limit} (${seen})`, slot.target.node)
      : c(id, "unknown", true, `slot ${slot.id}: the header of ${file} matches family rule ${rule.id}, but ${limit}, and ${file} isn't the recipe's file (${seen})`, slot.target.node);
  }
  if (observation.outcome === "ambiguous") {
    return c(id, "unknown", true, `slot ${slot.id}: the header of ${file} matches more than one family rule (${observation.matches.join(", ")}), so its family isn't decided (${seen})`, slot.target.node);
  }
  return unverified(observation.outcome === "unreadable" ? `its header couldn't be read: ${observation.reason}` : `its header matches no family rule: ${observation.reason}`);
}

function dependenciesLayer(
  recipe: Recipe,
  values: Record<string, string | number>,
  objectInfo: ObjectInfo | undefined,
  snapshot: EnvironmentSnapshot,
): { checks: CheckResult[]; delta: PlanCandidate["dependencyDelta"] } {
  const c = mk("dependencies");
  const checks: CheckResult[] = [];
  const delta: PlanCandidate["dependencyDelta"] = { missingModels: [], missingNodeClasses: [] };

  for (const cls of recipe.dependencies.nodeClasses) {
    const id = `node_class.${cls}`;
    if (objectInfo === undefined) {
      checks.push(c(id, "unknown", true, `${NO_SCHEMAS}: whether ${cls} is installed is unknown`));
    } else if (Object.hasOwn(objectInfo, cls)) {
      checks.push(c(id, "pass", true, `${cls} is installed`));
    } else {
      checks.push(c(id, "fail", true, `${cls} is not installed on the target`));
      delta.missingNodeClasses.push(cls);
    }
  }

  const installed = snapshot.installedModels;
  for (const slot of recipe.slots) {
    if (slot.valueType !== "model_file") continue;
    const id = `model.${slot.id}`;
    // The schema requires modelFolder on a model_file slot.
    const folder = slot.modelFolder ?? "";
    const file = values[slot.id];
    if (typeof file !== "string") {
      checks.push(c(id, "unknown", true, `slot ${slot.id} has no valid file to look up`, slot.target.node));
    } else if (installed === undefined) {
      checks.push(c(id, "unknown", true, `the snapshot has no model listing; ${folder}/${file} is unverified`, slot.target.node));
    } else if (Object.hasOwn(installed.folders, folder)) {
      if (installed.folders[folder].includes(file)) {
        checks.push(c(id, "pass", true, `${folder}/${file} is installed`, slot.target.node));
      } else {
        checks.push(c(id, "fail", true, `${folder}/${file} is not installed on the target`, slot.target.node));
        delta.missingModels.push({ slot: slot.id, folder, file });
      }
    } else if (installed.absent.includes(folder)) {
      checks.push(c(id, "fail", true, `the target has no model folder ${folder}, so ${file} can't be installed there`, slot.target.node));
      delta.missingModels.push({ slot: slot.id, folder, file });
    } else {
      const why = installed.unanswered.find((u) => u.folder === folder)?.reason ?? "the folder wasn't probed";
      checks.push(c(id, "unknown", true, `${folder}/${file} is unverified: ${why}`, slot.target.node));
    }
  }
  if (checks.length === 0) checks.push(c("none", "not_applicable", false, "the recipe declares no node classes or model files"));
  return { checks, delta };
}

function policyLayer(
  graph: ApiGraph | undefined,
  task: TaskSpec,
  objectInfo: ObjectInfo | undefined,
  snapshot: EnvironmentSnapshot,
  isPaidNode: (def: ComfyUINodeDef) => boolean,
): CheckResult[] {
  const c = mk("policy");
  const checks: CheckResult[] = [];
  const { paidRenderNodes, renderLocation } = task.constraints;

  if (paidRenderNodes === "allowed") {
    checks.push(c("paid_render_nodes", "pass", true, "the task allows paid render nodes"));
  } else if (graph === undefined) {
    checks.push(c("paid_render_nodes", "unknown", true, "no compiled graph to scan for paid render nodes"));
  } else {
    const paid: string[] = [];
    const unclassified: string[] = [];
    for (const [nodeId, node] of Object.entries(graph)) {
      const def = objectInfo !== undefined && Object.hasOwn(objectInfo, node.class_type) ? objectInfo[node.class_type] : undefined;
      if (def === undefined) unclassified.push(`${nodeId} (${node.class_type})`);
      else if (isPaidNode(def)) paid.push(`${nodeId} (${node.class_type})`);
    }
    if (paid.length > 0) {
      checks.push(
        paidRenderNodes === "forbidden"
          ? c("paid_render_nodes", "fail", true, `the task forbids paid render nodes; the graph has ${paid.join(", ")}`)
          : c("paid_render_nodes", "unknown", true, `paid render nodes ${paid.join(", ")} need approval, which milestone 2 can't grant`),
      );
    } else if (unclassified.length > 0) {
      // A node without a schema could be a paid one; "not found" is not "free" (#796).
      checks.push(c("paid_render_nodes", "unknown", true, `can't tell whether these nodes are paid: ${unclassified.join(", ")}`));
    } else {
      checks.push(c("paid_render_nodes", "pass", true, "the graph has no paid render nodes"));
    }
  }

  if (renderLocation === "local") {
    let hostname: string | undefined;
    try {
      hostname = new URL(snapshot.target.baseUrl).hostname;
    } catch {
      hostname = undefined;
    }
    if (hostname === undefined) {
      checks.push(c("render_location", "unknown", true, `can't read a host from the target URL ${snapshot.target.baseUrl}`));
    } else if (isLoopbackHostname(hostname)) {
      checks.push(c("render_location", "pass", true, `the target ${hostname} is loopback`));
    } else {
      // Milestone 2 doesn't recognise this machine's own LAN addresses (upstream's
      // isOwnHostAddress); refusing is the safe direction for a privacy constraint.
      checks.push(c("render_location", "fail", true, `the task renders locally only; the target ${hostname} is not a loopback address`));
    }
  } else {
    checks.push(c("render_location", "pass", true, "the task allows a remote render target"));
  }

  checks.push(c("new_custom_nodes", "not_applicable", false, "milestone 2 installs no custom nodes"));
  // Downloads are decided after validation, from the recipe's pinned sources and the task's
  // modelDownloads (acquisition-policy.ts); a missing file stays a failing check here.
  checks.push(c("model_downloads", "not_applicable", false, "validation downloads nothing; missing model files are decided by the acquisition policy"));
  return checks;
}

/** fail if any hard check fails, else unknown if any hard check is unknown, else pass. */
export function overallVerdict(checks: readonly CheckResult[]): ValidationReport["overall"] {
  if (checks.some((c) => c.hard && c.verdict === "fail")) return "fail";
  if (checks.some((c) => c.hard && c.verdict === "unknown")) return "unknown";
  return "pass";
}

/**
 * Validate a graph for a recipe, task and bindings against the target (spec §10.3). The
 * contract layer recompiles the recipe, so a graph edited after compilation fails it.
 */
export function validateGraph(input: ValidateInput): ValidationOutcome {
  const { recipe, task, bindings, objectInfo, snapshot } = input;
  const compiled = compileRecipe(recipe, task, bindings);
  const graph = input.graph ?? compiled.graph;

  const checks: CheckResult[] = [...contractLayer(input, compiled)];
  if (graph === undefined) {
    const why = "no graph: compilation failed its contract checks";
    checks.push(mk("structure")("graph", "unknown", true, why));
    checks.push(mk("native_types")("graph", "unknown", true, why));
  } else {
    checks.push(...structureLayer(graph, recipe, objectInfo));
    checks.push(...nativeTypesLayer(graph, recipe, objectInfo));
  }
  checks.push(...semanticTypesLayer(recipe, compiled.values, input.families));
  const deps = dependenciesLayer(recipe, compiled.values, objectInfo, snapshot);
  checks.push(...deps.checks);
  checks.push(...policyLayer(graph, task, objectInfo, snapshot, input.isPaidNode ?? isPaidRenderNode));
  checks.push(mk("runtime")("execution", "not_applicable", false, "no execution in milestone 2"));

  return { report: { checks, overall: overallVerdict(checks) }, dependencyDelta: deps.delta };
}
