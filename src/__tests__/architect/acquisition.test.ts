// Milestone 4, part A (TODO 4.2, 4.3): the contracts for pinned model sources, acquirable
// candidates, the acquire_models effect and acquisition records; the acquisition policy;
// fromTaskDivisor in the compiler; and the store's acquisitions with migration 4.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_ACQUISITION_BYTES, acquisitionPolicy, deriveAcquisition } from "../../services/architect/acquisition-policy.js";
import { compileRecipe } from "../../services/architect/compile.js";
import { MIGRATIONS, SCHEMA_MIGRATIONS_SQL } from "../../services/architect/migrations.js";
import { STATUS_ORDER, planCandidates, renderScaleNote, type PlanningInput } from "../../services/architect/planner.js";
import {
  ACQUISITION_TRANSITIONS,
  AcquisitionRecord,
  AcquisitionState,
  ActionPlan,
  Effect,
  FINAL_ACQUISITION_STATES,
  ModelSource,
  PlanCandidate,
  Recipe,
  RecipeSlot,
  StoredRecordError,
  actionPlanHash,
  canAcquisitionTransition,
  parseStored,
} from "../../services/architect/schemas.js";
import {
  ARCHITECT_DB_FILE,
  ArchitectStore,
  IllegalAcquisitionTransitionError,
  StoreConflictError,
} from "../../services/architect/store.js";
import {
  BASE_URL,
  T,
  T1,
  actionPlan as renderActionPlan,
  approvalRequest,
  candidate,
  env,
  grant,
  plan,
  run,
  task as execTask,
} from "./fixtures/execution-records.js";
import { fixtureObjectInfo, fixtureRecipe, fixtureSnapshot, fixtureTask } from "./fixtures/load.js";

const SHA = "37f9a931c215f040aa6d50f711f2cb115f713c46df1d0d6469a8bd7bfe9a60bb";
const COMMIT = "5fd49b7b278836f48af63ecd314d0f98ab336105";

function source(over: Partial<Record<string, unknown>> = {}) {
  return {
    kind: "huggingface" as const,
    repo: "Comfy-Org/Real-ESRGAN",
    revision: COMMIT,
    path: "RealESRGAN_x4plus.safetensors",
    sha256: SHA,
    sizeBytes: 66857836,
    license: "bsd-3-clause",
    ...over,
  };
}

// ---------------------------------------------------------------------------------------
// Schemas

describe("ModelSource", () => {
  it("takes a commit-pinned Hugging Face file", () => {
    expect(ModelSource.safeParse(source()).success).toBe(true);
    expect(ModelSource.safeParse(source({ path: "split_files/vae/ae.safetensors", license: undefined })).success).toBe(true);
  });

  it.each([
    ["a branch name as revision", { revision: "main" }],
    ["a short commit", { revision: COMMIT.slice(0, 12) }],
    ["an upper-case commit", { revision: COMMIT.toUpperCase() }],
    ["a '..' segment", { path: "split_files/../../etc/passwd.safetensors" }],
    ["an absolute path", { path: "/etc/model.safetensors" }],
    ["a backslash", { path: "split_files\\vae.safetensors" }],
    ["an empty segment", { path: "split_files//vae.safetensors" }],
    ["upper-case hex in the sha256", { sha256: SHA.toUpperCase() }],
    ["a repo without an owner", { repo: "Real-ESRGAN" }],
    ["a '..' repo name", { repo: "Comfy-Org/.." }],
    ["a size of zero", { sizeBytes: 0 }],
    ["another source kind", { kind: "civitai" }],
    ["an unknown property", { url: "https://example.com/x.safetensors" }],
  ])("refuses %s", (_what, over) => {
    expect(ModelSource.safeParse(source(over)).success).toBe(false);
  });
});

