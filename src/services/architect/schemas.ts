// Architect's runtime contracts (spec §7, §16). Zod is the authority; types are inferred.
//
// Kind-neutral by design (AGENTS, scope decisions): the core records carry a workflow
// `kind`, and everything that only makes sense for one kind (width and height for images,
// later frame count for video or sample rate for audio) lives in a part discriminated by
// that kind. Milestone 2 defines the image part; a new kind adds a union member, not a
// migration of the core records.
//
// Stored records carry `schemaVersion`; `parseStored` (below) is the one entry point that
// reads them back, so a later version adds its upgrade step there.

import { z } from "zod";
import { ARCHITECT_SCHEMA_VERSION } from "../../fork-identity.js";

// ---------------------------------------------------------------------------------------
// Shared vocabulary

/** Every kind of ComfyUI workflow the contracts must carry; the MVP certifies `image`. */
export const WorkflowKind = z.enum(["image", "video", "audio", "3d", "pipeline"]);
export type WorkflowKind = z.infer<typeof WorkflowKind>;

/** Check results keep four values; unknown never collapses into pass (spec §7.3). */
export const Verdict = z.enum(["pass", "fail", "unknown", "not_applicable"]);
export type Verdict = z.infer<typeof Verdict>;

/** Stable error codes (spec §16.4). */
export const ArchitectErrorCode = z.enum([
  "MISSING_INPUT",
  "NO_FEASIBLE_CANDIDATE",
  "UNVERIFIED_COMPATIBILITY",
  "STALE_ENVIRONMENT",
  "APPROVAL_REQUIRED",
  "APPROVAL_INVALIDATED",
  "DEPENDENCY_UNAVAILABLE",
  "RESOURCE_BUSY",
  "RESOURCE_ESTIMATE_UNKNOWN",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "BUDGET_EXCEEDED",
  "GRAPH_CONFLICT",
  "OUTCOME_UNKNOWN",
]);
export type ArchitectErrorCode = z.infer<typeof ArchitectErrorCode>;

const SchemaVersion = z.literal(ARCHITECT_SCHEMA_VERSION);
/** ISO 8601 timestamp with offset, as `Date.toISOString()` writes it. */
const Timestamp = z.string().datetime({ offset: true });
/** Record identifiers: a short prefix, a dash, then letters, digits, dashes or dots. */
const RecordId = z.string().regex(/^[a-z][a-z0-9]*-[A-Za-z0-9.-]+$/, "expected <prefix>-<id>");

// ---------------------------------------------------------------------------------------
// Environment (spec §7.1, §8.3)

/** A probe that could not answer. Its absence of data is unknown, not empty (#796). */
export const ProbeError = z
  .object({
    probe: z.string(),
    message: z.string(),
  })
  .strict();
export type ProbeError = z.infer<typeof ProbeError>;

/** One compute device as ComfyUI reports it. Memory in bytes; absent when not reported. */
export const DeviceSnapshot = z
  .object({
    name: z.string(),
    type: z.string(),
    memoryTotal: z.number().nonnegative().optional(),
    memoryFree: z.number().nonnegative().optional(),
  })
  .strict();

/**
 * Installed model files by ComfyUI model folder (`checkpoints`, `diffusion_models`, …), as
 * the target reported them. `folders` holds only folders that answered, so an empty list
 * there is a verified fact; a folder in `unanswered` is unknown, never empty (#796).
 */
export const InstalledModels = z
  .object({
    folders: z.record(z.string(), z.array(z.string())),
    unanswered: z.array(z.object({ folder: z.string(), reason: z.string() }).strict()),
    /** Folders the target doesn't register at all (it answered 404): a definite answer. */
    absent: z.array(z.string()),
  })
  .strict();
export type InstalledModels = z.infer<typeof InstalledModels>;

/**
 * What the connected target is, at one moment (spec §7.1, `EnvironmentSnapshot`). Fields a
 * probe could not read stay absent and the probe is listed in `probeErrors`; consumers
 * treat an absent field as unknown.
 */
