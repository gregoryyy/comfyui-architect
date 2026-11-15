// Architect's runtime contracts (spec §7, §16). Zod is the authority; types are inferred.
//
// Only what the first slice needs is defined here: the result envelope, verdicts, stable
// error codes, workflow kinds and the environment snapshot. The planning records
// (TaskSpec, Recipe, PlanCandidate …) come with TODO 2.1, kind-neutral as AGENTS
// requires.

import { z } from "zod";
import { ARCHITECT_SCHEMA_VERSION } from "../../fork-identity.js";

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
 * What the connected target is, at one moment (spec §7.1, `EnvironmentSnapshot`). Fields a
 * probe could not read stay absent and the probe is listed in `probeErrors`; consumers
 * treat an absent field as unknown.
 */
export const EnvironmentSnapshot = z
  .object({
    schemaVersion: z.literal(ARCHITECT_SCHEMA_VERSION),
    capturedAt: z.string(),
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
    probeErrors: z.array(ProbeError),
  })
  .strict();
export type EnvironmentSnapshot = z.infer<typeof EnvironmentSnapshot>;

/** The result envelope every Architect tool returns (spec §16.2). */
export const ResultEnvelope = z
  .object({
    schemaVersion: z.literal(ARCHITECT_SCHEMA_VERSION),
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