describe("Recipe.modelSources and RecipeSlot.fromTaskDivisor", () => {
  const base = fixtureRecipe("t2i-basic");

  it("leaves a recipe without modelSources as it was, so its content hash doesn't change", () => {
    expect(base.modelSources).toBeUndefined();
  });

  it("takes a file name that differs from the repository path's last segment", () => {
    const r = Recipe.safeParse({ ...base, modelSources: [{ folder: "checkpoints", file: "renamed.safetensors", source: source() }] });
    expect(r.success).toBe(true);
  });

  it("refuses a duplicate folder and file, a file with a path, and a folder that climbs", () => {
    const entry = { folder: "checkpoints", file: "a.safetensors", source: source() };
    expect(Recipe.safeParse({ ...base, modelSources: [entry, { ...entry, source: source({ sizeBytes: 1 }) }] }).success).toBe(false);
    expect(Recipe.safeParse({ ...base, modelSources: [{ ...entry, file: "sub/a.safetensors" }] }).success).toBe(false);
    expect(Recipe.safeParse({ ...base, modelSources: [{ ...entry, file: ".." }] }).success).toBe(false);
    expect(Recipe.safeParse({ ...base, modelSources: [{ ...entry, folder: ".." }] }).success).toBe(false);
    expect(Recipe.safeParse({ ...base, modelSources: [{ ...entry, folder: "a/b" }] }).success).toBe(false);
  });

  it("takes a divisor of at least 2 only on a slot that fills from the task", () => {
    const width = base.slots.find((s) => s.id === "width");
    const seed = base.slots.find((s) => s.id === "seed");
    expect(RecipeSlot.safeParse({ ...width, fromTaskDivisor: 2 }).success).toBe(true);
    expect(RecipeSlot.safeParse({ ...width, fromTaskDivisor: 1 }).success).toBe(false);
    expect(RecipeSlot.safeParse({ ...width, fromTaskDivisor: 1.5 }).success).toBe(false);
    expect(RecipeSlot.safeParse({ ...seed, fromTaskDivisor: 2 }).success).toBe(false);
  });
});

describe("PlanCandidate.acquisition", () => {
  const acquisition = { files: [{ slot: "checkpoint", folder: "checkpoints", file: "a.safetensors", source: source() }], totalBytes: 66857836 };

  it("is set exactly when the status is acquirable", () => {
    expect(PlanCandidate.safeParse({ ...candidate, status: "acquirable", acquisition }).success).toBe(true);
    expect(PlanCandidate.safeParse({ ...candidate, status: "acquirable" }).success).toBe(false);
    expect(PlanCandidate.safeParse({ ...candidate, status: "feasible", acquisition }).success).toBe(false);
    expect(PlanCandidate.safeParse({ ...candidate, status: "blocked", acquisition }).success).toBe(false);
  });

  it("refuses a total that isn't the files' sum, no files, and a file listed twice", () => {
    expect(PlanCandidate.safeParse({ ...candidate, status: "acquirable", acquisition: { ...acquisition, totalBytes: 1 } }).success).toBe(false);
    expect(PlanCandidate.safeParse({ ...candidate, status: "acquirable", acquisition: { files: [], totalBytes: 0 } }).success).toBe(false);
    const twice = { files: [...acquisition.files, ...acquisition.files], totalBytes: 2 * 66857836 };
    expect(PlanCandidate.safeParse({ ...candidate, status: "acquirable", acquisition: twice }).success).toBe(false);
  });
});

const acquireEffect = {
  kind: "acquire_models" as const,
  files: [{ folder: "upscale_models", file: "RealESRGAN_x4plus.safetensors", source: source(), destinationRoot: "/Users/test/ComfyUI/models" }],
  totalBytes: 66857836,
  maxBytes: MAX_ACQUISITION_BYTES,
  minFreeBytes: 50 * 1024 ** 3,
};

