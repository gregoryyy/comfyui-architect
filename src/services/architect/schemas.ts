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

import { isAbsolute } from "node:path";
import { z } from "zod";
import { ARCHITECT_SCHEMA_VERSION } from "../../fork-identity.js";
import { canonicalJson, sha256Hex } from "./hash.js";

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
  /** ComfyUI accepted the job and reported it failed, or refused it with an answer (spec §15.4). */
  "EXECUTION_FAILED",
  /** An error the service didn't anticipate; spec §16.4's list isn't exhaustive ("include"). */
  "INTERNAL_ERROR",
]);
export type ArchitectErrorCode = z.infer<typeof ArchitectErrorCode>;

const SchemaVersion = z.literal(ARCHITECT_SCHEMA_VERSION);
/** ISO 8601 timestamp with offset, as `Date.toISOString()` writes it. */
const Timestamp = z.string().datetime({ offset: true });
/** Record identifiers: a short prefix, a dash, then letters, digits, dashes or dots. */
const RecordId = z.string().regex(/^[a-z][a-z0-9]*-[A-Za-z0-9.-]+$/, "expected <prefix>-<id>");
/** A record identifier with a fixed prefix, so an id of one kind can't stand in for another. */
function prefixedId(prefix: string) {
  return RecordId.refine((id) => id.startsWith(`${prefix}-`), { message: `expected ${prefix}-<id>` });
}
/** A sha256 digest as `sha256Hex` writes it. */
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lowercase hex digits");
/** A non-negative byte count. */
const Bytes = z.number().int().nonnegative();
/** An absolute filesystem path, such as a model root or a staged file. */
const AbsolutePath = z.string().min(1).refine((p) => isAbsolute(p), { message: "expected an absolute path" });

// ---------------------------------------------------------------------------------------
// Model sources (spec §8.3, §9.2, §14.4; ARCH 2026-11-16, milestone 4; GAPS Q25)

/** A path inside a repository: relative, no `.`, `..` or empty segment, no backslash. */
const RepoPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.includes("\\") && p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".."), {
    message: "expected a relative path without '.', '..' or empty segments and without backslashes",
  });

/** A file name in a model folder: one segment, so a placement can't leave the folder (SEC T9). */
const BareFileName = z
  .string()
  .min(1)
  .refine((f) => !f.includes("/") && !f.includes("\\") && f !== "." && f !== "..", { message: "expected a bare file name" });

/** A ComfyUI model folder name such as `vae` or `upscale_models`: one segment. */
const ModelFolderName = z
  .string()
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/, "expected a model folder name")
  .refine((f) => f !== "..", { message: "expected a model folder name" });

/**
 * Where a model file comes from, pinned by a maintainer with scripts/architect/pin-source.mjs
 * (ARCH 2026-11-16, sources). Hugging Face only (GAPS Q25): a 40-digit commit, never a
 * branch, so the bytes behind the entry can't change; the sha256 and size Hugging Face
 * reported for that commit, which the download is checked against before placement. A
 * union, so a source the owner adds later is a new member.
 */
export const ModelSource = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("huggingface"),
      /** `owner/name` as the repository resolved when pinned (a renamed repository's new name). */
      repo: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/, "expected owner/name")
        .refine((r) => r.split("/").every((seg) => seg !== "." && seg !== ".."), { message: "expected owner/name" }),
      revision: z.string().regex(/^[0-9a-f]{40}$/, "expected a 40-digit lowercase commit, not a branch or tag"),
      path: RepoPath,
      sha256: Sha256,
      sizeBytes: z.number().int().positive(),
      license: z.string().min(1).optional(),
    })
    .strict(),
]);
export type ModelSource = z.infer<typeof ModelSource>;

/** A recipe's pinned source for one model file it can acquire: the folder and name it lands as. */
export const RecipeModelSource = z
  .object({
    folder: ModelFolderName,
    /** The name on disk; it may differ from the last segment of `source.path`. */
    file: BareFileName,
    source: ModelSource,
  })
  .strict();
export type RecipeModelSource = z.infer<typeof RecipeModelSource>;