export const EnvironmentSnapshot = z
  .object({
    schemaVersion: SchemaVersion,
    id: RecordId,
    capturedAt: Timestamp,
    target: z.object({ baseUrl: z.string() }).strict(),
    comfyuiVersion: z.string().optional(),
    pythonVersion: z.string().optional(),
    os: z.string().optional(),
    ramTotal: z.number().nonnegative().optional(),
    ramFree: z.number().nonnegative().optional(),
    devices: z.array(DeviceSnapshot).optional(),
    nodeClassCount: z.number().int().nonnegative().optional(),
    /** sha256 over the sorted node class names; changes when installed nodes change. */
    nodeSchemaDigest: z.string().optional(),
    installedModels: InstalledModels.optional(),
    probeErrors: z.array(ProbeError),
  })
  .strict();
export type EnvironmentSnapshot = z.infer<typeof EnvironmentSnapshot>;

// ---------------------------------------------------------------------------------------
// TaskSpec (spec §7.1, §7.2, §7.3)

/** Image operations the MVP certifies (spec §2.2). */
export const ImageOperation = z.enum([
  "text_to_image",
  "image_edit",
  "inpaint",
  "reference_guided",
  "upscale",
]);
export type ImageOperation = z.infer<typeof ImageOperation>;

/** The image-specific part of a task: what to make and in which shape. */
export const ImageTaskPart = z
  .object({
    kind: z.literal("image"),
    operation: ImageOperation,
    output: z
      .object({
        width: z.number().int().positive().max(16384),
        height: z.number().int().positive().max(16384),
        count: z.number().int().positive().max(64).default(1),
        format: z.enum(["png", "jpeg", "webp"]).default("png"),
      })
      .strict(),
  })
  .strict();

/** The kind-specific part. Video, audio and 3D add members here (ROAD phase 6). */
export const TaskMedia = z.discriminatedUnion("kind", [ImageTaskPart]);
export type TaskMedia = z.infer<typeof TaskMedia>;

/** Three-way permission used by operational constraints. */
const Permission = z.enum(["forbidden", "approval_required", "allowed"]);

/** Operational constraints: apply before or during execution (spec §7.3). */
export const TaskConstraints = z
  .object({
    renderLocation: z.enum(["local", "remote_allowed"]).default("local"),
    remoteReasoning: z.enum(["forbidden", "allowed"]).default("forbidden"),
    /** Whether input or output media may leave the machine (the spec's image disclosure). */
    remoteMediaDisclosure: z.enum(["forbidden", "allowed"]).default("forbidden"),
    newCustomNodes: Permission.default("approval_required"),
    modelDownloads: Permission.default("approval_required"),
    paidRenderNodes: Permission.default("forbidden"),
  })
  .strict();

/** Acceptance requirements: apply to outputs and can't all be decided while planning. */
export const AcceptanceCriterion = z.discriminatedUnion("kind", [
  z
    .object({
      id: z.string().min(1),
      kind: z.literal("dimensions"),
      required: z.boolean(),
      expected: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      kind: z.literal("protected_region_exact"),
      required: z.boolean(),
      sourceAssetId: z.string().min(1),
      maskAssetId: z.string().min(1),
      coordinateSpace: z.literal("source_pixels"),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      kind: z.literal("user_review"),
      required: z.boolean(),
      rubric: z.string().min(1),
    })
    .strict(),
]);
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

export const TaskInput = z
  .object({
    assetId: z.string().min(1),
    role: z.enum(["source_image", "reference_image", "mask", "protected_region"]),
  })
  .strict();

export const TaskBudgets = z
  .object({
    maxPreviewRuns: z.number().int().nonnegative().optional(),
    maxFinalRuns: z.number().int().nonnegative().optional(),
    maxRepairRounds: z.number().int().nonnegative().optional(),
    maxDownloadBytes: z.number().int().nonnegative().optional(),
    maxWallTimeSeconds: z.number().int().nonnegative().optional(),
    maxApiSpendUsd: z.number().nonnegative().optional(),
  })
  .strict();