describe("the acquire_models effect", () => {
  it("is an effect, and the action plan's hash covers each file's source", () => {
    expect(Effect.safeParse(acquireEffect).success).toBe(true);
    const binding = { ...renderActionPlan, effects: [acquireEffect, ...renderActionPlan.effects] };
    const changed = {
      ...binding,
      effects: [{ ...acquireEffect, files: [{ ...acquireEffect.files[0], source: source({ revision: "0".repeat(40) }) }] }, ...renderActionPlan.effects],
    };
    expect(actionPlanHash(binding)).not.toBe(actionPlanHash(changed));
    expect(actionPlanHash(binding)).not.toBe(renderActionPlan.hash);
    expect(ActionPlan.safeParse({ ...binding, hash: actionPlanHash(binding) }).success).toBe(true);
  });

  it.each([
    ["a relative destination root", { files: [{ ...acquireEffect.files[0], destinationRoot: "models" }] }],
    ["no files", { files: [], totalBytes: 0 }],
    ["a total that isn't the files' sum", { totalBytes: 5 }],
    ["a total above maxBytes", { maxBytes: 1000 }],
    ["an unknown property", { url: "https://huggingface.co/x" }],
  ])("refuses %s", (_what, over) => {
    expect(Effect.safeParse({ ...acquireEffect, ...over }).success).toBe(false);
  });
});

const acquisition = {
  schemaVersion: 1 as const,
  id: "acq-1",
  runId: "run-1",
  actionPlanId: "actions-1",
  folder: "upscale_models",
  file: "RealESRGAN_x4plus.safetensors",
  source: source(),
  destinationRoot: "/Users/test/ComfyUI/models",
  state: "planned" as const,
  createdAt: T,
  updatedAt: T,
};

describe("AcquisitionRecord through parseStored", () => {
  it("reads the current version", () => {
    expect(parseStored("acquisition", acquisition)).toEqual(acquisition);
  });

  it("refuses a missing field, a missing or newer schemaVersion, and an unknown property", () => {
    const { source: _s, ...missing } = acquisition;
    expect(() => parseStored("acquisition", missing)).toThrow(StoredRecordError);
    const { schemaVersion: _v, ...unversioned } = acquisition;
    expect(() => parseStored("acquisition", unversioned)).toThrow(/schemaVersion/);
    expect(() => parseStored("acquisition", { ...acquisition, schemaVersion: 2 })).toThrow(/newer/);
    expect(() => parseStored("acquisition", { ...acquisition, url: "https://example.com" })).toThrow(StoredRecordError);
  });

  it("refuses another record's id prefix, a failed record without an error, and a relative staged path", () => {
    expect(AcquisitionRecord.safeParse({ ...acquisition, id: "run-1" }).success).toBe(false);
    expect(AcquisitionRecord.safeParse({ ...acquisition, state: "failed" }).success).toBe(false);
    expect(
      AcquisitionRecord.safeParse({ ...acquisition, state: "failed", error: { code: "DEPENDENCY_UNAVAILABLE", message: "sha256 mismatch" } }).success,
    ).toBe(true);
    expect(AcquisitionRecord.safeParse({ ...acquisition, state: "downloading", stagedPath: "staging/x" }).success).toBe(false);
  });

  it("calls a record placed only with its path and the pinned hash and size observed", () => {
    const placed = { ...acquisition, state: "placed", placedPath: "/m/upscale_models/x.safetensors", observedSha256: SHA, observedBytes: 66857836 };
    expect(AcquisitionRecord.safeParse(placed).success).toBe(true);
    expect(AcquisitionRecord.safeParse({ ...placed, observedSha256: "0".repeat(64) }).success).toBe(false);
    expect(AcquisitionRecord.safeParse({ ...placed, observedBytes: 1 }).success).toBe(false);
    const { placedPath: _p, ...unplaced } = placed;
    expect(AcquisitionRecord.safeParse(unplaced).success).toBe(false);
  });
});