/** No two entries for one folder and file, whatever else they carry. */
function uniqueFolderFile(entries: readonly { folder: string; file: string }[]): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const e of entries) {
    const key = `${e.folder}/${e.file}`;
    if (seen.has(key)) dupes.push(key);
    seen.add(key);
  }
  return dupes;
}

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
      /**
       * The largest difference per channel, 0 to 255, a protected pixel may show; absent is 0,
       * an exact match (ARCH 2026-11-16, protected regions).
       */
      tolerance: z.number().int().min(0).max(255).optional(),
    })
    .strict(),
  z
    .object({
      /**
       * Text the output image must show (TODO 6.4). Read by an optional evaluator, whose
       * verdict is advisory unless `acceptEvaluator` names it: the action plan then lists it as
       * accepted, the approval says its verdict counts, and the user's approval is the
       * acceptance spec §13.2 asks for (GAPS A11).
       */
      id: z.string().min(1),
      kind: z.literal("text_in_image"),
      required: z.boolean(),
      text: z.string().min(1).max(500),
      /** `contains`: the reading includes the text; `exact`: the reading is the text. */
      match: z.enum(["contains", "exact"]).default("contains"),
      caseSensitive: z.boolean().default(false),
      /** The evaluator whose verdict counts for this criterion, e.g. `architect.ocr-glm`. */
      acceptEvaluator: z.string().min(1).max(100).optional(),
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

/**
 * A task input (spec §7.2). `assetId` stays any non-empty string here, so a stored task
 * with an older or foreign form still parses; the contract layer decides whether a recipe
 * can take it (`parseAssetId`), and refuses every form but `comfyui-input:<name>` as
 * unsupported (GAPS Q33).
 */
export const TaskInput = z
  .object({
    assetId: z.string().min(1),
    role: z.enum(["source_image", "reference_image", "mask", "protected_region"]),
  })
  .strict();
export type TaskInput = z.infer<typeof TaskInput>;

/** The one asset form milestone 5 resolves: a file in the target ComfyUI's input folder (GAPS Q33). */
export const COMFYUI_INPUT_PREFIX = "comfyui-input:";

/**
 * Whether `name` can name a file inside ComfyUI's input folder: relative, `/` between
 * segments, no empty, `.` or `..` segment, no backslash, no drive letter and no control
 * character (NUL included). ComfyUI's `/view` checks containment itself; this check keeps
 * a name that tries to leave the folder from reaching it, a grant or a record (SEC T9).
 */
export function inputNameProblem(name: string): string | undefined {
  if (name.length === 0) return "the name is empty";
  if (name.length > 1024) return "the name is longer than 1024 characters";
  if (/[\u0000-\u001f\u007f]/.test(name)) return "the name contains a control character";
  if (name.includes("\\")) return "the name contains a backslash; use / between folders";
  if (name.startsWith("/")) return "the name is absolute; give it relative to ComfyUI's input folder";
  if (/^[A-Za-z]:/.test(name)) return "the name starts with a drive letter";
  const segments = name.split("/");
  if (segments.some((s) => s === "..")) return "the name has a '..' segment";
  if (segments.some((s) => s === "" || s === ".")) return "the name has an empty or '.' segment";
  return undefined;
}

/** A task asset resolved to what it names, or why it can't be. */
export type ParsedAssetId = { ok: true; kind: "comfyui_input"; name: string } | { ok: false; problem: string };

/** Read a task input's `assetId` (GAPS Q33): `comfyui-input:<name>` and nothing else. */
export function parseAssetId(assetId: string): ParsedAssetId {
  if (!assetId.startsWith(COMFYUI_INPUT_PREFIX)) {
    return {
      ok: false,
      problem: `asset id ${JSON.stringify(assetId)} isn't supported: only ${COMFYUI_INPUT_PREFIX}<name>, a file in the target ComfyUI's input folder, is`,
    };
  }
  const name = assetId.slice(COMFYUI_INPUT_PREFIX.length);
  const problem = inputNameProblem(name);
  return problem === undefined ? { ok: true, kind: "comfyui_input", name } : { ok: false, problem: `asset id ${JSON.stringify(assetId)}: ${problem}` };
}

/** An `assetId` that `parseAssetId` accepts. */
const InputAssetId = z.string().superRefine((id, ctx) => {
  const parsed = parseAssetId(id);
  if (!parsed.ok) ctx.addIssue({ code: "custom", message: parsed.problem });
});

/**
 * The `fromTask` paths of an `input_image` slot: the task's source image, its mask, or its
 * n-th reference image counted from 1 in task order.
 */
export const INPUT_IMAGE_PATH = /^inputs\.(?:source_image|mask|reference_image\.[1-9][0-9]*)$/;

/**
 * The `fromTask` path each task input answers to, in task order: `inputs.source_image` and
 * `inputs.mask` for the first of their role, `inputs.reference_image.<n>` for each reference
 * image, and `inputs.<role>.<n>` for a second source image or mask and for protected
 * regions, which no slot path names, so they fail as unsupported (GAPS Q16).
 */
export function taskInputPaths(inputs: readonly TaskInput[]): { path: string; input: TaskInput }[] {
  const seen = new Map<TaskInput["role"], number>();
  return inputs.map((input) => {
    const n = (seen.get(input.role) ?? 0) + 1;
    seen.set(input.role, n);
    const single = input.role === "source_image" || input.role === "mask";
    return { path: single && n === 1 ? `inputs.${input.role}` : `inputs.${input.role}.${n}`, input };
  });
}

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
    /**
     * `input_image`: a file in the target's input folder, taken from the task's inputs by
     * `fromTask` (GAPS Q33); the slot writes the file's name, as ComfyUI's image loaders take it.
     */
    valueType: z.enum(["model_file", "string", "int", "float", "seed", "enum", "input_image"]),
    /** The node input this slot writes. */
    target: z.object({ node: z.string().min(1), input: z.string().min(1) }).strict(),
    required: z.boolean(),
    default: z.union([z.string(), z.number()]).optional(),
    /** A TaskSpec path the service fills the slot from, e.g. `media.output.width`. */
    fromTask: z.string().optional(),
    /**
     * Divide the `fromTask` value by this before writing it, for a graph that generates at a
     * fraction of the task's size and scales back up (a 2x upscale recipe). The recipe's
     * graph is what restores the size; a task value the divisor doesn't divide fails.
     */
    fromTaskDivisor: z.number().int().min(2).optional(),
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
  })
  .refine((s) => s.fromTaskDivisor === undefined || s.fromTask !== undefined, {
    message: "fromTaskDivisor needs fromTask",
    path: ["fromTaskDivisor"],
  })
  // An input image comes from the task only: a default or a binding would put a file in the
  // graph that the task, and so the approval, doesn't name (GAPS Q33).
  .refine((s) => s.valueType !== "input_image" || (s.fromTask !== undefined && INPUT_IMAGE_PATH.test(s.fromTask)), {
    message: "an input_image slot takes fromTask inputs.source_image, inputs.mask or inputs.reference_image.<n>",
    path: ["fromTask"],
  })
  .refine((s) => s.valueType !== "input_image" || (s.default === undefined && s.fromTaskDivisor === undefined), {
    message: "an input_image slot has no default and no fromTaskDivisor",
    path: ["default"],
  })
  .refine((s) => s.fromTask === undefined || !s.fromTask.startsWith("inputs.") || s.valueType === "input_image", {
    message: "only an input_image slot takes a task input",
    path: ["valueType"],
  });
export type RecipeSlot = z.infer<typeof RecipeSlot>;

/** How far a recipe is trusted (spec §8.2, §2.2). */
export const Certification = z.enum([
  /** Test data only; never shipped in `architect/recipes/`. */
  "fixture",
  /** Annotated and reviewed by a maintainer, not yet run on a recorded matrix. */
  "curated",
  /** Written or annotated by an agent, not yet reviewed: spec §8.4 forbids self-certifying. */
  "proposed",
  /** Passed its graph-contract and run tests on a recorded matrix (AT-03). */
  "certified",
]);

/**
 * An output size taken from an input image (ARCH 2026-11-16, output size): the input's
 * width and height times `factor` (1 for an edit that keeps the size, 4 for a 4x upscale).
 * `multipleOf` says the graph rounds each side down to that multiple (a VAE encode crops
 * to its downscale factor), so an input whose product isn't one fails rather than coming
 * out a few pixels short.
 */
export const OutputScaleOfInput = z
  .object({
    input: z.string().regex(INPUT_IMAGE_PATH),
    factor: z.number().positive().max(16),
    multipleOf: z.number().int().min(2).max(64).optional(),
  })
  .strict();
