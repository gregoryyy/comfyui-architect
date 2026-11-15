import { describe, expect, it } from "vitest";
import {
  MAX_EXPANDED_CANDIDATES,
  MAX_PRESENTED_CANDIDATES,
  missingTaskFields,
  planCandidates,
  type PlanningInput,
} from "../../services/architect/planner.js";
import { PlanCandidate, type Recipe } from "../../services/architect/schemas.js";
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