/** What a caller supplies to `architect_plan prepare`; the service adds identity and time. */
export const TaskSpecInput = z
  .object({
    intent: z.string().min(1).max(4000),
    media: TaskMedia,
    inputs: z.array(TaskInput).max(16).default([]),
    constraints: TaskConstraints.default({
      renderLocation: "local",
      remoteReasoning: "forbidden",
      remoteMediaDisclosure: "forbidden",
      newCustomNodes: "approval_required",
      modelDownloads: "approval_required",
      paidRenderNodes: "forbidden",
    }),
    acceptance: z.array(AcceptanceCriterion).max(32).default([]),
    /** Relative weights for ranking, each 0–1; stored with the ranking, never a score. */
    preferences: z.record(z.string(), z.number().min(0).max(1)).default({}),
    budgets: TaskBudgets.default({}),
    policyProfile: z.string().min(1).default("local-private"),
  })
  .strict();
export type TaskSpecInput = z.input<typeof TaskSpecInput>;

/** A stored task revision (spec §7.1, `TaskSpec`). */
export const TaskSpec = TaskSpecInput.extend({
  schemaVersion: SchemaVersion,
  id: RecordId,
  revision: z.number().int().positive(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}).strict();
export type TaskSpec = z.infer<typeof TaskSpec>;

// ---------------------------------------------------------------------------------------
// Graphs

/** A link in ComfyUI's API format: `[sourceNodeId, outputIndex]`. */
export const GraphLink = z.tuple([z.string().min(1), z.number().int().nonnegative()]);

/** One node of an API-format graph. Input values are literals or links. */
export const ApiNode = z
  .object({
    class_type: z.string().min(1),
    inputs: z.record(z.string(), z.union([GraphLink, z.string(), z.number(), z.boolean(), z.null()])),
    _meta: z.object({ title: z.string().optional() }).passthrough().optional(),
  })
  .strict();

/** ComfyUI's API-format graph, the execution authority (spec §10.4). */
export const ApiGraph = z.record(z.string().min(1), ApiNode);
export type ApiGraph = z.infer<typeof ApiGraph>;

// ---------------------------------------------------------------------------------------
// Recipe (spec §7.1, §8)

/** Where a slot's value comes from. `task` slots are filled from TaskSpec fields. */
export const RecipeSlot = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    label: z.string().min(1),
    valueType: z.enum(["model_file", "string", "int", "float", "seed", "enum"]),
    /** The node input this slot writes. */
    target: z.object({ node: z.string().min(1), input: z.string().min(1) }).strict(),
    required: z.boolean(),
    default: z.union([z.string(), z.number()]).optional(),
    /** A TaskSpec path the service fills the slot from, e.g. `media.output.width`. */
    fromTask: z.string().optional(),
    /** For `model_file`: the ComfyUI model folder the file must be installed in. */
    modelFolder: z.string().optional(),
    /** For `model_file`: the model family the recipe was annotated for (semantic layer). */
    modelFamily: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    choices: z.array(z.string()).optional(),
  })
  .strict()
  .refine((s) => s.valueType !== "model_file" || s.modelFolder !== undefined, {
    message: "a model_file slot names its modelFolder",
  });
export type RecipeSlot = z.infer<typeof RecipeSlot>;

/** How far a recipe is trusted (spec §8.2, §2.2). */
export const Certification = z.enum([
  /** Test data only; never shipped in `architect/recipes/`. */
  "fixture",
  /** Annotated and reviewed by a maintainer, not yet run on a recorded matrix. */
  "curated",
  /** Passed its graph-contract and run tests on a recorded matrix (AT-03). */
  "certified",
]);

export const EvidenceRef = z
  .object({
    kind: z.enum(["maintainer_review", "run", "documentation", "upstream_pack"]),
    source: z.string().min(1),
    observedAt: Timestamp,
    note: z.string().optional(),
  })
  .strict();

