// The Architect service boundary (spec §16.3). Its dependencies are injected, so unit
// tests run without ComfyUI, a GPU or a provider.
//
// Read-only inspection so far (TODO 1.6, 2.3). Planning and execution arrive with later
// TODO items, behind the same boundary.

import { createHash, randomUUID } from "node:crypto";
import { ARCHITECT_SCHEMA_VERSION } from "../../fork-identity.js";
import { EnvironmentSnapshot, type ProbeError, ResultEnvelope } from "./schemas.js";
import type { UpstreamFacade } from "./upstream.js";

/** The reads an environment snapshot is built from; all of them failing means no snapshot. */
export const ENVIRONMENT_PROBES = ["system_stats", "object_info", "models"] as const;
export type EnvironmentProbe = (typeof ENVIRONMENT_PROBES)[number];

export interface ArchitectDeps {
  upstream: UpstreamFacade;
  /** The clock; injected so snapshots are reproducible in tests. */
  now: () => Date;
  /** Operation ids; injected for the same reason. */
  newId: () => string;
}

export function defaultDeps(upstream: UpstreamFacade): ArchitectDeps {
  return { upstream, now: () => new Date(), newId: () => `op-${randomUUID()}` };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** sha256 over the sorted node class names, so the digest ignores ComfyUI's ordering. */
export function nodeSchemaDigest(classNames: readonly string[]): string {
  return createHash("sha256").update([...classNames].sort().join("\n")).digest("hex");
}

export class ArchitectService {
  constructor(private readonly deps: ArchitectDeps) {}

  /**
   * A snapshot of the connected target. Each probe that fails is recorded in
   * `probeErrors` and its fields stay absent: a failed read is unknown, never "nothing
   * there" (upstream #796, spec §7.3).
   */
  async inspectEnvironment(): Promise<EnvironmentSnapshot> {
    const { upstream, now } = this.deps;
    const probeErrors: ProbeError[] = [];
    const failed = (probe: EnvironmentProbe, err: unknown): void => {
      probeErrors.push({ probe, message: errorMessage(err) });
    };
    const snapshot: Record<string, unknown> = {
      schemaVersion: ARCHITECT_SCHEMA_VERSION,
      id: `env-${this.deps.newId()}`,
      capturedAt: now().toISOString(),
      target: { baseUrl: upstream.comfyuiBaseUrl() },
    };

    try {
      const stats = await upstream.systemStats();
      snapshot.comfyuiVersion = stats.system.comfyui_version;
      snapshot.pythonVersion = stats.system.python_version;
      snapshot.os = stats.system.os;
      snapshot.ramTotal = stats.system.ram_total;
      snapshot.ramFree = stats.system.ram_free;
      snapshot.devices = stats.devices.map((d) => ({
        name: d.name,
        type: d.type,
        memoryTotal: d.vram_total,
        memoryFree: d.vram_free,
      }));
    } catch (err) {
      failed("system_stats", err);
    }

    try {
      const classes = Object.keys(await upstream.objectInfo());
      snapshot.nodeClassCount = classes.length;
      snapshot.nodeSchemaDigest = nodeSchemaDigest(classes);
    } catch (err) {
      failed("object_info", err);
    }

    try {
      snapshot.installedModels = await upstream.installedModels();
    } catch (err) {
      failed("models", err);
    }

    snapshot.probeErrors = probeErrors;
    return EnvironmentSnapshot.parse(snapshot);
  }

  /**
   * The environment snapshot wrapped in the result envelope (spec §16.2). `error` only
   * when every probe failed; `partial` when one did or a model folder didn't answer, with
   * each gap as a warning, so an incomplete snapshot never reads as a complete one.
   */
  async inspectEnvironmentEnvelope(): Promise<ResultEnvelope> {
    const snap = await this.inspectEnvironment();
    const failed = snap.probeErrors.map((e) => e.probe);
    const unanswered = snap.installedModels?.unanswered ?? [];
    const unreadable = failed.length === ENVIRONMENT_PROBES.length;
    const complete = failed.length === 0 && unanswered.length === 0;
    const at = snap.target.baseUrl;

    const facts: string[] = [];
    if (snap.nodeClassCount !== undefined) facts.push(`${snap.nodeClassCount} node classes`);
    if (snap.devices !== undefined) facts.push(`${snap.devices.length} device(s)`);
    if (snap.installedModels !== undefined) {
      const lists = Object.values(snap.installedModels.folders);
      const files = lists.reduce((n, names) => n + names.length, 0);
      facts.push(`${files} model file(s) in ${lists.length} answered folder(s)`);
    }
    const gaps: string[] = [];
    if (failed.length > 0) gaps.push(`${failed.join(", ")} could not be read`);
    if (unanswered.length > 0) gaps.push(`${unanswered.length} model folder(s) did not answer`);

    const summary = complete
      ? `ComfyUI ${snap.comfyuiVersion ?? "(version not reported)"} at ${at}: ${facts.join(", ")}.`
      : unreadable
        ? `No snapshot of ${at}: ${failed.join(", ")} could not be read; every field is unknown.`
        : `Partial snapshot of ${at}: ${facts.join(", ")}; ${gaps.join("; ")}; ` +
          "those fields are unknown, not empty.";
    return ResultEnvelope.parse({
      schemaVersion: ARCHITECT_SCHEMA_VERSION,
      operationId: this.deps.newId(),
      status: complete ? "ok" : unreadable ? "error" : "partial",
      summary,
      data: { environment: snap },
      warnings: [
        ...snap.probeErrors.map((e) => `${e.probe}: ${e.message}`),
        ...unanswered.map((u) => `models/${u.folder}: ${u.reason}`),
      ],
      artifacts: [],
      ...(unreadable
        ? {
            error: {
              code: "STALE_ENVIRONMENT",
              retryable: true,
              nextStep: "Check that ComfyUI is running and reachable, then inspect again.",
            },
          }
        : {}),
    });
  }
}
