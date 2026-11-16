import { describe, expect, it } from "vitest";
import { canonicalJson, compileRecipe, graphFingerprint } from "../../services/architect/compile.js";
import { Recipe, type ApiGraph, type CheckResult } from "../../services/architect/schemas.js";
import { fixtureRecipe, fixtureTask } from "./fixtures/load.js";

const CKPT = "sd_xl_base_1.0.safetensors";

function byId(checks: CheckResult[], id: string): CheckResult {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id} in ${checks.map((c) => c.id).join(", ")}`);
  return found;
}

/** A fixture recipe with fields replaced, re-validated by the schema. */
function variant(base: Recipe, patch: Partial<Recipe>): Recipe {
  return Recipe.parse({ ...structuredClone(base), ...patch });
}

describe("fixture recipes (TODO 2.4.3)", () => {
  it("parse as recipes with certification fixture", () => {
    for (const name of ["t2i-basic", "upscale-model"] as const) {
      const r = fixtureRecipe(name);
      expect(r.certification).toBe("fixture");
      expect(r.id.startsWith("recipe-fixture.")).toBe(true);
    }
  });
});

describe("compileRecipe", () => {
  const recipe = fixtureRecipe("t2i-basic");
  const task = fixtureTask();

  it("fills every slot from binding, task and default, and passes the contract", () => {
    const out = compileRecipe(recipe, task, { checkpoint: CKPT, seed: 1234 });
    expect(out.checks.every((c) => c.layer === "contract" && c.enforcedBy === "validator.contract")).toBe(true);
    expect(out.checks.filter((c) => c.verdict === "fail")).toEqual([]);
    expect(out.graph).toBeDefined();
    const g = out.graph!;
    expect(g["1"].inputs.ckpt_name).toBe(CKPT);
    expect(g["2"].inputs.text).toBe(task.intent);
    expect(g["3"].inputs.text).toBe("blurry, low quality");
    expect(g["4"].inputs).toEqual({ width: 1024, height: 768, batch_size: 1 });
    expect(g["5"].inputs.seed).toBe(1234);
    expect(g["5"].inputs.steps).toBe(25);
    expect(g["5"].inputs.sampler_name).toBe("euler");
    // Links stay links.
    expect(g["5"].inputs.model).toEqual(["1", 0]);
    expect(out.values).toMatchObject({ checkpoint: CKPT, prompt: task.intent, width: 1024, seed: 1234 });
    expect(byId(out.checks, "contract.slot.width").message).toContain("task media.output.width");
    expect(byId(out.checks, "contract.slot.seed").message).toContain("binding");
    expect(byId(out.checks, "contract.slot.steps").message).toContain("default");
  });

  it("maps each output role and slot to its node", () => {
    const out = compileRecipe(recipe, task, { checkpoint: CKPT });
    expect(out.roleMap).toMatchObject({ image: "7", checkpoint: "1", prompt: "2", negative_prompt: "3", width: "4", seed: "5" });
  });

  it("never mutates the recipe", () => {
    const before = structuredClone(recipe);
    const out = compileRecipe(recipe, task, { checkpoint: CKPT, seed: 9 });
    expect(recipe).toEqual(before);
    expect(out.graph).not.toBe(recipe.graph);
    expect(out.graph!["1"]).not.toBe(recipe.graph["1"]);
    expect(recipe.graph["1"].inputs.ckpt_name).toBe("");
  });

  it("prefers the task over the default, and a binding over the default", () => {
    const withDefault = variant(recipe, {
      slots: recipe.slots.map((s) => (s.id === "width" ? { ...s, default: 512 } : s)),
    });
    expect(compileRecipe(withDefault, task, { checkpoint: CKPT }).graph!["4"].inputs.width).toBe(1024);
    expect(compileRecipe(withDefault, task, { checkpoint: CKPT, width: 1024 }).graph!["4"].inputs.width).toBe(1024);
    expect(compileRecipe(recipe, task, { checkpoint: CKPT, steps: 30 }).graph!["5"].inputs.steps).toBe(30);
  });

  it("refuses a binding that overrides what the task fills, so nothing is relaxed silently (GAPS Q15)", () => {
    const smaller = compileRecipe(recipe, task, { checkpoint: CKPT, width: 512 });
    expect(byId(smaller.checks, "contract.slot.width")).toMatchObject({ verdict: "fail", hard: true });
    expect(byId(smaller.checks, "contract.slot.width").message).toContain("revise the task");
    expect(smaller.graph).toBeUndefined();
    const otherPrompt = compileRecipe(recipe, task, { checkpoint: CKPT, prompt: "something else" });
    expect(byId(otherPrompt.checks, "contract.slot.prompt").verdict).toBe("fail");
  });

  describe("the task fields the recipe honours (GAPS Q16)", () => {
    const shape = (output: Record<string, unknown>) =>
      fixtureTask({ media: { kind: "image", operation: "text_to_image", output: { width: 1024, height: 768, ...output } } });

    it("passes fields a slot fills or the recipe declares", () => {
      const out = compileRecipe(recipe, task, { checkpoint: CKPT });
      for (const f of ["width", "height", "count", "format"]) expect(byId(out.checks, `contract.task.${f}`).verdict).toBe("pass");
    });

    it("fails a format the recipe doesn't write, and a count it can't fill", () => {
      expect(byId(compileRecipe(recipe, shape({ format: "webp" }), { checkpoint: CKPT }).checks, "contract.task.format")).toMatchObject({
        verdict: "fail",
        hard: true,
      });
      const noCountSlot = variant(recipe, { slots: recipe.slots.filter((s) => s.id !== "batch_size") });
      expect(byId(compileRecipe(noCountSlot, shape({ count: 4 }), { checkpoint: CKPT }).checks, "contract.task.count").verdict).toBe("fail");
    });

    it("leaves a field nothing decides as a hard unknown, never a pass", () => {
      const undeclared = variant(recipe, { outputs: [{ role: "image", node: "7" }] });
      expect(byId(compileRecipe(undeclared, task, { checkpoint: CKPT }).checks, "contract.task.format")).toMatchObject({
        verdict: "unknown",
        hard: true,
      });
      const noWidth = variant(recipe, {
        slots: recipe.slots.map((s) => (s.id === "width" ? { ...s, fromTask: undefined, default: 1024 } : s)),
      });
      expect(byId(compileRecipe(noWidth, task, { checkpoint: CKPT }).checks, "contract.task.width").verdict).toBe("unknown");
      // An input the recipe has no slot for fails as unsupported (GAPS Q16), never passes.
      const withInput = fixtureTask({ inputs: [{ assetId: "comfyui-input:ref.png", role: "reference_image" }] });
      expect(byId(compileRecipe(recipe, withInput, { checkpoint: CKPT }).checks, "contract.task.inputs.reference_image.1")).toMatchObject({
        verdict: "fail",
        hard: true,
      });
    });
  });

  it("falls back to the default when the task path doesn't resolve, and never reads the prototype", () => {
    const r = variant(recipe, {
      slots: recipe.slots.map((s) =>
        s.id === "steps" ? { ...s, fromTask: "media.output.nope" } : s.id === "cfg" ? { ...s, fromTask: "__proto__.constructor" } : s,
      ),
    });
    const out = compileRecipe(r, task, { checkpoint: CKPT });
    expect(out.graph!["5"].inputs.steps).toBe(25);
    expect(out.graph!["5"].inputs.cfg).toBe(6.5);
  });

  it("leaves an optional slot without a value at the recipe's value, not applicable", () => {
    const r = variant(recipe, {
      slots: recipe.slots.map((s) => (s.id === "negative_prompt" ? { ...s, default: undefined } : s)),
    });
    const out = compileRecipe(r, task, { checkpoint: CKPT });
    expect(byId(out.checks, "contract.slot.negative_prompt")).toMatchObject({ verdict: "not_applicable", hard: false });
    expect(out.graph!["3"].inputs.text).toBe("");
  });

  describe("fingerprint", () => {
    it("is a sha256 over canonical JSON, stable across compilations", () => {
      const a = compileRecipe(recipe, task, { checkpoint: CKPT });
      const b = compileRecipe(recipe, task, { checkpoint: CKPT });
      expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(a.fingerprint).toBe(b.fingerprint);
      expect(a.fingerprint).toBe(graphFingerprint(a.graph!));
    });

    it("ignores key order at every level", () => {
      const g: ApiGraph = {
        "1": { class_type: "A", inputs: { x: 1, y: ["2", 0] } },
        "2": { class_type: "B", inputs: { z: "s" }, _meta: { title: "t" } },
      };
      const shuffled: ApiGraph = {
        "2": { _meta: { title: "t" }, inputs: { z: "s" }, class_type: "B" },
        "1": { inputs: { y: ["2", 0], x: 1 }, class_type: "A" },
      };
      expect(graphFingerprint(shuffled)).toBe(graphFingerprint(g));
      expect(canonicalJson(shuffled)).toBe(
        '{"1":{"class_type":"A","inputs":{"x":1,"y":["2",0]}},"2":{"_meta":{"title":"t"},"class_type":"B","inputs":{"z":"s"}}}',
      );
    });

    it("changes when a value changes", () => {
      const a = compileRecipe(recipe, task, { checkpoint: CKPT, seed: 1 });
      const b = compileRecipe(recipe, task, { checkpoint: CKPT, seed: 2 });
      expect(a.fingerprint).not.toBe(b.fingerprint);
    });

    it("keeps array order significant", () => {
      expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    });
  });

  describe("contract failures return no graph", () => {
    function expectFail(out: ReturnType<typeof compileRecipe>, id: string, text?: string): void {
      const c = byId(out.checks, id);
      expect(c).toMatchObject({ verdict: "fail", hard: true, layer: "contract" });
      if (text) expect(c.message).toContain(text);
      expect(out.graph).toBeUndefined();
      expect(out.fingerprint).toBeUndefined();
    }

    it("a binding for a slot the recipe doesn't have", () => {
      expectFail(compileRecipe(recipe, task, { checkpoint: CKPT, chekpoint: CKPT }), "contract.binding.chekpoint");
    });

    it("a kind mismatch", () => {
      const video = variant(recipe, { kind: "video", operations: ["text_to_video"] });
      expectFail(compileRecipe(video, task, { checkpoint: CKPT }), "contract.kind", "video");
    });

    it("an operation the recipe doesn't support", () => {
      const upscaleTask = fixtureTask({
        media: { kind: "image", operation: "upscale", output: { width: 2048, height: 2048 } },
      });
      expectFail(compileRecipe(recipe, upscaleTask, { checkpoint: CKPT }), "contract.operation", "upscale");
    });

    it("a required slot without any value", () => {
      const noDefault = variant(recipe, {
        slots: recipe.slots.map((s) => (s.id === "checkpoint" ? { ...s, default: undefined } : s)),
      });
      expectFail(compileRecipe(noDefault, task, {}), "contract.slot.checkpoint", "no binding");
    });

    it.each([
      ["a non-integer int", { steps: 20.5 }, "contract.slot.steps", "integer"],
      ["an int below min", { steps: 0 }, "contract.slot.steps", "minimum"],
      ["an int above max", { steps: 151 }, "contract.slot.steps", "maximum"],
      ["a string for an int", { steps: "20" }, "contract.slot.steps", "finite number"],
      ["a non-finite float", { cfg: Number.NaN }, "contract.slot.cfg", "finite number"],
      ["a float above max", { cfg: 31 }, "contract.slot.cfg", "maximum"],
      ["a negative seed", { seed: -1 }, "contract.slot.seed", "seed"],
      ["a fractional seed", { seed: 1.5 }, "contract.slot.seed", "seed"],
      ["a seed beyond 2^53", { seed: 2 ** 60 }, "contract.slot.seed", "seed"],
      ["an empty string", { negative_prompt: "" }, "contract.slot.negative_prompt", "non-empty"],
      ["a blank string", { negative_prompt: "   " }, "contract.slot.negative_prompt", "non-empty"],
      ["a number for a model file", { checkpoint: 3 }, "contract.slot.checkpoint", "non-empty string"],
      ["an enum value outside its choices", { sampler: "lms" }, "contract.slot.sampler", "not one of"],
    ])("%s", (_label, extra, id, text) => {
      expectFail(compileRecipe(recipe, task, { checkpoint: CKPT, ...extra }), id, text);
    });

    it("a task value outside the slot's bounds", () => {
      const big = fixtureTask({ media: { kind: "image", operation: "text_to_image", output: { width: 8192, height: 768 } } });
      expectFail(compileRecipe(recipe, big, { checkpoint: CKPT }), "contract.slot.width", "task media.output.width");
    });

    it("an enum slot without choices", () => {
      const r = variant(recipe, {
        slots: recipe.slots.map((s) => (s.id === "sampler" ? { ...s, choices: undefined } : s)),
      });
      expectFail(compileRecipe(r, task, { checkpoint: CKPT }), "contract.slot.sampler", "no choices");
    });

    it("a slot whose target input is a link", () => {
      const r = variant(recipe, {
        slots: [
          ...recipe.slots,
          { id: "clip_override", label: "x", valueType: "string", target: { node: "2", input: "clip" }, required: true, default: "x" },
        ],
      });
      expectFail(compileRecipe(r, task, { checkpoint: CKPT }), "contract.slot.clip_override", "link");
    });

    it("a role and a slot that share a name but not a node", () => {
      const r = variant(recipe, { outputs: [{ role: "checkpoint", node: "7" }] });
      expectFail(compileRecipe(r, task, { checkpoint: CKPT }), "contract.role_map", "checkpoint");
    });
  });
});