describe("ACQUISITION_TRANSITIONS", () => {
  it("allows the forward path and the two restart edges, and nothing out of a final state", () => {
    expect(canAcquisitionTransition("planned", "downloading")).toBe(true);
    expect(canAcquisitionTransition("downloading", "verifying")).toBe(true);
    expect(canAcquisitionTransition("verifying", "placed")).toBe(true);
    expect(canAcquisitionTransition("downloading", "planned")).toBe(true);
    expect(canAcquisitionTransition("verifying", "downloading")).toBe(true);
    for (const s of FINAL_ACQUISITION_STATES) expect(ACQUISITION_TRANSITIONS[s]).toEqual([]);
  });

  it("forbids skipping verification, cancelling midway through it, and staying in place", () => {
    expect(canAcquisitionTransition("planned", "placed")).toBe(false);
    expect(canAcquisitionTransition("downloading", "placed")).toBe(false);
    expect(canAcquisitionTransition("verifying", "cancelled")).toBe(false);
    expect(canAcquisitionTransition("placed", "downloading")).toBe(false);
    for (const s of AcquisitionState.options) expect(canAcquisitionTransition(s, s)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// fromTaskDivisor in the compiler (contract layer, GAPS Q15/Q16)

describe("renderScaleNote (the candidate's rationale shows what fromTaskDivisor does)", () => {
  const shipped = Recipe.parse(
    JSON.parse(readFileSync(new URL("../../../architect/recipes/recipe-zimage-turbo.t2i-upscale2x.recipe.json", import.meta.url), "utf-8")),
  );
  const task2048 = fixtureTask({ media: { kind: "image", operation: "text_to_image", output: { width: 2048, height: 2048 } } });

  it("names the generated size and the upscale chain before the user selects", () => {
    const bindings = { upscale_model: "RealESRGAN_x4plus.safetensors" };
    expect(renderScaleNote(shipped, task2048, bindings)).toBe("; generates at 1024×1024 and upscales 2× to 2048×2048 with RealESRGAN_x4plus.safetensors");
  });

  it("says nothing for a recipe that renders at the task's size", () => {
    expect(renderScaleNote(fixtureRecipe("t2i-basic"), fixtureTask(), {})).toBe("");
  });

  it("is part of the planned candidate's ranking explanation", () => {
    const out = planCandidates(input({ task: task2048, recipes: [shipped], objectInfo: fixtureObjectInfo() }));
    const c = out.presented.find((x) => x.recipeId === shipped.id);
    expect(c?.ranking.explanation).toContain("generates at 1024×1024 and upscales 2× to 2048×2048 with RealESRGAN_x4plus.safetensors");
  });
});

describe("fromTaskDivisor", () => {
  function halved(): Recipe {
    const r = fixtureRecipe("t2i-basic");
    return {
      ...r,
      slots: r.slots.map((s) => (s.id === "width" || s.id === "height" ? { ...s, fromTaskDivisor: 2 } : s)),
    };
  }

  it("writes the task's value divided, and the contract still counts the task's size as set", () => {
    const out = compileRecipe(halved(), fixtureTask(), {});
    expect(out.graph?.["4"].inputs).toMatchObject({ width: 512, height: 384 });
    expect(out.checks.find((c) => c.id === "contract.slot.width")?.message).toContain("media.output.width / 2");
    expect(out.checks.find((c) => c.id === "contract.task.width")).toMatchObject({ verdict: "pass" });
  });

  it("fails an odd task size rather than rounding it", () => {
    const task = fixtureTask({ media: { kind: "image", operation: "text_to_image", output: { width: 1024, height: 767 } } });
    const out = compileRecipe(halved(), task, {});
    expect(out.graph).toBeUndefined();
    expect(out.checks.find((c) => c.id === "contract.slot.height")).toMatchObject({ verdict: "fail", hard: true });
    expect(out.checks.find((c) => c.id === "contract.slot.height")?.message).toMatch(/767.*isn't divisible by 2/);
  });

  it("holds a binding to the divided value: equal passes, the undivided value fails (GAPS Q15)", () => {
    expect(compileRecipe(halved(), fixtureTask(), { width: 512 }).checks.find((c) => c.id === "contract.slot.width")?.verdict).toBe("pass");
    const over = compileRecipe(halved(), fixtureTask(), { width: 1024 });
    expect(over.graph).toBeUndefined();
    expect(over.checks.find((c) => c.id === "contract.slot.width")?.message).toMatch(/differs from the task's media\.output\.width \/ 2 \(512\)/);
  });
});

// ---------------------------------------------------------------------------------------
// The acquisition policy and the planner

let n = 0;
const MISSING = "missing.safetensors";

/** The t2i fixture with `default` as its checkpoint, a given id, and optional pinned sources. */
function t2i(id: string, opts: { default?: string; folder?: string; sources?: Recipe["modelSources"] } = {}): Recipe {
  const r = fixtureRecipe("t2i-basic");
  return {
    ...r,
    id,
    slots: r.slots.map((s) =>
      s.id === "checkpoint" ? { ...s, default: opts.default ?? s.default, modelFolder: opts.folder ?? s.modelFolder } : s,
    ),
    ...(opts.sources ? { modelSources: opts.sources } : {}),
  };
}
const pinned = (over: Partial<Record<string, unknown>> = {}) => [{ folder: "checkpoints", file: MISSING, source: ModelSource.parse(source(over)) }];

function input(over: Partial<PlanningInput> = {}): PlanningInput {
  return {
    task: fixtureTask(),
    snapshot: fixtureSnapshot(),
    objectInfo: fixtureObjectInfo(),
    recipes: [],
    planId: "plan-test",
    now: () => new Date(T),
    newId: () => `a${++n}`,
    ...over,
  };
}

describe("acquisitionPolicy", () => {
  const files = [{ folder: "checkpoints", file: MISSING, source: ModelSource.parse(source()) }];
  it("accepts a pinned .safetensors file within 40 GB when downloads need approval or are allowed", () => {
    expect(acquisitionPolicy(fixtureTask(), files)).toMatchObject({ allowed: true, totalBytes: 66857836, maxBytes: MAX_ACQUISITION_BYTES });
    const allowed = fixtureTask({ constraints: { ...fixtureTask().constraints, modelDownloads: "allowed" } });
    expect(acquisitionPolicy(allowed, files).allowed).toBe(true);
  });

  it("applies the task's lower byte budget, and never one above 40 GB", () => {
    expect(acquisitionPolicy(fixtureTask({ budgets: { maxDownloadBytes: 1000 } }), files)).toMatchObject({ allowed: false, maxBytes: 1000 });
    expect(acquisitionPolicy(fixtureTask({ budgets: { maxDownloadBytes: 10 * MAX_ACQUISITION_BYTES } }), files).maxBytes).toBe(MAX_ACQUISITION_BYTES);
  });

  it("is case-insensitive about the extension", () => {
    const upper = [{ ...files[0], source: ModelSource.parse(source({ path: "X.SafeTensors" })) }];
    expect(acquisitionPolicy(fixtureTask(), upper).allowed).toBe(true);
  });
});

describe("planCandidates with pinned sources", () => {
  it("makes a candidate acquirable when only pinned files are missing; its checks stay fail", () => {
    const out = planCandidates(input({ recipes: [t2i("recipe-acq", { default: MISSING, sources: pinned() })] }));
    const [c] = out.presented;
    expect(c.status).toBe("acquirable");
    expect(c.validation.overall).toBe("fail");
    expect(c.acquisition).toEqual({ files: [{ slot: "checkpoint", folder: "checkpoints", file: MISSING, source: source() }], totalBytes: 66857836 });
    expect(c.ranking.explanation).toContain("acquirable: 1 file(s)");
    expect(PlanCandidate.safeParse(c).success).toBe(true);
    expect(out.blockers.missing_dependencies).toEqual([]);
  });

  it("keeps a candidate blocked when a missing file has no pinned source, and says so", () => {
    const sources = [{ folder: "checkpoints", file: "other.safetensors", source: ModelSource.parse(source()) }];
    const out = planCandidates(input({ recipes: [t2i("recipe-acq", { default: MISSING, sources })] }));
    expect(out.presented[0].status).toBe("blocked");
    expect(out.presented[0].acquisition).toBeUndefined();
    expect(out.blockers.missing_dependencies.join(" ")).toContain(`no pinned source for checkpoints/${MISSING}`);
  });

  it("keeps it blocked when the task forbids downloads", () => {
    const task = fixtureTask({ constraints: { ...fixtureTask().constraints, modelDownloads: "forbidden" } });
    const out = planCandidates(input({ task, recipes: [t2i("recipe-acq", { default: MISSING, sources: pinned() })] }));
    expect(out.presented[0].status).toBe("blocked");
    expect(out.blockers.policy_conflicts.join(" ")).toContain("downloads forbidden by the task");
  });

  it("keeps it blocked over the size limit, the task's or the 40 GB one", () => {
    const big = planCandidates(input({ recipes: [t2i("recipe-acq", { default: MISSING, sources: pinned({ sizeBytes: MAX_ACQUISITION_BYTES + 1 }) })] }));
    expect(big.presented[0].status).toBe("blocked");
    expect(big.blockers.resource_limits.join(" ")).toContain("over the size limit");
    const task = fixtureTask({ budgets: { maxDownloadBytes: 1024 } });
    const budget = planCandidates(input({ task, recipes: [t2i("recipe-acq", { default: MISSING, sources: pinned() })] }));
    expect(budget.presented[0].status).toBe("blocked");
    expect(budget.blockers.resource_limits.join(" ")).toContain("maxDownloadBytes");
  });

  it("keeps it blocked for a source that isn't .safetensors", () => {
    const out = planCandidates(input({ recipes: [t2i("recipe-acq", { default: MISSING, sources: pinned({ path: "model.ckpt" }) })] }));
    expect(out.presented[0].status).toBe("blocked");
    expect(out.blockers.policy_conflicts.join(" ")).toContain("not .safetensors");
  });

  it("keeps it blocked when the target has no such model folder, or when the folder wasn't read (#796)", () => {
    const sources = [{ folder: "diffusers", file: MISSING, source: ModelSource.parse(source()) }];
    const absent = planCandidates(input({ recipes: [t2i("recipe-acq", { default: MISSING, folder: "diffusers", sources })] }));
    expect(absent.presented[0].status).toBe("blocked");
    expect(absent.blockers.missing_dependencies.join(" ")).toContain("no model folder diffusers");
    const loras = [{ folder: "loras", file: MISSING, source: ModelSource.parse(source()) }];
    const unread = planCandidates(input({ recipes: [t2i("recipe-acq", { default: MISSING, folder: "loras", sources: loras })] }));
    // The loader's list fails the file, and the unread folder leaves its install unknown:
    // a hard unknown, so a download isn't known to fix it.
    expect(unread.presented[0].status).toBe("blocked");
    expect(unread.presented[0].acquisition).toBeUndefined();
  });

  it("never makes a candidate acquirable while another hard check fails or is unknown", () => {
    const noSchemas = planCandidates(input({ objectInfo: undefined, recipes: [t2i("recipe-acq", { default: MISSING, sources: pinned() })] }));
    expect(noSchemas.presented[0].status).not.toBe("acquirable");
    const task = fixtureTask({ media: { kind: "image", operation: "text_to_image", output: { width: 1024, height: 768, count: 2 } } });
    const recipe = { ...t2i("recipe-acq", { default: MISSING, sources: pinned() }), slots: fixtureRecipe("t2i-basic").slots.map((s) => (s.id === "checkpoint" ? { ...s, default: MISSING } : s.id === "batch_size" ? { ...s, max: 1 } : s)) };
    expect(planCandidates(input({ task, recipes: [recipe] })).presented[0].status).toBe("blocked");
  });

  it("ranks feasible, then acquirable, then diagnostic, then blocked, whatever the recipe ids", () => {
    const blocked = t2i("recipe-a-blocked", { default: MISSING });
    const diagnostic = t2i("recipe-b-diagnostic", { folder: "loras" });
    const acquirable = t2i("recipe-c-acquirable", { default: MISSING, sources: pinned() });
    const feasible = t2i("recipe-d-feasible");
    const all = planCandidates(input({ recipes: [blocked, diagnostic, acquirable, feasible] }));
    expect(all.presented.map((c) => c.status)).toEqual(["feasible", "acquirable", "diagnostic"]);
    const rest = planCandidates(input({ recipes: [blocked, diagnostic, acquirable] }));
    expect(rest.presented.map((c) => c.status)).toEqual(["acquirable", "diagnostic", "blocked"]);
    expect(Object.keys(STATUS_ORDER)).toEqual(["feasible", "acquirable", "diagnostic", "blocked"]);
  });
});

describe("deriveAcquisition", () => {
  it("refuses when the snapshot the checks were made on isn't available", () => {
    const recipe = t2i("recipe-acq", { default: MISSING, sources: pinned() });
    const [c] = planCandidates(input({ recipes: [recipe] })).presented;
    const out = deriveAcquisition({ recipe, task: fixtureTask(), candidate: c, snapshot: undefined });
    expect(out.acquirable).toBe(false);
    expect(out.acquirable ? [] : out.refusals.map((r) => r.message).join(" ")).toContain("isn't available");
  });
});

// ---------------------------------------------------------------------------------------
// The store: migration 4 and acquisition repositories

let dir: string;
const opened: ArchitectStore[] = [];
function open(): ArchitectStore {
  const store = ArchitectStore.open(dir, { now: () => new Date(T) });
  opened.push(store);
  return store;
}
function raw(): BetterSqlite3.Database {
  return new BetterSqlite3(join(dir, ARCHITECT_DB_FILE));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "architect-acq-store-"));
});
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** An action plan that acquires the upscaler, then renders; with its request, grant and run. */
function seedRun(store: ArchitectStore, effects: Effect[] = [acquireEffect, ...renderActionPlan.effects]) {
  const binding = { ...renderActionPlan, effects };
  const hash = actionPlanHash(binding);
  store.putTaskRevision(execTask);
  store.putSnapshot(env);
  store.putPlan(plan);
  store.putCandidate(candidate);
  store.putActionPlan({ ...binding, hash });
  store.putApprovalRequest({ ...approvalRequest, actionPlanHash: hash });
  store.resolveApprovalRequest(approvalRequest.id, "granted", new Date(T1));
  store.putGrant({ ...grant, actionPlanHash: hash });
  return store.createRunWithGrant({ run, grantId: grant.id, now: new Date("2026-11-15T12:02:00.000Z") }).run;
}

let k = 0;
const newId = () => `${++k}`;

describe("migration 4", () => {
  it("applies on a database at version 3 and keeps its runs", () => {
    const db = raw();
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA_MIGRATIONS_SQL);
    for (const m of MIGRATIONS.filter((m) => m.version <= 3)) {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, T);
    }
    db.close();
    const store = open();
    const created = seedRun(store);
    expect(store.getRun(created.id)?.state).toBe("PREPARING");
    expect(store.createAcquisitions({ runId: created.id, now: new Date(T1), newId })).toHaveLength(1);
    const check = raw();
    expect(check.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: 4 });
    check.close();
  });
});

describe("acquisitions in the store", () => {
  it("creates one planned record per file of the run's action plan, once", () => {
    const store = open();
    const r = seedRun(store);
    const created = store.createAcquisitions({ runId: r.id, now: new Date(T1), newId });
    expect(created.map((a) => [a.state, a.folder, a.file, a.source.sha256, a.actionPlanId])).toEqual([
      ["planned", "upscale_models", "RealESRGAN_x4plus.safetensors", SHA, "actions-1"],
    ]);
    expect(store.listAcquisitions(r.id)).toEqual(created);
    // A restart in PREPARING gets the same records back, not a second set.
    expect(store.createAcquisitions({ runId: r.id, now: new Date(T1), newId })).toEqual(created);
    expect(store.listAcquisitions(r.id)).toHaveLength(1);
  });

  it("refuses a run whose action plan acquires nothing, and a run that isn't stored", () => {
    const store = open();
    const r = seedRun(store, renderActionPlan.effects);
    expect(() => store.createAcquisitions({ runId: r.id, now: new Date(T1), newId })).toThrow(/acquires no model files/);
    expect(() => store.createAcquisitions({ runId: "run-none", now: new Date(T1), newId })).toThrow(StoreConflictError);
  });

  it("walks the transition table and refuses forbidden or stale transitions", () => {
    const store = open();
    const r = seedRun(store);
    const [a] = store.createAcquisitions({ runId: r.id, now: new Date(T1), newId });
    const at = new Date(T1);
    expect(() => store.transitionAcquisition({ id: a.id, from: "planned", to: "placed", at })).toThrow(IllegalAcquisitionTransitionError);
    const downloading = store.transitionAcquisition({ id: a.id, from: "planned", to: "downloading", patch: { jobId: "job-1" }, at });
    expect(downloading).toMatchObject({ state: "downloading", jobId: "job-1" });
    expect(() => store.transitionAcquisition({ id: a.id, from: "planned", to: "downloading", at })).toThrow(/is downloading, not planned/);
    // The job was lost with the process: back to planned, its id cleared.
    const again = store.transitionAcquisition({ id: a.id, from: "downloading", to: "planned", patch: { jobId: null }, at });
    expect(again.jobId).toBeUndefined();
    store.transitionAcquisition({ id: a.id, from: "planned", to: "downloading", patch: { jobId: "job-2" }, at });
    store.transitionAcquisition({ id: a.id, from: "downloading", to: "verifying", patch: { stagedPath: "/m/.architect-staging/run-1/x" }, at });
    // Placed needs the pinned hash observed: the schema refuses anything else.
    expect(() =>
      store.transitionAcquisition({
        id: a.id,
        from: "verifying",
        to: "placed",
        patch: { placedPath: "/m/upscale_models/RealESRGAN_x4plus.safetensors", observedSha256: "0".repeat(64), observedBytes: 66857836 },
        at,
      }),
    ).toThrow();
    expect(store.getAcquisition(a.id)?.state).toBe("verifying");
    const placed = store.transitionAcquisition({
      id: a.id,
      from: "verifying",
      to: "placed",
      patch: { placedPath: "/m/upscale_models/RealESRGAN_x4plus.safetensors", observedSha256: SHA, observedBytes: 66857836 },
      at,
    });
    expect(placed.state).toBe("placed");
    expect(() => store.transitionAcquisition({ id: a.id, from: "placed", to: "downloading", at })).toThrow(IllegalAcquisitionTransitionError);
  });

  it("refuses a failed transition without an error", () => {
    const store = open();
    const r = seedRun(store);
    const [a] = store.createAcquisitions({ runId: r.id, now: new Date(T1), newId });
    expect(() => store.transitionAcquisition({ id: a.id, from: "planned", to: "failed", at: new Date(T1) })).toThrow();
    const failed = store.transitionAcquisition({
      id: a.id,
      from: "planned",
      to: "failed",
      patch: { error: { code: "DEPENDENCY_UNAVAILABLE", message: "HTTP 404 from huggingface.co" } },
      at: new Date(T1),
    });
    expect(failed.error?.code).toBe("DEPENDENCY_UNAVAILABLE");
  });

  it("keeps one row per run, folder and file", () => {
    const store = open();
    const r = seedRun(store);
    const [a] = store.createAcquisitions({ runId: r.id, now: new Date(T1), newId });
    const db = raw();
    const row = db.prepare("SELECT * FROM acquisitions WHERE id = ?").get(a.id) as Record<string, unknown>;
    expect(() =>
      db
        .prepare("INSERT INTO acquisitions (id, run_id, state, folder, file, sha256, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("acq-dup", row.run_id, row.state, row.folder, row.file, row.sha256, row.created_at, row.updated_at, row.payload),
    ).toThrow(/UNIQUE/);
    db.close();
  });

  it("reads an edited payload as an error, never as the record", () => {
    const store = open();
    const r = seedRun(store);
    const [a] = store.createAcquisitions({ runId: r.id, now: new Date(T1), newId });
    const db = raw();
    db.prepare("UPDATE acquisitions SET payload = ? WHERE id = ?").run(JSON.stringify({ ...a, runId: "run-other" }), a.id);
    db.close();
    expect(() => store.getAcquisition(a.id)).toThrow(StoredRecordError);
    expect(BASE_URL).toBe(r.target.baseUrl);
  });
});
