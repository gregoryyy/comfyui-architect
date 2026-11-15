import { describe, expect, it } from "vitest";
import {
  EnvironmentSnapshot,
  Plan,
  PlanCandidate,
  Recipe,
  StoredRecordError,
  TaskSpec,
  TaskSpecInput,
  parseStored,
} from "../../services/architect/schemas.js";

const T = "2026-11-15T12:00:00.000Z";

const task = {
  schemaVersion: 1,
  id: "task-a1",
  revision: 1,
  createdAt: T,
  updatedAt: T,
  intent: "A red bicycle against a white wall.",
  media: { kind: "image", operation: "text_to_image", output: { width: 1024, height: 1024, count: 1, format: "png" } },
  inputs: [],
  constraints: {
    renderLocation: "local",
    remoteReasoning: "forbidden",
    remoteMediaDisclosure: "forbidden",
    newCustomNodes: "approval_required",
    modelDownloads: "approval_required",
    paidRenderNodes: "forbidden",
  },
  acceptance: [{ id: "shape", kind: "dimensions", required: true, expected: [1024, 1024] }],
  preferences: { quality: 0.5 },
  budgets: { maxPreviewRuns: 3 },
  policyProfile: "local-private",
};

const recipe = {
  schemaVersion: 1,
  id: "recipe-fixture.t2i",
  revision: 1,
  title: "Fixture text to image",
  description: "",
  kind: "image",
  operations: ["text_to_image"],
  graph: {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "placeholder.safetensors" } },
    "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "x" } },
  },
  slots: [
    {
      id: "checkpoint",
      label: "Checkpoint",
      valueType: "model_file",
      target: { node: "1", input: "ckpt_name" },
      required: true,
      modelFolder: "checkpoints",
    },
  ],
  outputs: [{ role: "image", node: "2" }],
  dependencies: { nodeClasses: ["CheckpointLoaderSimple", "SaveImage"] },
  certification: "fixture",
  evidence: [],
};

const env = {
  schemaVersion: 1,
  id: "env-1",
  capturedAt: T,
  target: { baseUrl: "http://127.0.0.1:8188" },
  probeErrors: [],
};

const plan = {
  schemaVersion: 1,
  id: "plan-1",
  taskId: "task-a1",
  taskRevision: 1,
  environmentId: "env-1",
  state: "PROPOSED",
  candidateIds: ["cand-1"],
  blockers: {
    missing_dependencies: [],
    unsupported_operation: [],
    insufficient_evidence: [],
    resource_limits: [],
    policy_conflicts: [],
  },
  createdAt: T,
  updatedAt: T,
};

const candidate = {
  schemaVersion: 1,
  id: "cand-1",
  planId: "plan-1",
  taskId: "task-a1",
  taskRevision: 1,
  recipeId: "recipe-fixture.t2i",
  recipeRevision: 1,
  environmentId: "env-1",
  bindings: { checkpoint: "a.safetensors" },
  transforms: [],
  graphFingerprint: "abc",
  roleMap: { image: "2" },
  validation: { checks: [], overall: "pass" },
  dependencyDelta: { missingModels: [], missingNodeClasses: [] },
  resourceEstimate: { status: "unknown", reason: "no measured profile" },
  ranking: { tier: "fixture", explanation: "fixture recipe" },
  status: "feasible",
  createdAt: T,
};

const RECORDS = [
  ["task", task],
  ["environment", env],
  ["recipe", recipe],
  ["plan", plan],
  ["candidate", candidate],
] as const;

describe("TaskSpecInput", () => {
  it("fills constraint, budget and policy defaults, so an omitted constraint is the strict one", () => {
    const parsed = TaskSpecInput.parse({
      intent: "x",
      media: { kind: "image", operation: "text_to_image", output: { width: 512, height: 512 } },
    });
    expect(parsed.constraints).toMatchObject({ remoteReasoning: "forbidden", paidRenderNodes: "forbidden" });
    expect(parsed.policyProfile).toBe("local-private");
    expect(parsed.media.output).toMatchObject({ count: 1, format: "png" });
  });

  it("rejects an unknown kind, an unknown operation and an unknown property", () => {
    const media = { kind: "image", operation: "text_to_image", output: { width: 512, height: 512 } };
    expect(TaskSpecInput.safeParse({ intent: "x", media: { ...media, kind: "video" } }).success).toBe(false);
    expect(TaskSpecInput.safeParse({ intent: "x", media: { ...media, operation: "paint" } }).success).toBe(false);
    expect(TaskSpecInput.safeParse({ intent: "x", media, colour: "red" }).success).toBe(false);
  });
});

describe("the stored records", () => {
  it("accept the version-1 fixtures", () => {
    expect(TaskSpec.safeParse(task).success).toBe(true);
    expect(EnvironmentSnapshot.safeParse(env).success).toBe(true);
    expect(Recipe.safeParse(recipe).success).toBe(true);
    expect(Plan.safeParse(plan).success).toBe(true);
    expect(PlanCandidate.safeParse(candidate).success).toBe(true);
  });

  it("refuse a recipe whose slot or output names a node the graph lacks", () => {
    const badSlot = { ...recipe, slots: [{ ...recipe.slots[0], target: { node: "9", input: "ckpt_name" } }] };
    const badOutput = { ...recipe, outputs: [{ role: "image", node: "9" }] };
    expect(Recipe.safeParse(badSlot).success).toBe(false);
    expect(Recipe.safeParse(badOutput).success).toBe(false);
  });

  it("refuse a model_file slot without a model folder, and an image recipe with a foreign operation", () => {
    const { modelFolder: _drop, ...slot } = recipe.slots[0];
    expect(Recipe.safeParse({ ...recipe, slots: [slot] }).success).toBe(false);
    expect(Recipe.safeParse({ ...recipe, operations: ["text_to_video"] }).success).toBe(false);
  });

  it("only allow an unknown resource estimate, so no number can be invented", () => {
    const invented = { ...candidate, resourceEstimate: { status: "estimated", peakBytes: 1 } };
    expect(PlanCandidate.safeParse(invented).success).toBe(false);
  });
});

describe("parseStored", () => {
  for (const [kind, rec] of RECORDS) {
    it(`${kind}: reads the current version`, () => {
      expect(parseStored(kind, rec)).toMatchObject({ schemaVersion: 1, id: rec.id });
    });

    it(`${kind}: refuses a missing or non-integer schemaVersion`, () => {
      const { schemaVersion: _drop, ...noVersion } = rec;
      expect(() => parseStored(kind, noVersion)).toThrow(StoredRecordError);
      expect(() => parseStored(kind, { ...rec, schemaVersion: 1.5 })).toThrow(/schemaVersion/);
    });

    it(`${kind}: refuses a newer version instead of reading what it understands`, () => {
      expect(() => parseStored(kind, { ...rec, schemaVersion: 2 })).toThrow(/newer than this build/);
    });

    it(`${kind}: refuses an unknown property`, () => {
      expect(() => parseStored(kind, { ...rec, injected: true })).toThrow(StoredRecordError);
    });
  }

  it("refuses something that is not an object", () => {
    expect(() => parseStored("task", "task-a1")).toThrow(/not an object/);
    expect(() => parseStored("task", [task])).toThrow(/not an object/);
  });
});
