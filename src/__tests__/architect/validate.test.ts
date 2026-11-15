import { describe, expect, it } from "vitest";
import type { ComfyUINodeDef } from "../../comfyui/types.js";
import { compileRecipe } from "../../services/architect/compile.js";
import {
  CheckResult,
  Recipe,
  ValidationLayer,
  ValidationReport,
  type ApiGraph,
  type TaskSpec,
} from "../../services/architect/schemas.js";
import {
  isPaidRenderNode,
  overallVerdict,
  validateGraph,
  type ValidateInput,
} from "../../services/architect/validate.js";
import { fixtureObjectInfo, fixtureRecipe, fixtureSnapshot, fixtureTask } from "./fixtures/load.js";

const CKPT = "sd_xl_base_1.0.safetensors";
const T2I_BINDINGS = { checkpoint: CKPT, seed: 7 };

function byId(checks: CheckResult[], id: string): CheckResult {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id} in ${checks.map((c) => c.id).join(", ")}`);
  return found;
}

function variant(base: Recipe, patch: Partial<Recipe>): Recipe {
  return Recipe.parse({ ...structuredClone(base), ...patch });
}

/** The t2i fixture plus extra nodes, so a test exercises a rule without breaking the contract. */
function t2iWith(nodes: ApiGraph, patch: Partial<Recipe> = {}): Recipe {
  const base = fixtureRecipe("t2i-basic");
  return variant(base, { graph: { ...base.graph, ...nodes }, ...patch });
}

function run(overrides: Partial<ValidateInput> = {}) {
  return validateGraph({
    recipe: fixtureRecipe("t2i-basic"),
    task: fixtureTask(),
    bindings: T2I_BINDINGS,
    objectInfo: fixtureObjectInfo(),
    snapshot: fixtureSnapshot(),
    ...overrides,
  });
}

/** The compiled t2i graph, for tests that hand validateGraph an edited graph. */
function compiledT2i(): ApiGraph {
  const g = compileRecipe(fixtureRecipe("t2i-basic"), fixtureTask(), T2I_BINDINGS).graph;
  if (!g) throw new Error("fixture failed to compile");
  return g;
}

function hardFails(checks: CheckResult[]): string[] {
  return checks.filter((c) => c.hard && c.verdict === "fail").map((c) => c.id);
}

describe("validateGraph: complete environment", () => {
  it("passes the text-to-image fixture on every layer", () => {
    const { report, dependencyDelta } = run();
    expect(() => ValidationReport.parse(report)).not.toThrow();
    expect(hardFails(report.checks)).toEqual([]);
    expect(report.checks.filter((c) => c.hard && c.verdict === "unknown")).toEqual([]);
    expect(report.overall).toBe("pass");
    expect(dependencyDelta).toEqual({ missingModels: [], missingNodeClasses: [] });
    for (const layer of ValidationLayer.options) {
      const inLayer = report.checks.filter((c) => c.layer === layer);
      expect(inLayer.length, layer).toBeGreaterThan(0);
      expect(inLayer.every((c) => c.enforcedBy === `validator.${layer}`)).toBe(true);
    }
    expect(byId(report.checks, "structure.class.5").verdict).toBe("pass");
    expect(byId(report.checks, "native_types.link.6.vae").verdict).toBe("pass");
    expect(byId(report.checks, "native_types.combo.5.scheduler").verdict).toBe("pass");
    expect(byId(report.checks, "dependencies.model.checkpoint").verdict).toBe("pass");
    expect(byId(report.checks, "runtime.execution")).toMatchObject({ verdict: "not_applicable", hard: false });
  });

  it("passes the upscale fixture", () => {
    const { report } = run({
      recipe: fixtureRecipe("upscale-model"),
      task: fixtureTask({ media: { kind: "image", operation: "upscale", output: { width: 2048, height: 2048 } } }),
      bindings: { source_image: "example.png", upscale_model: "4x-UltraSharp.pth" },
    });
    expect(hardFails(report.checks)).toEqual([]);
    expect(report.overall).toBe("pass");
  });

  it("validates a graph the caller passes, when it is the compiled one", () => {
    const { report } = run({ graph: compiledT2i() });
    expect(byId(report.checks, "contract.compiled_from_recipe").verdict).toBe("pass");
    expect(report.overall).toBe("pass");
  });
});

describe("validateGraph: node schemas unavailable", () => {
  it("is unknown overall, never pass, and lists nothing as missing", () => {
    const { report, dependencyDelta } = run({ objectInfo: undefined });
    expect(report.overall).toBe("unknown");
    expect(byId(report.checks, "structure.node_schemas")).toMatchObject({ verdict: "unknown", hard: true });
    expect(byId(report.checks, "native_types.node_schemas")).toMatchObject({ verdict: "unknown", hard: true });
    expect(byId(report.checks, "dependencies.node_class.KSampler")).toMatchObject({ verdict: "unknown", hard: true });
    expect(byId(report.checks, "policy.paid_render_nodes")).toMatchObject({ verdict: "unknown", hard: true });
    expect(report.checks.some((c) => c.id.startsWith("structure.class."))).toBe(false);
    expect(dependencyDelta.missingNodeClasses).toEqual([]);
  });

  it("still fails what doesn't need a schema", () => {
    const g = compiledT2i();
    g["6"].inputs.vae = ["99", 0];
    const { report } = run({ objectInfo: undefined, graph: g });
    expect(byId(report.checks, "structure.link.6.vae")).toMatchObject({ verdict: "fail", hard: true });
    expect(report.overall).toBe("fail");
  });
});

describe("contract layer", () => {
  it("fails on any transform: none are allowlisted", () => {
    const { report } = run({ transforms: [{ kind: "tiled_vae_decode" }] });
    expect(byId(report.checks, "contract.transforms")).toMatchObject({ verdict: "fail", hard: true });
    expect(report.overall).toBe("fail");
  });

  it("fails a graph edited after compilation", () => {
    const g = compiledT2i();
    g["5"].inputs.steps = 60;
    const { report } = run({ graph: g });
    expect(byId(report.checks, "contract.compiled_from_recipe")).toMatchObject({ verdict: "fail", hard: true });
  });

  it("carries the compiler's failures and checks no graph when compilation failed", () => {
    const { report } = run({ bindings: { seed: 7 } });
    expect(byId(report.checks, "contract.slot.checkpoint").verdict).toBe("fail");
    expect(byId(report.checks, "structure.graph")).toMatchObject({ verdict: "unknown", hard: true });
    expect(byId(report.checks, "native_types.graph")).toMatchObject({ verdict: "unknown", hard: true });
    expect(byId(report.checks, "dependencies.model.checkpoint")).toMatchObject({ verdict: "unknown", hard: true });
    expect(report.overall).toBe("fail");
  });
});

describe("structure layer", () => {
  it("fails a node class the target doesn't have", () => {
    const { report } = run({ recipe: t2iWith({ "8": { class_type: "NotInstalledNode", inputs: {} } }) });
    expect(byId(report.checks, "structure.class.8")).toMatchObject({ verdict: "fail", hard: true, nodeId: "8" });
    expect(report.overall).toBe("fail");
  });

  it("fails a missing required input, and treats null as missing", () => {
    const g = compiledT2i();
    delete g["5"].inputs.denoise;
    g["6"].inputs.samples = null;
    const { report } = run({ graph: g });
    expect(byId(report.checks, "structure.required_inputs.5")).toMatchObject({ verdict: "fail", hard: true });
    expect(byId(report.checks, "structure.required_inputs.5").message).toContain("denoise");
    expect(byId(report.checks, "structure.required_inputs.6").message).toContain("samples");
  });

  it("fails a link to a missing node and an output index out of range", () => {
    const g = compiledT2i();
    g["6"].inputs.vae = ["99", 0];
    g["5"].inputs.model = ["1", 5];
    const { report } = run({ graph: g });
    expect(byId(report.checks, "structure.link.6.vae")).toMatchObject({ verdict: "fail", hard: true });
    expect(byId(report.checks, "structure.link.5.model")).toMatchObject({ verdict: "fail", hard: true });
    expect(byId(report.checks, "structure.link.5.model").message).toContain("has 3");
  });

  it("fails a graph without an output node", () => {
    const g = compiledT2i();
    delete g["7"];
    const { report } = run({ graph: g });
    expect(byId(report.checks, "structure.output_nodes")).toMatchObject({ verdict: "fail", hard: true });
    expect(byId(report.checks, "structure.recipe_output.image")).toMatchObject({ verdict: "fail", hard: true });
  });

  it("fails a recipe output that isn't an output node", () => {
    const { report } = run({ recipe: variant(fixtureRecipe("t2i-basic"), { outputs: [{ role: "image", node: "6" }] }) });
    expect(byId(report.checks, "structure.recipe_output.image")).toMatchObject({ verdict: "fail", hard: true });
    expect(byId(report.checks, "structure.output_nodes").verdict).toBe("pass");
  });

  it("fails a cycle", () => {
    const g = compiledT2i();
    g["4"] = { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } };
    const { report } = run({ graph: g });
    expect(byId(report.checks, "structure.acyclic")).toMatchObject({ verdict: "fail", hard: true });
  });
});

describe("native types layer", () => {
  it("fails a definite type mismatch", () => {
    const g = compiledT2i();
    g["6"].inputs.vae = ["1", 0];
    const { report } = run({ graph: g });
    const c = byId(report.checks, "native_types.link.6.vae");
    expect(c).toMatchObject({ verdict: "fail", hard: true });
    expect(c.message).toContain("expects VAE, gets MODEL");
  });

  it("leaves a wildcard input unknown, not hard", () => {
    const { report } = run({ recipe: t2iWith({ "8": { class_type: "PreviewAny", inputs: { source: ["6", 0] } } }) });
    expect(byId(report.checks, "native_types.link.8.source")).toMatchObject({ verdict: "unknown", hard: false });
    expect(report.overall).toBe("pass");
  });

  it("leaves a comma-joined union unknown, not hard", () => {
    const info = fixtureObjectInfo();
    info.VAEDecode.input.required!.vae = ["VAE,MODEL", {}];
    const { report } = run({ objectInfo: info });
    const c = byId(report.checks, "native_types.link.6.vae");
    expect(c).toMatchObject({ verdict: "unknown", hard: false });
    expect(c.message).toContain("union");
  });

  it("leaves an input the schema doesn't declare unknown, not hard", () => {
    const { report } = run({ recipe: t2iWith({ "8": { class_type: "PreviewAny", inputs: { source: ["6", 0], extra: ["6", 0] } } }) });
    expect(byId(report.checks, "native_types.link.8.extra")).toMatchObject({ verdict: "unknown", hard: false });
  });

  it("fails a COMBO literal outside the target's choices", () => {
    const info = fixtureObjectInfo();
    info.KSampler.input.required!.scheduler = [["simple", "karras"], {}];
    const { report } = run({ objectInfo: info });
    expect(byId(report.checks, "native_types.combo.5.scheduler")).toMatchObject({ verdict: "fail", hard: true });
  });

  it("reads V3 COMBO options", () => {
    const info = fixtureObjectInfo();
    info.KSampler.input.required!.scheduler = ["COMBO", { options: ["normal", "karras"] }];
    expect(byId(run({ objectInfo: info }).report.checks, "native_types.combo.5.scheduler").verdict).toBe("pass");
    info.KSampler.input.required!.scheduler = ["COMBO", { options: ["karras"] }];
    expect(byId(run({ objectInfo: info }).report.checks, "native_types.combo.5.scheduler").verdict).toBe("fail");
    info.KSampler.input.required!.scheduler = ["COMBO", {}];
    expect(byId(run({ objectInfo: info }).report.checks, "native_types.combo.5.scheduler")).toMatchObject({
      verdict: "unknown",
      hard: false,
    });
  });

  it("leaves a model file's COMBO to the dependencies layer", () => {
    // Listed by the model probe, not in the object_info COMBO: dependencies decides.
    const { report } = run({ bindings: { checkpoint: "other/not-in-combo.safetensors" } });
    expect(byId(report.checks, "native_types.combo.1.ckpt_name")).toMatchObject({ verdict: "not_applicable", hard: false });
    expect(byId(report.checks, "dependencies.model.checkpoint").verdict).toBe("pass");
    expect(report.overall).toBe("pass");
  });
});

describe("semantic types layer", () => {
  it("is unknown, not hard, for a slot annotated with a family", () => {
    const { report } = run();
    const c = byId(report.checks, "semantic_types.model_family.checkpoint");
    expect(c).toMatchObject({ verdict: "unknown", hard: false });
    expect(c.message).toContain("isn't verified yet");
  });

  it("is not applicable for a slot without a family", () => {
    const { report } = run({
      recipe: fixtureRecipe("upscale-model"),
      task: fixtureTask({ media: { kind: "image", operation: "upscale", output: { width: 2048, height: 2048 } } }),
      bindings: { source_image: "example.png", upscale_model: "4x-UltraSharp.pth" },
    });
    expect(byId(report.checks, "semantic_types.model_family.upscale_model").verdict).toBe("not_applicable");
  });
});

describe("dependencies layer", () => {
  it("fails and lists a node class the target doesn't have", () => {
    const info = fixtureObjectInfo();
    delete info.VAEDecode;
    const { report, dependencyDelta } = run({ objectInfo: info });
    expect(byId(report.checks, "dependencies.node_class.VAEDecode")).toMatchObject({ verdict: "fail", hard: true });
    expect(dependencyDelta.missingNodeClasses).toEqual(["VAEDecode"]);
  });

  it("fails and lists a model file missing from an answered folder", () => {
    const snapshot = fixtureSnapshot();
    snapshot.installedModels!.folders.checkpoints = [];
    const { report, dependencyDelta } = run({ snapshot });
    expect(byId(report.checks, "dependencies.model.checkpoint")).toMatchObject({ verdict: "fail", hard: true });
    expect(dependencyDelta.missingModels).toEqual([{ slot: "checkpoint", folder: "checkpoints", file: CKPT }]);
    expect(report.overall).toBe("fail");
  });

  it("fails and lists a model whose folder the target doesn't register", () => {
    const recipe = fixtureRecipe("t2i-basic");
    const r = variant(recipe, {
      slots: recipe.slots.map((s) => (s.id === "checkpoint" ? { ...s, modelFolder: "diffusers" } : s)),
    });
    const { report, dependencyDelta } = run({ recipe: r });
    expect(byId(report.checks, "dependencies.model.checkpoint")).toMatchObject({ verdict: "fail", hard: true });
    expect(dependencyDelta.missingModels).toHaveLength(1);
  });

  it("is unknown, hard, and lists nothing for an unanswered folder", () => {
    const recipe = fixtureRecipe("t2i-basic");
    const r = variant(recipe, {
      slots: recipe.slots.map((s) => (s.id === "checkpoint" ? { ...s, modelFolder: "loras" } : s)),
    });
    const { report, dependencyDelta } = run({ recipe: r });
    const c = byId(report.checks, "dependencies.model.checkpoint");
    expect(c).toMatchObject({ verdict: "unknown", hard: true });
    expect(c.message).toContain("HTTP 500");
    expect(dependencyDelta.missingModels).toEqual([]);
    expect(report.overall).toBe("unknown");
  });

  it("is unknown, hard, for a folder no probe mentions", () => {
    const recipe = fixtureRecipe("t2i-basic");
    const r = variant(recipe, {
      slots: recipe.slots.map((s) => (s.id === "checkpoint" ? { ...s, modelFolder: "unet" } : s)),
    });
    expect(byId(run({ recipe: r }).report.checks, "dependencies.model.checkpoint")).toMatchObject({ verdict: "unknown", hard: true });
  });

  it("is unknown, hard, without a model listing", () => {
    const { report, dependencyDelta } = run({ snapshot: fixtureSnapshot({ installedModels: undefined }) });
    expect(byId(report.checks, "dependencies.model.checkpoint")).toMatchObject({ verdict: "unknown", hard: true });
    expect(dependencyDelta.missingModels).toEqual([]);
    expect(report.overall).toBe("unknown");
  });
});

describe("policy layer", () => {
  const apiNode: ApiGraph = {
    "8": {
      class_type: "FluxProUltraImageNode",
      inputs: { prompt: "x", prompt_upsampling: false, seed: 1, aspect_ratio: "1:1", raw: false },
    },
  };

  function withConstraints(c: Partial<TaskSpec["constraints"]>): TaskSpec {
    const t = fixtureTask();
    return { ...t, constraints: { ...t.constraints, ...c } };
  }

  it("fails a paid node when paid nodes are forbidden", () => {
    const { report } = run({ recipe: t2iWith(apiNode) });
    const c = byId(report.checks, "policy.paid_render_nodes");
    expect(c).toMatchObject({ verdict: "fail", hard: true });
    expect(c.message).toContain("FluxProUltraImageNode");
    expect(report.overall).toBe("fail");
  });

  it("is unknown, hard, when paid nodes need approval", () => {
    const { report } = run({ recipe: t2iWith(apiNode), task: withConstraints({ paidRenderNodes: "approval_required" }) });
    const c = byId(report.checks, "policy.paid_render_nodes");
    expect(c).toMatchObject({ verdict: "unknown", hard: true });
    expect(c.message).toContain("milestone 2 can't grant");
    expect(report.overall).toBe("unknown");
  });

  it("passes a paid node when paid nodes are allowed", () => {
    const { report } = run({ recipe: t2iWith(apiNode), task: withConstraints({ paidRenderNodes: "allowed" }) });
    expect(byId(report.checks, "policy.paid_render_nodes").verdict).toBe("pass");
    expect(report.overall).toBe("pass");
  });

  it("is unknown for a node it can't classify, not free", () => {
    const { report } = run({ recipe: t2iWith({ "8": { class_type: "NotInstalledNode", inputs: {} } }) });
    expect(byId(report.checks, "policy.paid_render_nodes")).toMatchObject({ verdict: "unknown", hard: true });
  });

  it("uses an injected classifier", () => {
    const { report } = run({ isPaidNode: (def) => def.name === "KSampler" });
    expect(byId(report.checks, "policy.paid_render_nodes").message).toContain("KSampler");
  });

  it.each(["http://192.168.1.20:8188", "https://comfy.example.com", "http://comfy.lan:8188"])(
    "fails a non-loopback target %s when rendering is local",
    (baseUrl) => {
      const { report } = run({ snapshot: fixtureSnapshot({ target: { baseUrl } }) });
      expect(byId(report.checks, "policy.render_location")).toMatchObject({ verdict: "fail", hard: true });
    },
  );

  it.each(["http://127.0.0.1:8188", "http://localhost:8188", "http://[::1]:8188", "http://127.0.0.2:8188"])(
    "passes the loopback target %s",
    (baseUrl) => {
      const { report } = run({ snapshot: fixtureSnapshot({ target: { baseUrl } }) });
      expect(byId(report.checks, "policy.render_location").verdict).toBe("pass");
    },
  );

  it("is unknown for a target URL it can't parse", () => {
    const { report } = run({ snapshot: fixtureSnapshot({ target: { baseUrl: "not a url" } }) });
    expect(byId(report.checks, "policy.render_location")).toMatchObject({ verdict: "unknown", hard: true });
  });

  it("passes a remote target when the task allows one", () => {
    const { report } = run({
      snapshot: fixtureSnapshot({ target: { baseUrl: "https://comfy.example.com" } }),
      task: withConstraints({ renderLocation: "remote_allowed" }),
    });
    expect(byId(report.checks, "policy.render_location").verdict).toBe("pass");
  });

  it("marks custom-node installs not applicable", () => {
    expect(byId(run().report.checks, "policy.new_custom_nodes")).toMatchObject({ verdict: "not_applicable", hard: false });
  });
});

describe("isPaidRenderNode", () => {
  const base: ComfyUINodeDef = {
    input: { required: { text: ["STRING", {}] } },
    output: ["IMAGE"],
    output_is_list: [false],
    output_name: ["IMAGE"],
    name: "N",
    display_name: "N",
    description: "",
    category: "image",
    output_node: false,
  };

  it.each<[string, Partial<ComfyUINodeDef>, boolean]>([
    ["a plain local node", {}, false],
    ["api_node: true", { api_node: true }, true],
    ["an api node category", { category: "api node/image/BFL" }, true],
    ["a category that merely contains the words", { category: "utils/api node helpers" }, false],
    ["external_api_node naming a provider", { external_api_node: "fal.ai" }, true],
    ["EXTERNAL_API_NODE: true", { EXTERNAL_API_NODE: true }, true],
    ['external_api_node: "false"', { external_api_node: "false" }, false],
    ["an api_key input", { input: { required: { api_key: ["STRING", {}] } } }, true],
    ["a camelCase apiToken input", { input: { optional: { apiToken: ["STRING", {}] } } }, true],
  ])("%s", (_label, patch, paid) => {
    expect(isPaidRenderNode({ ...base, ...patch })).toBe(paid);
  });
});

describe("overallVerdict", () => {
  const c = (verdict: CheckResult["verdict"], hard: boolean): CheckResult => ({
    id: "x",
    layer: "contract",
    verdict,
    hard,
    message: "",
    enforcedBy: "validator.contract",
  });

  it("fails on a hard fail, is unknown on a hard unknown, ignores soft ones", () => {
    expect(overallVerdict([c("pass", true), c("unknown", true), c("fail", true)])).toBe("fail");
    expect(overallVerdict([c("pass", true), c("unknown", true), c("fail", false)])).toBe("unknown");
    expect(overallVerdict([c("pass", true), c("unknown", false), c("not_applicable", false)])).toBe("pass");
  });
});
