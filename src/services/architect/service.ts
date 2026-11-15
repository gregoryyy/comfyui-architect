// The Architect service boundary (spec §16.3). Its dependencies are injected, so unit
// tests run without ComfyUI, a GPU or a provider.
//
// Phase 0 implements read-only inspection only. Planning and execution arrive with TODO
// milestones 2 and later, behind the same boundary.

import { createHash, randomUUID } from "node:crypto";
import { ARCHITECT_SCHEMA_VERSION } from "../../fork-identity.js";
import { EnvironmentSnapshot, type ProbeError, ResultEnvelope } from "./schemas.js";
import type { UpstreamFacade } from "./upstream.js";

/** The reads an environment snapshot is built from; all of them failing means no snapshot. */
const ENVIRONMENT_PROBES = ["system_stats", "object_info"] as const;

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
    const snapshot: Record<string, unknown> = {
      schemaVersion: ARCHITECT_SCHEMA_VERSION,
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
      probeErrors.push({ probe: ENVIRONMENT_PROBES[0], message: errorMessage(err) });
    }

    try {
      const classes = Object.keys(await upstream.objectInfo());
      snapshot.nodeClassCount = classes.length;
      snapshot.nodeSchemaDigest = nodeSchemaDigest(classes);
    } catch (err) {
      probeErrors.push({ probe: ENVIRONMENT_PROBES[1], message: errorMessage(err) });
    }

    snapshot.probeErrors = probeErrors;
    return EnvironmentSnapshot.parse(snapshot);
  }

  /** The environment snapshot wrapped in the result envelope (spec §16.2). */
  async inspectEnvironmentEnvelope(): Promise<ResultEnvelope> {
    const snap = await this.inspectEnvironment();
    const failed = snap.probeErrors.map((e) => e.probe);
    const unreadable = failed.length === ENVIRONMENT_PROBES.length;
    const summary =
      failed.length === 0
        ? `ComfyUI ${snap.comfyuiVersion ?? "(version not reported)"} at ${snap.target.baseUrl}: ` +
          `${snap.nodeClassCount} node classes, ${snap.devices?.length ?? 0} device(s).`
        : unreadable
          ? `No snapshot of ${snap.target.baseUrl}: ${failed.join(", ")} could not be read; ` +
            "every field is unknown."
          : `Partial snapshot of ${snap.target.baseUrl}: ${failed.join(", ")} could not be read; ` +
            "those fields are unknown, not empty.";
    return ResultEnvelope.parse({
      schemaVersion: ARCHITECT_SCHEMA_VERSION,
      operationId: this.deps.newId(),
      status: failed.length === 0 ? "ok" : unreadable ? "error" : "partial",
      summary,
      data: { environment: snap },
      warnings: snap.probeErrors.map((e) => `${e.probe}: ${e.message}`),
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