export type OutputScaleOfInput = z.infer<typeof OutputScaleOfInput>;

export const EvidenceRef = z
  .object({
    kind: z.enum(["maintainer_review", "run", "documentation", "upstream_pack"]),
    source: z.string().min(1),
    observedAt: Timestamp,
    note: z.string().optional(),
    /**
     * The recipe revision this evidence is about. A maintainer review covers the revision it
     * looked at, so a recipe changed afterwards is `proposed` again until it's reviewed anew.
     */
    revision: z.number().int().positive().optional(),
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
    /**
     * Output nodes and the role each plays, so a compiled graph maps roles to node IDs.
     * `format` and `count` say what one run writes for the role, so the contract layer can
     * tell a task asking for something else apart from one the recipe serves (GAPS Q16);
     * left out, that comparison is unknown.
     */
    outputs: z
      .array(
        z
          .object({
            role: z.string().min(1),
            node: z.string().min(1),
            format: z.string().min(1).optional(),
            count: z.number().int().positive().optional(),
            /**
             * The output's size is an input image's size times `factor` (ARCH 2026-11-16,
             * output size), so the task's width and height are compared with the input's
             * dimensions read from the target; the recipe then takes no size from the task.
             */
            scaleOfInput: OutputScaleOfInput.optional(),
            /**
             * The graph scales this input image to the task's width and height; a different
             * aspect ratio stretches it, which a soft check reports before selection.
             */
            scalesInputToTask: z.string().regex(INPUT_IMAGE_PATH).optional(),
            /**
             * For an output sized from the task: the graph writes each side rounded down to
             * this multiple (the step of its latent node), so a task side off it fails
             * rather than coming out a few pixels short.
             */
            multipleOf: z.number().int().min(2).max(64).optional(),
          })
          .strict(),
      )
      .min(1),
    dependencies: z.object({ nodeClasses: z.array(z.string().min(1)) }).strict(),
    /**
     * Pinned sources of the model files this recipe can acquire (ARCH 2026-11-16, sources).
     * Optional rather than defaulted: a default would change the parsed content, and so the
     * content hash, of every recipe already stored under its revision.
     */
    modelSources: z.array(RecipeModelSource).optional(),
    certification: Certification,
    evidence: z.array(EvidenceRef),
    license: z.string().optional(),
    /**
     * What the result does that the task doesn't say and a user might not expect (a refining
     * pass that changes content): shown with the candidate and in the approval, so it is
     * disclosed before the user selects or approves (spec §4.3). Optional, so recipes without
     * notices keep their content hash.
     */
    notices: z.array(z.string().min(1).max(500)).max(5).optional(),
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
    for (const key of uniqueFolderFile(r.modelSources ?? [])) {
      ctx.addIssue({ code: "custom", message: `modelSources lists ${key} twice`, path: ["modelSources"] });
    }
    outputSizeIssues(r, (message) => ctx.addIssue({ code: "custom", message, path: ["outputs"] }));
  });
export type Recipe = z.infer<typeof Recipe>;

/**
 * Whether an output's size declaration fits the recipe: the input it names is one an
 * `input_image` slot takes, and a size from an input excludes a size from the task, since
 * the two would have to agree and nothing would make them.
 */
function outputSizeIssues(
  r: { outputs: readonly { role: string; scaleOfInput?: { input: string }; scalesInputToTask?: string; multipleOf?: number }[]; slots: readonly RecipeSlot[] },
  issue: (message: string) => void,
): void {
  const takes = (path: string) => r.slots.some((s) => s.valueType === "input_image" && s.fromTask === path);
  const sizedFromTask = r.slots.some((s) => s.fromTask === "media.output.width" || s.fromTask === "media.output.height");
  for (const o of r.outputs) {
    if (o.scaleOfInput) {
      if (!takes(o.scaleOfInput.input)) issue(`output ${o.role}: scaleOfInput names ${o.scaleOfInput.input}, which no input_image slot takes`);
      if (sizedFromTask) issue(`output ${o.role}: scaleOfInput sizes the output from an input, but a slot also takes the size from the task`);
      if (o.scalesInputToTask !== undefined) issue(`output ${o.role}: scaleOfInput and scalesInputToTask exclude each other`);
      if (o.multipleOf !== undefined) issue(`output ${o.role}: multipleOf is for a size from the task; scaleOfInput carries its own`);
    }
    if (o.scalesInputToTask !== undefined) {
      if (!takes(o.scalesInputToTask)) issue(`output ${o.role}: scalesInputToTask names ${o.scalesInputToTask}, which no input_image slot takes`);
      const both = ["media.output.width", "media.output.height"].every((p) => r.slots.some((s) => s.fromTask === p));
      if (!both) issue(`output ${o.role}: scalesInputToTask needs slots that take width and height from the task`);
    }
  }
}

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

/**
 * What an `acquirable` candidate would download (ARCH 2026-11-16, candidates): each missing
 * model file with the recipe's pinned source, and the total the approval is asked for.
 */
export const CandidateAcquisition = z
  .object({
    files: z
      .array(z.object({ slot: z.string().min(1), folder: ModelFolderName, file: BareFileName, source: ModelSource }).strict())
      .min(1),
    totalBytes: Bytes,
  })
  .strict()
  .superRefine((a, ctx) => {
    for (const key of uniqueFolderFile(a.files)) {
      ctx.addIssue({ code: "custom", message: `the acquisition lists ${key} twice`, path: ["files"] });
    }
    if (a.totalBytes !== a.files.reduce((sum, f) => sum + f.source.sizeBytes, 0)) {
      ctx.addIssue({ code: "custom", message: "totalBytes is not the sum of the files' sizes", path: ["totalBytes"] });
    }
  });
export type CandidateAcquisition = z.infer<typeof CandidateAcquisition>;

/**
 * Candidate statuses, best first. `acquirable`: the only failing hard checks are model files
 * the recipe pins a source for and the acquisition policy accepts; the checks stay `fail`
 * until the files are placed (ARCH 2026-11-16, candidates).
 */
