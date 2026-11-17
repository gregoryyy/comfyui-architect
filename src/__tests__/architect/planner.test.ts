import { describe, expect, it } from "vitest";
import {
  contractGroup,
  MAX_EXPANDED_CANDIDATES,
  MAX_PRESENTED_CANDIDATES,
  missingTaskFields,
  planCandidates,
  type PlanningInput,
} from "../../services/architect/planner.js";
import { PlanCandidate, type PlanBlockers, type Recipe } from "../../services/architect/schemas.js";
import { fixtureObjectInfo, fixtureRecipe, fixtureSnapshot, fixtureTask } from "./fixtures/load.js";

let n = 0;

/** The text-to-image fixture without a default file, so its checkpoint is enumerated. */
function t2iWithoutDefault(): Recipe {
  const r = fixtureRecipe("t2i-basic");
  return { ...r, slots: r.slots.map((s) => (s.id === "checkpoint" ? { ...s, default: undefined } : s)) };
}
function input(over: Partial<PlanningInput> = {}): PlanningInput {
  return {
    task: fixtureTask(),
    snapshot: fixtureSnapshot(),
    objectInfo: fixtureObjectInfo(),
    recipes: [fixtureRecipe("t2i-basic"), fixtureRecipe("upscale-model")],
    planId: "plan-test",
    now: () => new Date("2026-11-15T12:00:00.000Z"),
    newId: () => `t${++n}`,
    ...over,
  };
}

describe("missingTaskFields", () => {
  it("asks for the inputs an operation needs", () => {
    const t = fixtureTask();
    expect(missingTaskFields(t)).toEqual([]);
    expect(missingTaskFields({ ...t, media: { ...t.media, operation: "inpaint" } })).toEqual([
      "inputs: a source_image asset (operation inpaint)",
      "inputs: a mask asset (operation inpaint)",
    ]);
    expect(
      missingTaskFields({ ...t, media: { ...t.media, operation: "upscale" }, inputs: [{ assetId: "a", role: "source_image" }] }),
    ).toEqual([]);
  });
});