export const Recipe = z
  .object({
    schemaVersion: SchemaVersion,
    id: RecordId,
    revision: z.number().int().positive(),
    title: z.string().min(1),
    description: z.string().default(""),
    kind: WorkflowKind,
    /** Operations of the kind this recipe solves; checked against the kind in `refine`. */
    operations: z.array(z.string().min(1)).min(1),
    graph: ApiGraph,
    slots: z.array(RecipeSlot),
    /** Output nodes and the role each plays, so a compiled graph maps roles to node IDs. */
    outputs: z.array(z.object({ role: z.string().min(1), node: z.string().min(1) }).strict()).min(1),
    dependencies: z.object({ nodeClasses: z.array(z.string().min(1)) }).strict(),
    certification: Certification,
    evidence: z.array(EvidenceRef),
    license: z.string().optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.kind === "image") {
      for (const op of r.operations) {
        if (!ImageOperation.safeParse(op).success) {
          ctx.addIssue({ code: "custom", message: `unknown image operation "${op}"`, path: ["operations"] });
        }
      }
    }
    for (const s of r.slots) {
      if (!(s.target.node in r.graph)) {
        ctx.addIssue({ code: "custom", message: `slot ${s.id} targets missing node ${s.target.node}`, path: ["slots"] });
      }
    }
    for (const o of r.outputs) {
      if (!(o.node in r.graph)) {
        ctx.addIssue({ code: "custom", message: `output ${o.role} names missing node ${o.node}`, path: ["outputs"] });
      }
    }
  });
export type Recipe = z.infer<typeof Recipe>;

// ---------------------------------------------------------------------------------------
// Validation (spec §10.3)

export const ValidationLayer = z.enum([
  "contract",
  "structure",
  "native_types",
  "semantic_types",
  "dependencies",
  "policy",
  "runtime",
]);
export type ValidationLayer = z.infer<typeof ValidationLayer>;

/** One check. `hard` checks block: a hard fail rejects, a hard unknown blocks automatic action. */
export const CheckResult = z
  .object({
    id: z.string().min(1),
    layer: ValidationLayer,
    verdict: Verdict,
    hard: z.boolean(),
    message: z.string(),
    /** The component that decided, e.g. `validator.structure` or `policy.local-private`. */
    enforcedBy: z.string().min(1),
    nodeId: z.string().optional(),
  })
  .strict();
export type CheckResult = z.infer<typeof CheckResult>;

/** `overall`: fail if any hard check fails, else unknown if any hard check is unknown, else pass. */
export const ValidationReport = z
  .object({
    checks: z.array(CheckResult),
    overall: z.enum(["pass", "fail", "unknown"]),
  })
  .strict();
export type ValidationReport = z.infer<typeof ValidationReport>;

// ---------------------------------------------------------------------------------------
// Planning (spec §7.1, §9, §15.3)

export const PlanCandidate = z
  .object({
    schemaVersion: SchemaVersion,
    id: RecordId,
    planId: RecordId,
    taskId: RecordId,
    taskRevision: z.number().int().positive(),
    recipeId: RecordId,
    recipeRevision: z.number().int().positive(),
    environmentId: RecordId,
    /** Slot ID to value. Model files must be ones the snapshot lists (spec §9.2). */
    bindings: z.record(z.string(), z.union([z.string(), z.number()])),
    /** Allowlisted graph transformations (spec §9.2 step 3). None are allowlisted in milestone 2. */
    transforms: z.array(z.object({ kind: z.string().min(1) }).strict()),
    /** sha256 of the canonical compiled API graph (spec §10.5); absent when compilation failed. */
    graphFingerprint: z.string().optional(),
    /** Recipe role or slot ID to node ID in the compiled graph (spec §10.2). */
    roleMap: z.record(z.string(), z.string()),
    validation: ValidationReport,
    dependencyDelta: z
      .object({
        missingModels: z.array(z.object({ slot: z.string(), folder: z.string(), file: z.string() }).strict()),
        missingNodeClasses: z.array(z.string()),
      })
      .strict(),
    /** No measured profile exists yet, so estimates stay unknown rather than invented (spec §9.3). */
    resourceEstimate: z.object({ status: z.literal("unknown"), reason: z.string() }).strict(),
    ranking: z
      .object({
        /** Ordered evidence tier, best first: certified, curated, fixture. */
        tier: Certification,
        explanation: z.string(),
      })
      .strict(),
    status: z.enum(["feasible", "blocked", "diagnostic"]),
    createdAt: Timestamp,
  })
  .strict();