export const CandidateStatus = z.enum(["feasible", "acquirable", "diagnostic", "blocked"]);
export type CandidateStatus = z.infer<typeof CandidateStatus>;

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
        /** Ordered evidence tier, best first: certified, curated, proposed, fixture. */
        tier: Certification,
        explanation: z.string(),
      })
      .strict(),
    status: CandidateStatus,
    /** Present exactly when `status` is `acquirable`. */
    acquisition: CandidateAcquisition.optional(),
    createdAt: Timestamp,
  })
  .strict()
  .superRefine((c, ctx) => {
    if ((c.status === "acquirable") !== (c.acquisition !== undefined)) {
      ctx.addIssue({ code: "custom", message: "acquisition is set exactly when the status is acquirable", path: ["acquisition"] });
    }
  });
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
// Execution: action plans, approval, runs (spec §7.1, §14.2, §15.3, §15.4; ARCH milestone 3)

/** The ComfyUI a run is submitted to. A URL, unlike the snapshot's target, because effects go there. */
const ExecutionTarget = z.object({ baseUrl: z.string().url() }).strict();

/** Run limits an action plan asks for and a grant allows; a grant never exceeds its plan's. */
export const RunLimits = z
  .object({
    maxRuns: z.number().int().min(1),
    maxWallTimeSeconds: z.number().int().positive(),
  })
  .strict();
export type RunLimits = z.infer<typeof RunLimits>;

/**
 * One effect an action plan would have. Kind-neutral: a render of any workflow kind is a
 * `local_render` of a compiled graph. Downloads and installs add members in their milestone.
 */
export const Effect = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("local_render"),
      /** The compiled graph's fingerprint (spec §10.5), so the grant names the exact graph. */
      graphFingerprint: Sha256,
      outputNodes: z.array(z.string().min(1)).min(1),
      /**
       * The task's input files as read from the target when the plan was prepared, so the
       * grant binds their content and not only their names (spec §14.2; GAPS Q33). Absent
       * for a task without inputs, which keeps the hash of such a plan as it was.
       */
      inputs: z
        .array(z.object({ assetId: InputAssetId, sha256: Sha256, sizeBytes: Bytes }).strict())
        .min(1)
        .refine((xs) => new Set(xs.map((x) => x.assetId)).size === xs.length, { message: "an input is listed twice" })
        .optional(),
      /**
       * Optional evaluators the task accepts for a criterion, so their verdicts count toward
       * acceptance (spec §13.2; GAPS A11). The hash covers each evaluator's version, so a new
       * version needs a new approval. Absent when the task accepts none, which keeps the hash
       * of such a plan as it was.
       */
      acceptedEvaluators: z
        .array(z.object({ criterionId: z.string().min(1), evaluatorId: z.string().min(1), evaluatorVersion: z.string().min(1) }).strict())
        .min(1)
        .refine((xs) => new Set(xs.map((x) => x.criterionId)).size === xs.length, { message: "a criterion is listed twice" })
        .optional(),
    })
    .strict(),
  z
    .object({
      /**
       * Unload these models from a local Ollama before the render and load them back after
       * it (spec §11.3; GAPS Q23). Listed only with ARCHITECT_MANAGE_RESIDENCY=1, from what
       * Ollama held in the pool when the plan was prepared, so the user approves each one.
       * A model not listed here is never unloaded.
       */
      kind: z.literal("release_residency"),
      host: z.string().url(),
      models: z
        .array(
          z
            .object({
              name: z.string().min(1),
              /** Memory Ollama reported for it (`size_vram`), in bytes. */
              sizeBytes: z.number().int().min(0),
            })
            .strict(),
        )
        .min(1),
      reload: z.literal(true),
    })
    .strict(),
  z
    .object({
      /**
       * Download these model files from their pinned sources into the target's model folders
       * before the render (ARCH 2026-11-16, placement; GAPS Q25). Each file is staged next to
       * its destination as `<file>.architect-<run id>`, a name no loader lists, checked against `source.sha256` and
       * `sizeBytes`, and only then placed as `<destinationRoot>/<folder>/<file>`, never over
       * an existing file. `maxBytes` is the bound the approval names (at most 40 GB);
       * `minFreeBytes` the free disk that must remain after each file (50 GB). The hash of
       * the action plan covers all of it, so the grant names each file and its commit.
       */
      kind: z.literal("acquire_models"),
      files: z
        .array(z.object({ folder: ModelFolderName, file: BareFileName, source: ModelSource, destinationRoot: AbsolutePath }).strict())
        .min(1),
      totalBytes: Bytes,
      maxBytes: Bytes,
      minFreeBytes: Bytes,
    })
    .strict()
    .superRefine((e, ctx) => {
      for (const key of uniqueFolderFile(e.files)) {
        ctx.addIssue({ code: "custom", message: `the effect lists ${key} twice`, path: ["files"] });
      }
      if (e.totalBytes !== e.files.reduce((sum, f) => sum + f.source.sizeBytes, 0)) {
        ctx.addIssue({ code: "custom", message: "totalBytes is not the sum of the files' sizes", path: ["totalBytes"] });
      }
      if (e.totalBytes > e.maxBytes) {
        ctx.addIssue({ code: "custom", message: "totalBytes exceeds maxBytes", path: ["totalBytes"] });
      }
    }),
]);
export type Effect = z.infer<typeof Effect>;
export type LocalRenderEffect = Extract<Effect, { kind: "local_render" }>;
export type RenderInput = NonNullable<LocalRenderEffect["inputs"]>[number];
export type AcceptedEvaluator = NonNullable<LocalRenderEffect["acceptedEvaluators"]>[number];
export type ReleaseResidencyEffect = Extract<Effect, { kind: "release_residency" }>;
export type AcquireModelsEffect = Extract<Effect, { kind: "acquire_models" }>;

const ActionPlanObject = z
  .object({
    schemaVersion: SchemaVersion,
    id: prefixedId("actions"),
    planId: RecordId,
    taskId: RecordId,
    taskRevision: z.number().int().min(1),
    candidateId: RecordId,
    environmentId: RecordId,
    target: ExecutionTarget,
    effects: z.array(Effect).min(1),
    budgets: RunLimits,
    createdAt: Timestamp,
    expiresAt: Timestamp,
    /** `actionPlanHash` of this plan; what an approval request and a grant bind to. */
    hash: Sha256,
  })
  .strict();

/** The fields an action plan's hash covers. */
export type ActionPlanBinding = Pick<
  z.infer<typeof ActionPlanObject>,
  "planId" | "taskId" | "taskRevision" | "candidateId" | "target" | "effects" | "budgets"
>;