describe("planCandidates", () => {
  it("builds schema-valid candidates from installed files, feasible first", () => {
    const out = planCandidates(input());
    expect(out.presented.length).toBeGreaterThan(0);
    expect(out.presented.length).toBeLessThanOrEqual(MAX_PRESENTED_CANDIDATES);
    for (const c of out.presented) expect(PlanCandidate.safeParse(c).success).toBe(true);
    const [best] = out.presented;
    expect(best.status).toBe("feasible");
    expect(best.recipeId).toBe("recipe-fixture.t2i-basic");
    expect(best.bindings.checkpoint).toBe("sd_xl_base_1.0.safetensors");
    expect(best.graphFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(best.resourceEstimate.status).toBe("unknown");
  });

  it("only binds files the snapshot lists, never a name it made up", () => {
    const listed = new Set(fixtureSnapshot().installedModels?.folders.checkpoints);
    for (const c of planCandidates(input()).presented) {
      if (c.recipeId === "recipe-fixture.t2i-basic") expect(listed.has(String(c.bindings.checkpoint))).toBe(true);
    }
  });

  it("blocks an agent-proposed model file the target doesn't list", () => {
    const out = planCandidates(input({ proposals: [{ recipeId: "recipe-fixture.t2i-basic", bindings: { checkpoint: "invented.safetensors" } }] }));
    const c = out.presented.find((x) => x.recipeId === "recipe-fixture.t2i-basic");
    expect(c?.status).toBe("blocked");
    expect(c?.dependencyDelta.missingModels.map((m) => m.file)).toContain("invented.safetensors");
    expect(out.blockers.missing_dependencies.join(" ")).toContain("invented.safetensors");
  });

  it("reports a proposal for a recipe that doesn't fit the task", () => {
    const out = planCandidates(input({ proposals: [{ recipeId: "recipe-nope", bindings: {} }] }));
    expect(out.blockers.unsupported_operation.join(" ")).toContain("recipe-nope");
  });

  it("says no recipe solves the operation when none does, and presents nothing", () => {
    const t = fixtureTask();
    const out = planCandidates(input({ task: { ...t, media: { ...t.media, operation: "inpaint" } } }));
    expect(out.presented).toEqual([]);
    expect(out.blockers.unsupported_operation).toEqual(["no recipe in the catalog solves image/inpaint"]);
  });

  it("keeps a candidate diagnostic, never feasible, when the node schemas couldn't be read", () => {
    const out = planCandidates(input({ objectInfo: undefined }));
    expect(out.presented.every((c) => c.status !== "feasible")).toBe(true);
    expect(out.blockers.insufficient_evidence.length).toBeGreaterThan(0);
  });

  it("blocks a recipe whose model folder lists nothing, instead of filling it", () => {
    const snapshot = fixtureSnapshot({
      installedModels: { folders: { checkpoints: [], upscale_models: [] }, unanswered: [], absent: [] },
    });
    const out = planCandidates(input({ snapshot }));
    const c = out.presented.find((x) => x.recipeId === "recipe-fixture.t2i-basic");
    expect(c?.status).toBe("blocked");
    expect(c?.dependencyDelta.missingModels.map((m) => m.file)).toEqual(["sd_xl_base_1.0.safetensors"]);
    const enumerated = planCandidates(input({ snapshot, recipes: [t2iWithoutDefault()] })).presented[0];
    expect(enumerated.status).toBe("blocked");
    expect(enumerated.bindings.checkpoint).toBeUndefined();
  });

  it("keeps a slot diagnostic, not blocked, when its folder wasn't read (#796)", () => {
    const snapshot = fixtureSnapshot({
      installedModels: { folders: {}, unanswered: [{ folder: "checkpoints", reason: "timeout" }], absent: [] },
    });
    const out = planCandidates(input({ snapshot, recipes: [t2iWithoutDefault()] }));
    expect(out.presented[0].status).toBe("diagnostic");
    expect(out.blockers.insufficient_evidence.join(" ")).toContain("checkpoints");
    expect(out.blockers.missing_dependencies).toEqual([]);
  });

  it("never makes an enumerated file of an unverified family feasible (GAPS Q14)", () => {
    const out = planCandidates(input({ recipes: [t2iWithoutDefault()] }));
    expect(out.presented.length).toBeGreaterThan(0);
    expect(out.presented.every((c) => c.status !== "feasible")).toBe(true);
  });

  it("expands at most 24 candidates and says when it cut enumeration short", () => {
    const files = Array.from({ length: 40 }, (_, i) => `m${String(i).padStart(2, "0")}.safetensors`);
    const snapshot = fixtureSnapshot({ installedModels: { folders: { checkpoints: files }, unanswered: [], absent: [] } });
    const out = planCandidates(input({ snapshot, recipes: [t2iWithoutDefault()] }));
    expect(out.expanded).toBe(MAX_EXPANDED_CANDIDATES);
    expect(out.truncated).toBe(true);
    expect(out.presented).toHaveLength(MAX_PRESENTED_CANDIDATES);
  });

  it("puts blocked candidates after feasible ones whatever their tier", () => {
    const curated = { ...fixtureRecipe("t2i-basic"), id: "recipe-curated.t2i", certification: "curated" as const };
    const proposals = [{ recipeId: "recipe-curated.t2i", bindings: { checkpoint: "invented.safetensors" } }];
    const out = planCandidates(input({ recipes: [curated, fixtureRecipe("t2i-basic")], proposals }));
    const statuses = out.presented.map((c) => `${c.recipeId}:${c.status}`);
    expect(statuses[0]).toBe("recipe-fixture.t2i-basic:feasible");
    expect(statuses).toContain("recipe-curated.t2i:blocked");
  });

  it("shows a recipe's second feasible candidate before another recipe's blocked one", () => {
    const curated = { ...fixtureRecipe("t2i-basic"), id: "recipe-curated.t2i", certification: "curated" as const };
    const proposals = [
      { recipeId: "recipe-fixture.t2i-basic", bindings: { seed: 1 } },
      { recipeId: "recipe-fixture.t2i-basic", bindings: { seed: 2 } },
      { recipeId: "recipe-curated.t2i", bindings: { checkpoint: "invented.safetensors" } },
    ];
    const out = planCandidates(input({ recipes: [curated, fixtureRecipe("t2i-basic")], proposals }));
    expect(out.presented.map((c) => c.status)).toEqual(["feasible", "feasible", "blocked"]);
  });
});

describe("planCandidates: the §9.5 group of a failing contract check", () => {
  const RECIPE = "recipe-fixture.t2i-basic";
  /** The fixture recipe alone, planned with one proposal or none. */
  function blockersFor(recipe: Recipe, bindings?: Record<string, string | number>, task = fixtureTask()): PlanBlockers {
    const out = planCandidates(input({ task, recipes: [recipe], ...(bindings ? { proposals: [{ recipeId: recipe.id, bindings }] } : {}) }));
    expect(out.presented.every((c) => c.status === "blocked")).toBe(true);
    return out.blockers;
  }
  const lines = (b: string[], text: string) => b.filter((l) => l.includes(text));

  // A proposal error is the agent's to fill or correct, so it is missing evidence, never an
  // operation the recipe can't serve.
  it("files a binding that names no slot as insufficient evidence", () => {
    const b = blockersFor(fixtureRecipe("t2i-basic"), { stepz: 30 });
    expect(lines(b.insufficient_evidence, `binding "stepz" names no slot of recipe ${RECIPE}`)).toHaveLength(1);
    expect(b.unsupported_operation).toEqual([]);
  });

  it("files a binding that contradicts the task as insufficient evidence", () => {
    const b = blockersFor(fixtureRecipe("t2i-basic"), { width: 512 });
    expect(lines(b.insufficient_evidence, "slot width: binding 512 differs from the task's media.output.width (1024)")).toHaveLength(1);
    expect(b.unsupported_operation).toEqual([]);
  });

  it("files a bound value of the wrong type or out of range as insufficient evidence", () => {
    const wrong = blockersFor(fixtureRecipe("t2i-basic"), { seed: "forty-two" });
    expect(lines(wrong.insufficient_evidence, 'slot seed (binding): expected a finite number, got "forty-two"')).toHaveLength(1);
    const range = blockersFor(fixtureRecipe("t2i-basic"), { steps: 999 });
    expect(lines(range.insufficient_evidence, "slot steps (binding): 999 is above the maximum 150")).toHaveLength(1);
    expect([...wrong.unsupported_operation, ...range.unsupported_operation]).toEqual([]);
  });

  it("files a bound input slot as insufficient evidence", () => {
    const r = fixtureRecipe("t2i-basic");
    const withInput: Recipe = {
      ...r,
      slots: [...r.slots, { id: "reference", label: "Reference", valueType: "input_image", target: { node: "2", input: "text" }, required: false, fromTask: "inputs.reference_image" }],
    };
    const b = blockersFor(withInput, { reference: "other.png" });
    expect(lines(b.insufficient_evidence, "slot reference takes the task's inputs.reference_image; it can't be bound")).toHaveLength(1);
    expect(b.unsupported_operation).toEqual([]);
  });

  it("files a required slot without a binding, task value or default as insufficient evidence", () => {
    const r = fixtureRecipe("t2i-basic");
    const open: Recipe = { ...r, slots: r.slots.map((s) => (s.id === "steps" ? { ...s, default: undefined } : s)) };
    const b = blockersFor(open);
    expect(lines(b.insufficient_evidence, "required slot steps has no binding, task value or default")).toHaveLength(1);
    expect(b.unsupported_operation).toEqual([]);
    // The same slot filled by the agent plans.
    expect(planCandidates(input({ recipes: [open], proposals: [{ recipeId: RECIPE, bindings: { steps: 20 } }] })).presented[0].status).toBe("feasible");
  });

  it("files a graph that isn't the recipe compiled with its bindings as insufficient evidence", () => {
    const r = fixtureRecipe("t2i-basic");
    expect(contractGroup(r, fixtureTask(), {}, fixtureSnapshot(), { id: "compiled_from_recipe" })).toBe("insufficient_evidence");
  });

  it("files an open model slot whose folder lists no file as a missing dependency", () => {
    const snapshot = fixtureSnapshot({ installedModels: { folders: { checkpoints: [] }, unanswered: [], absent: [] } });
    const out = planCandidates(input({ snapshot, recipes: [t2iWithoutDefault()] }));
    expect(lines(out.blockers.missing_dependencies, "required slot checkpoint has no binding, task value or default")).toHaveLength(1);
    expect(lines(out.blockers.insufficient_evidence, "required slot checkpoint has no binding")).toEqual([]);
  });

  // A capability failure stays unsupported: nothing the agent binds or the user installs serves it.
  it("files a task value the recipe can't take as an unsupported operation", () => {
    const t = fixtureTask();
    const b = blockersFor(fixtureRecipe("t2i-basic"), undefined, { ...t, media: { ...t.media, output: { ...t.media.output, count: 12 } } });
    expect(lines(b.unsupported_operation, "slot batch_size (task media.output.count): 12 is above the maximum 8")).toHaveLength(1);
    expect(b.insufficient_evidence.filter((l) => l.includes("batch_size"))).toEqual([]);
  });

  it("files a task size off the recipe's divisor as unsupported, even with a binding for the slot", () => {
    const r = fixtureRecipe("t2i-basic");
    const divided: Recipe = { ...r, slots: r.slots.map((s) => (s.id === "width" ? { ...s, fromTaskDivisor: 3 } : s)) };
    const b = blockersFor(divided, { width: 341 });
    expect(lines(b.unsupported_operation, "slot width: the task's media.output.width (1024) isn't divisible by 3")).toHaveLength(1);
    expect(b.insufficient_evidence.filter((l) => l.includes("slot width"))).toEqual([]);
  });
});