export type PlanCandidate = z.infer<typeof PlanCandidate>;

/** Planning states (spec §15.3). `PLANNING` is transient while `propose` runs. */
export const PlanState = z.enum(["DRAFT", "NEEDS_INPUT", "PLANNING", "PROPOSED", "BLOCKED", "SELECTED", "SUPERSEDED"]);
export type PlanState = z.infer<typeof PlanState>;

/** Blockers grouped as spec §9.5 asks, each a human-readable reason. */
export const PlanBlockers = z
  .object({
    missing_dependencies: z.array(z.string()),
    unsupported_operation: z.array(z.string()),
    insufficient_evidence: z.array(z.string()),
    resource_limits: z.array(z.string()),
    policy_conflicts: z.array(z.string()),
  })
  .strict();
export type PlanBlockers = z.infer<typeof PlanBlockers>;

export const Plan = z
  .object({
    schemaVersion: SchemaVersion,
    id: RecordId,
    taskId: RecordId,
    taskRevision: z.number().int().positive(),
    environmentId: RecordId,
    state: PlanState,
    candidateIds: z.array(RecordId),
    selectedCandidateId: RecordId.optional(),
    blockers: PlanBlockers,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict();
export type Plan = z.infer<typeof Plan>;

// ---------------------------------------------------------------------------------------
// Result envelope (spec §16.2)

export const ResultEnvelope = z
  .object({
    schemaVersion: SchemaVersion,
    operationId: z.string(),
    status: z.enum(["ok", "partial", "error"]),
    summary: z.string(),
    data: z.record(z.string(), z.unknown()),
    warnings: z.array(z.string()),
    artifacts: z.array(z.string()),
    error: z
      .object({
        code: ArchitectErrorCode,
        retryable: z.boolean(),
        nextStep: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ResultEnvelope = z.infer<typeof ResultEnvelope>;

// ---------------------------------------------------------------------------------------
// Reading stored records back (spec §7: migration support)

const STORED = {
  task: TaskSpec,
  environment: EnvironmentSnapshot,
  recipe: Recipe,
  plan: Plan,
  candidate: PlanCandidate,
} as const;
export type StoredKind = keyof typeof STORED;
type StoredRecord<K extends StoredKind> = z.infer<(typeof STORED)[K]>;

/** Upgrade steps per record kind, keyed by the version they upgrade FROM. None exist yet. */
const UPGRADES: { [K in StoredKind]: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> } = {
  task: {},
  environment: {},
  recipe: {},
  plan: {},
  candidate: {},
};

export class StoredRecordError extends Error {
  constructor(
    readonly kind: StoredKind,
    message: string,
  ) {
    super(`${kind}: ${message}`);
    this.name = "StoredRecordError";
  }
}

/**
 * Parse a stored record of any supported version: upgrade it step by step to the current
 * `schemaVersion`, then validate strictly. A record from a NEWER version than this build is
 * refused, never truncated to what this build understands.
 */
export function parseStored<K extends StoredKind>(kind: K, raw: unknown): StoredRecord<K> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new StoredRecordError(kind, "not an object");
  }
  let rec = { ...(raw as Record<string, unknown>) };
  let version = rec.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new StoredRecordError(kind, "missing or invalid schemaVersion");
  }
  if (version > ARCHITECT_SCHEMA_VERSION) {
    throw new StoredRecordError(kind, `schemaVersion ${version} is newer than this build (${ARCHITECT_SCHEMA_VERSION})`);
  }
  while (version < ARCHITECT_SCHEMA_VERSION) {
    const step = UPGRADES[kind][version];
    if (!step) throw new StoredRecordError(kind, `no upgrade from schemaVersion ${version}`);
    rec = step(rec);
    version += 1;
    rec.schemaVersion = version;
  }
  const parsed = STORED[kind].safeParse(rec);
  if (!parsed.success) throw new StoredRecordError(kind, parsed.error.message);
  return parsed.data as StoredRecord<K>;
}