/**
 * The hash a grant binds (spec §14.2): sha256 over canonical JSON of what runs where within
 * which limits. Left out on purpose: the action plan's own id and timestamps, so rebuilding
 * the same plan at start yields the same hash; `expiresAt`, which request and grant enforce
 * separately; and `environmentId`, because start validates again against a fresh snapshot
 * (ARCH milestone 3, action plans).
 */
export function actionPlanHash(p: ActionPlanBinding): string {
  return sha256Hex(
    canonicalJson({
      planId: p.planId,
      taskId: p.taskId,
      taskRevision: p.taskRevision,
      candidateId: p.candidateId,
      target: p.target,
      effects: p.effects,
      budgets: p.budgets,
    }),
  );
}

/** What `architect_run prepare` asks the user to approve (spec §7.1, `ActionPlan`). */
export const ActionPlan = ActionPlanObject.superRefine((p, ctx) => {
  // A stored hash that doesn't cover the stored content would let an edited plan run
  // under a grant issued for the original.
  if (p.hash !== actionPlanHash(p)) {
    ctx.addIssue({ code: "custom", message: "hash does not match the action plan's content", path: ["hash"] });
  }
  if (Date.parse(p.expiresAt) <= Date.parse(p.createdAt)) {
    ctx.addIssue({ code: "custom", message: "expiresAt must be after createdAt", path: ["expiresAt"] });
  }
});
export type ActionPlan = z.infer<typeof ActionPlan>;

/** How a grant or a user's verdict reached the service: never through a model-callable tool (spec §14.2). */
export const ApprovalChannel = z.enum(["elicitation", "terminal"]);
export type ApprovalChannel = z.infer<typeof ApprovalChannel>;

/** A request for the user's approval of one action plan, by hash. */
export const ApprovalRequest = z
  .object({
    schemaVersion: SchemaVersion,
    id: prefixedId("approval"),
    actionPlanId: prefixedId("actions"),
    actionPlanHash: Sha256,
    state: z.enum(["pending", "granted", "declined", "expired"]),
    createdAt: Timestamp,
    expiresAt: Timestamp,
    resolvedAt: Timestamp.optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if ((r.state === "pending") !== (r.resolvedAt === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "resolvedAt is set exactly when the request is resolved",
        path: ["resolvedAt"],
      });
    }
    if (Date.parse(r.expiresAt) <= Date.parse(r.createdAt)) {
      ctx.addIssue({ code: "custom", message: "expiresAt must be after createdAt", path: ["expiresAt"] });
    }
  });
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;
export type ApprovalRequestState = ApprovalRequest["state"];

/**
 * The user's approval of one action plan (spec §7.1, §14.2, `ApprovalGrant`). It binds the
 * plan's hash, target and limits, and starts at most one run: consuming it is part of the
 * transaction that creates the run (ARCH milestone 3).
 */
export const ApprovalGrant = z
  .object({
    schemaVersion: SchemaVersion,
    id: prefixedId("grant"),
    approvalRequestId: prefixedId("approval"),
    actionPlanId: prefixedId("actions"),
    actionPlanHash: Sha256,
    target: ExecutionTarget,
    limits: RunLimits,
    channel: ApprovalChannel,
    /** Who approved, as the channel identified them (the terminal user, the MCP client). */
    issuer: z.string().min(1),
    issuedAt: Timestamp,
    expiresAt: Timestamp,
    consumedAt: Timestamp.optional(),
    consumedByRunId: prefixedId("run").optional(),
  })
  .strict()
  .superRefine((g, ctx) => {
    if ((g.consumedAt === undefined) !== (g.consumedByRunId === undefined)) {
      ctx.addIssue({ code: "custom", message: "consumedAt and consumedByRunId are set together", path: ["consumedAt"] });
    }
    if (Date.parse(g.expiresAt) <= Date.parse(g.issuedAt)) {
      ctx.addIssue({ code: "custom", message: "expiresAt must be after issuedAt", path: ["expiresAt"] });
    }
  });
export type ApprovalGrant = z.infer<typeof ApprovalGrant>;

/** Execution states (spec §15.3). */
export const RunState = z.enum([
  "AWAITING_APPROVAL",
  "PREPARING",
  "WAITING_FOR_RESOURCE",
  "VALIDATING",
  "QUEUED",
  "RUNNING",
  "EVALUATING",
  "AWAITING_REVIEW",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "OUTCOME_UNKNOWN",
]);
export type RunState = z.infer<typeof RunState>;

/** States a run never leaves. `OUTCOME_UNKNOWN` is not one: it is reconciled (spec §15.4). */
export const FINAL_RUN_STATES: readonly RunState[] = ["COMPLETED", "FAILED", "CANCELLED"];

/**
 * The run state machine of spec §15.3 as data: the states each state may move to. Two
 * edges the spec's prose doesn't spell out: VALIDATING may become OUTCOME_UNKNOWN, because
 * submission is the last step of VALIDATING and its response can be lost; QUEUED may become
 * EVALUATING, because ComfyUI can finish a job between two polls. OUTCOME_UNKNOWN resolves to
 * whatever reconciliation against queue and history finds, never back to a resubmission.
 */
export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  AWAITING_APPROVAL: ["PREPARING", "CANCELLED"],
  PREPARING: ["WAITING_FOR_RESOURCE", "VALIDATING", "FAILED", "CANCELLED"],
  WAITING_FOR_RESOURCE: ["VALIDATING", "FAILED", "CANCELLED"],
  VALIDATING: ["QUEUED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"],
  QUEUED: ["RUNNING", "EVALUATING", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"],
  RUNNING: ["EVALUATING", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"],
  OUTCOME_UNKNOWN: ["QUEUED", "RUNNING", "EVALUATING", "FAILED", "CANCELLED"],
  EVALUATING: ["AWAITING_REVIEW", "COMPLETED", "FAILED"],
  AWAITING_REVIEW: ["COMPLETED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

/** Whether the state machine allows `from` → `to`. A state never transitions to itself. */
export function canTransition(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

/**
 * Whether a run passed its acceptance criteria, kept apart from whether it finished
 * (spec §4.2, §15.3). `waived_by_user` records the user's decision; no check passed.
 */
export const Acceptance = z.enum(["passed", "failed", "pending", "waived_by_user"]);
export type Acceptance = z.infer<typeof Acceptance>;

/** One file a run wrote, as ComfyUI's history names it. */
export const RunOutput = z
  .object({
    node: z.string().min(1),
    filename: z.string().min(1),
    subfolder: z.string().default(""),
    type: z.enum(["output", "temp"]),
  })
  .strict();
export type RunOutput = z.infer<typeof RunOutput>;

/**
 * Why a run failed or is uncertain. `COMFYUI_ERROR` marks an error ComfyUI itself reported
 * (a node or execution error); its message is ComfyUI's text and stays data (spec §14.4).
 * The run controller writes `EXECUTION_FAILED` for both a refusal at submission and an
 * execution error in the history, since the result envelope's code takes only
 * `ArchitectErrorCode`; it doesn't write `COMFYUI_ERROR`.
 */
export const RunError = z
  .object({
    code: z.union([ArchitectErrorCode, z.literal("COMFYUI_ERROR")]),
    message: z.string().min(1),
  })
  .strict();
export type RunError = z.infer<typeof RunError>;

export const RunTimings = z
  .object({
    submittedAt: Timestamp.optional(),
    startedAt: Timestamp.optional(),
    finishedAt: Timestamp.optional(),
  })
  .strict();
export type RunTimings = z.infer<typeof RunTimings>;

/**
 * States in which the run has been, or may have been, submitted. The prompt ID is stored
 * before submission (ARCH milestone 3, run controller), so these states always carry it:
 * reconciliation and cancellation key on it, and without it neither is possible.
 */
const SUBMITTED_STATES: readonly RunState[] = [
  "QUEUED",
  "RUNNING",
  "OUTCOME_UNKNOWN",
  "EVALUATING",
  "AWAITING_REVIEW",
  "COMPLETED",
];

/** One execution of an action plan's render (spec §7.1, `RunRecord`). */
export const RunRecord = z
  .object({
    schemaVersion: SchemaVersion,
    id: prefixedId("run"),
    actionPlanId: prefixedId("actions"),
    planId: RecordId,
    taskId: RecordId,
    taskRevision: z.number().int().min(1),
    candidateId: RecordId,
    graphFingerprint: Sha256,
    target: ExecutionTarget,
    /** Scoped to target, task and plan revision (spec §15.4); one key maps to one run. */
    idempotencyKey: z.string().min(1),
    state: RunState,
    /** The client-chosen prompt ID ComfyUI is given at submission (ARCH milestone 3). */
    promptId: z.string().uuid().optional(),
    grantId: prefixedId("grant").optional(),
    outputs: z.array(RunOutput).default([]),
    timings: RunTimings.default({}),
    acceptance: Acceptance.default("pending"),
    error: RunError.optional(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict()
  .superRefine((r, ctx) => {
    if (SUBMITTED_STATES.includes(r.state) && r.promptId === undefined) {
      ctx.addIssue({ code: "custom", message: `a run in ${r.state} carries its promptId`, path: ["promptId"] });
    }
    // A failure without a reason can't be surfaced with a stable code (spec §16.4).
    if (r.state === "FAILED" && r.error === undefined) {
      ctx.addIssue({ code: "custom", message: "a FAILED run carries its error", path: ["error"] });
    }
  });
export type RunRecord = z.infer<typeof RunRecord>;

/** Who caused a run event: the user through an approval channel, the agent, or the controller itself. */
export const RunPrincipal = z.enum(["user", "agent", "controller"]);
export type RunPrincipal = z.infer<typeof RunPrincipal>;

export const RunEventKind = z.enum(["transition", "submit_attempt", "submit_result", "reconcile", "cancel", "note"]);
export type RunEventKind = z.infer<typeof RunEventKind>;

/**
 * One entry of a run's history (spec §15.3: each transition has a guard, timestamp,
 * principal and reason). `seq` orders a run's events from 1 without gaps. A `transition`
 * names the state it entered; its `from` is absent only for the event that created the run.
 * Other kinds record what happened without changing state, so they carry neither.
 */
export const RunEvent = z
  .object({
    schemaVersion: SchemaVersion,
    runId: prefixedId("run"),
    seq: z.number().int().min(1),
    at: Timestamp,
    kind: RunEventKind,
    from: RunState.optional(),
    to: RunState.optional(),
    principal: RunPrincipal,
    reason: z.string().min(1),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.kind === "transition" && e.to === undefined) {
      ctx.addIssue({ code: "custom", message: "a transition names the state it entered", path: ["to"] });
    }
    if (e.kind !== "transition" && (e.from !== undefined || e.to !== undefined)) {
      ctx.addIssue({ code: "custom", message: `a ${e.kind} event changes no state`, path: ["kind"] });
    }
  });
export type RunEvent = z.infer<typeof RunEvent>;

/**
 * One criterion checked against one run (spec §7.1, §13.2, `EvaluationRecord`). `source`
 * keeps the user's verdict apart from the agent's: a verdict the agent relays is stored as
 * `agent_reported`, and only a verdict that came through an approval channel is the user's
 * (ARCH milestone 3, evaluation). Kind-neutral: what a measurement means is the evaluator's.
 */
export const EvaluationRecord = z
  .object({
    schemaVersion: SchemaVersion,
    id: prefixedId("eval"),
    runId: prefixedId("run"),
    criterionId: z.string().min(1),
    evaluatorId: z.string().min(1),
    evaluatorVersion: z.string().min(1),
    verdict: Verdict,
    source: z.enum(["automatic", "user", "agent_reported"]),
    channel: ApprovalChannel.optional(),
    /**
     * An optional evaluator's verdict the action plan didn't accept for this criterion: shown,
     * never counted toward acceptance (spec §13.2; ARCH 2026-11-16, visual evaluators).
     */
    advisory: z.boolean().default(false),
    measurement: z.object({ value: z.number(), unit: z.string().min(1) }).strict().optional(),
    explanation: z.string().min(1),
    /** Asset references the verdict rests on (spec §13.2 `evidenceAssetIds`). */
    evidence: z.array(z.string().min(1)).default([]),
    createdAt: Timestamp,
  })
  .strict()
  .superRefine((e, ctx) => {
    // A user verdict names the channel it came through; any other source naming one would
    // dress an automatic or relayed verdict up as the user's.
    if ((e.source === "user") !== (e.channel !== undefined)) {
      ctx.addIssue({ code: "custom", message: "channel is set exactly when the source is the user", path: ["channel"] });
    }
  });
export type EvaluationRecord = z.infer<typeof EvaluationRecord>;

/** Acquisition states (ARCH 2026-11-16, placement; TODO 4.2.2). */
export const AcquisitionState = z.enum(["planned", "downloading", "verifying", "placed", "failed", "cancelled"]);
export type AcquisitionState = z.infer<typeof AcquisitionState>;

/** States an acquisition never leaves. */
export const FINAL_ACQUISITION_STATES: readonly AcquisitionState[] = ["placed", "failed", "cancelled"];

/**
 * The acquisition state machine as data, like `RUN_TRANSITIONS`. Two edges go back, both
 * for a restart (TODO 4.5.3): downloading → planned when the download job was lost with the
 * process, so it starts again; verifying → downloading when the staged file is gone. A
 * staged file is never placed without passing verifying, and verifying can't be cancelled
 * midway: it ends placed, failed, or back at downloading.
 */
export const ACQUISITION_TRANSITIONS: Readonly<Record<AcquisitionState, readonly AcquisitionState[]>> = {
  planned: ["downloading", "failed", "cancelled"],
  downloading: ["verifying", "planned", "failed", "cancelled"],
  verifying: ["placed", "downloading", "failed"],
  placed: [],
  failed: [],
  cancelled: [],
};

/** Whether the acquisition state machine allows `from` → `to`. */
export function canAcquisitionTransition(from: AcquisitionState, to: AcquisitionState): boolean {
  return ACQUISITION_TRANSITIONS[from].includes(to);
}

/**
 * One model file a run acquires (TODO 4.2, 4.5): one record per file of the action plan's
 * `acquire_models` effect, created with the run. `observedSha256` and `observedBytes` are
 * what Architect measured on the staged file, kept apart from the pinned `source` values
 * they're compared with.
 */
export const AcquisitionRecord = z
  .object({
    schemaVersion: SchemaVersion,
    id: prefixedId("acq"),
    runId: prefixedId("run"),
    actionPlanId: prefixedId("actions"),
    folder: ModelFolderName,
    file: BareFileName,
    source: ModelSource,
    destinationRoot: AbsolutePath,
    state: AcquisitionState,
    /** Upstream's download job id, once the job started. */
    jobId: z.string().min(1).optional(),
    stagedPath: AbsolutePath.optional(),
    placedPath: AbsolutePath.optional(),
    observedSha256: Sha256.optional(),
    observedBytes: Bytes.optional(),
    error: z.object({ code: ArchitectErrorCode, message: z.string().min(1) }).strict().optional(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.state === "failed" && a.error === undefined) {
      ctx.addIssue({ code: "custom", message: "a failed acquisition carries its error", path: ["error"] });
    }
    // Placed means verified: the measured hash and size are the pinned ones, and the file
    // has a path to show for it.
    if (a.state === "placed") {
      if (a.placedPath === undefined) ctx.addIssue({ code: "custom", message: "a placed acquisition names its placedPath", path: ["placedPath"] });
      if (a.observedSha256 !== a.source.sha256) {
        ctx.addIssue({ code: "custom", message: "a placed acquisition's observed sha256 is the pinned one", path: ["observedSha256"] });
      }
      if (a.observedBytes !== a.source.sizeBytes) {
        ctx.addIssue({ code: "custom", message: "a placed acquisition's observed size is the pinned one", path: ["observedBytes"] });
      }
    }
  });
export type AcquisitionRecord = z.infer<typeof AcquisitionRecord>;

/**
 * A hold on one memory pool (spec §11.3, ARCH milestone 3, resources). Coordination state
 * with no history to migrate: it lives in relational columns only and carries no
 * `schemaVersion`.
 */
export const ResourceLease = z
  .object({
    pool: z.string().min(1),
    ownerId: z.string().min(1),
    runId: prefixedId("run").optional(),
    acquiredAt: Timestamp,
    heartbeatAt: Timestamp,
    expiresAt: Timestamp,
  })
  .strict();
export type ResourceLease = z.infer<typeof ResourceLease>;

// ---------------------------------------------------------------------------------------
// Model families (spec §8.1, §9.3; TODO 5.3; ARCH 2026-11-16, model families)

/**
 * A tensor name or a pattern of one: `*` stands for any run of characters, dots included,
 * so `*img_in.weight` matches both `img_in.weight` and `model.diffusion_model.img_in.weight`.
 */
const TensorPattern = z.string().min(1).max(256);

/** A family name as recipes write it in `modelFamily`. */
const FamilyId = z.string().regex(/^[a-z0-9][a-z0-9.-]*$/, "expected a lower-case family id");

/**
 * How to recognise the files of one model family from their safetensors header, shipped as
 * `architect/families/<id>.json` (TODO 5.3). A file matches when every `requiredTensors`
 * pattern matches some tensor, no `forbiddenTensors` pattern matches any, and every tensor a
 * `shapes` pattern matches has those dimensions (at least one must). Rules are evidence a
 * maintainer wrote from observed headers; `provenance` says which.
 */
export const FamilyRule = z
  .object({
    schemaVersion: SchemaVersion,
    id: FamilyId,
    title: z.string().min(1),
    /**
     * Other names recipes use for this family, so a recipe written before the rule keeps its
     * `modelFamily` (a renamed family would change its content hash under its revision).
     */
    aliases: z.array(FamilyId).optional(),
    /** The model folders a slot of this family loads from. */
    folders: z.array(ModelFolderName).min(1),
    requiredTensors: z.array(TensorPattern).min(1),
    forbiddenTensors: z.array(TensorPattern).optional(),
    shapes: z.record(TensorPattern, z.array(z.number().int().nonnegative())).optional(),
    /**
     * Variants whose files have the same header, so a match can't tell them apart (Z-Image
     * Turbo and Z-Image Base). A match then confirms the architecture only: it passes for the
     * file a recipe names as its default, whose author chose it, and stays a hard unknown for
     * any other file (GAPS Q14).
     */
    indistinguishableFrom: z.array(FamilyId).optional(),
    provenance: z
      .array(z.object({ source: z.string().min(1), observedAt: Timestamp, note: z.string().min(1) }).strict())
      .min(1),
  })
  .strict();
export type FamilyRule = z.infer<typeof FamilyRule>;

/**
 * What Architect read of one model file's family (TODO 5.3): the rules its safetensors
 * header matched, kept by folder, file, size and modification time, and the digest of the
 * rules it was matched against, so a changed file or a changed rule set is read again.
 * `unreadable` is not a negative: the header couldn't be read, and the family stays unknown.
 */
export const ModelObservation = z
  .object({
    schemaVersion: SchemaVersion,
    folder: ModelFolderName,
    /** The name as the target lists it in the folder; may hold subfolders. */
    file: z.string().min(1),
    sizeBytes: Bytes,
    mtimeMs: z.number().nonnegative(),
    /** Where upstream's resolver found the file, so the next check needs only a stat. */
    path: AbsolutePath,
    /** The model root the resolver found it under. */
    root: AbsolutePath.optional(),
    /**
     * The facade's `modelRootsKey` when the file was located: under another key (another
     * target or ComfyUI path) the cached path isn't trusted and the file is located again.
     */
    rootsKey: z.string().min(1).optional(),
    rulesDigest: Sha256,
    outcome: z.enum(["matched", "no_match", "ambiguous", "unreadable"]),
    /** The one rule matched, exactly when `outcome` is `matched`. */
    family: FamilyId.optional(),
    /** Every rule id the header matched. */
    matches: z.array(FamilyId),
    reason: z.string().min(1),
    observedAt: Timestamp,
  })
  .strict()
  .superRefine((o, ctx) => {
    const expected = o.outcome === "matched" ? 1 : o.outcome === "ambiguous" ? 2 : 0;
    if (expected === 2 ? o.matches.length < 2 : o.matches.length !== expected) {
      ctx.addIssue({ code: "custom", message: `a ${o.outcome} observation lists ${o.matches.length} match(es)`, path: ["matches"] });
    }
    if ((o.outcome === "matched") !== (o.family !== undefined) || (o.family !== undefined && o.family !== o.matches[0])) {
      ctx.addIssue({ code: "custom", message: "family is the one match of a matched observation", path: ["family"] });
    }
  });
export type ModelObservation = z.infer<typeof ModelObservation>;

// ---------------------------------------------------------------------------------------
// Source registry (spec §8.5; GAPS Q32; ARCH 2026-11-16, sources)

/** How a source is read. Each adapter is code in Architect; an entry only configures it. */
export const SourceAdapter = z.enum(["huggingface_pinned", "comfyui_template_index", "upstream_packs"]);
export type SourceAdapter = z.infer<typeof SourceAdapter>;

/** What Architect may do with a source. */
export const SourceOperation = z.enum(["list", "import", "download"]);
export type SourceOperation = z.infer<typeof SourceOperation>;

/** The operations each adapter can carry out at all; an entry allows a subset. */
const ADAPTER_OPERATIONS: Readonly<Record<SourceAdapter, readonly SourceOperation[]>> = {
  huggingface_pinned: ["download"],
  comfyui_template_index: ["list", "import"],
  upstream_packs: ["list", "import"],
};

/**
 * How far a source is trusted: `approved` (an owner-approved download host, GAPS Q25),
 * `vendor` (ComfyUI's own templates on the target), `upstream` (the packs upstream ships),
 * `user` (a source the user adds later). Trust never makes a recipe more than `proposed`.
 */
export const SourceTrust = z.enum(["approved", "vendor", "upstream", "user"]);

/**
 * When a source is read again. `pinned`: its content is fixed by pins (a Hugging Face
 * commit), so nothing is refreshed; `on_demand`: read when a list or import needs it.
 */
export const SourceRefreshPolicy = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pinned") }).strict(),
  z.object({ kind: z.literal("on_demand") }).strict(),
]);

/**
 * One configured source (spec §8.5): adapter, root, allowed operations, trust, refresh
 * policy and the last successful refresh. `state` is `unrefreshed` until a refresh is
 * tried, `ok` after one succeeded, and `unavailable` with its reason after one failed: an
 * unreachable source is unavailable, never an empty one.
 */
export const SourceRegistryEntry = z
  .object({
    schemaVersion: SchemaVersion,
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, "expected a lower-case source id"),
    adapter: SourceAdapter,
    /** A URL for a remote source, an absolute path for a local one. */
    root: z.string().min(1),
    allowedOps: z.array(SourceOperation).min(1),
    trust: SourceTrust,
    refreshPolicy: SourceRefreshPolicy,
    /** Shipped with Architect and written at startup, not configured by the user. */
    builtIn: z.boolean(),
    state: z.enum(["unrefreshed", "ok", "unavailable"]),
    lastRefreshAt: Timestamp.optional(),
    lastAttemptAt: Timestamp.optional(),
    unavailableReason: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (new Set(s.allowedOps).size !== s.allowedOps.length) {
      ctx.addIssue({ code: "custom", message: "an operation is listed twice", path: ["allowedOps"] });
    }
    for (const op of s.allowedOps) {
      if (!ADAPTER_OPERATIONS[s.adapter].includes(op)) {
        ctx.addIssue({ code: "custom", message: `adapter ${s.adapter} can't ${op}`, path: ["allowedOps"] });
      }
    }
    const local = s.adapter === "upstream_packs";
    if (local ? !isAbsolute(s.root) : !/^https?:\/\/[^/]/.test(s.root)) {
      ctx.addIssue({ code: "custom", message: local ? "a local source's root is an absolute path" : "a remote source's root is an http(s) URL", path: ["root"] });
    }
    if ((s.state === "unavailable") !== (s.unavailableReason !== undefined)) {
      ctx.addIssue({ code: "custom", message: "unavailableReason is set exactly when the source is unavailable", path: ["unavailableReason"] });
    }
    if (s.state === "ok" && s.lastRefreshAt === undefined) {
      ctx.addIssue({ code: "custom", message: "an ok source names its last successful refresh", path: ["lastRefreshAt"] });
    }
    if (s.state !== "unrefreshed" && s.lastAttemptAt === undefined) {
      ctx.addIssue({ code: "custom", message: "a refreshed source names its last attempt", path: ["lastAttemptAt"] });
    }
  });
export type SourceRegistryEntry = z.infer<typeof SourceRegistryEntry>;

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
  actionPlan: ActionPlan,
  approvalRequest: ApprovalRequest,
  approvalGrant: ApprovalGrant,
  run: RunRecord,
  runEvent: RunEvent,
  evaluation: EvaluationRecord,
  acquisition: AcquisitionRecord,
  modelObservation: ModelObservation,
  source: SourceRegistryEntry,
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
  actionPlan: {},
  approvalRequest: {},
  approvalGrant: {},
  run: {},
  runEvent: {},
  evaluation: {},
  acquisition: {},
  modelObservation: {},
  source: {},
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
