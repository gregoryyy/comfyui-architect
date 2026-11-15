// Whether an environment snapshot can still stand for the target (TODO 2.3.2, spec §7.3).
//
// A snapshot is a reading at one moment of one target. Planning on it later assumes the
// nodes and models it lists are still there, so these checks decide when that assumption
// is too old, too incomplete or about another target. Missing data counts against a
// snapshot, never for it (#796).
//
// The maximum age is read here rather than in config.ts, which holds only the feature flag
// so far; the planner receives the value through these functions.

import type { EnvironmentSnapshot } from "./schemas.js";
import type { EnvironmentProbe } from "./service.js";

/** Environment variable for the maximum snapshot age, in whole seconds. */
export const ARCHITECT_ENV_MAX_AGE_ENV = "ARCHITECT_ENV_MAX_AGE_SECONDS";

/** The maximum snapshot age when the variable is unset or invalid. */
export const DEFAULT_ENV_MAX_AGE_SECONDS = 300;

/** True for a whole number of seconds above zero. */
function validMaxAge(seconds: number): boolean {
  return Number.isSafeInteger(seconds) && seconds > 0;
}

/**
 * The maximum snapshot age in seconds from `ARCHITECT_ENV_MAX_AGE_SECONDS`. Anything but a
 * positive whole number falls back to the default, so a typo can't switch the check off.
 */
export function environmentMaxAgeSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ARCHITECT_ENV_MAX_AGE_ENV]?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return DEFAULT_ENV_MAX_AGE_SECONDS;
  const seconds = Number(raw);
  return validMaxAge(seconds) ? seconds : DEFAULT_ENV_MAX_AGE_SECONDS;
}

/** How old a snapshot is against its maximum age. */
export interface EnvironmentFreshness {
  fresh: boolean;
  /** Seconds from `capturedAt` to `now`; negative when the snapshot is dated after `now`. */
  ageSeconds: number;
  maxAgeSeconds: number;
}

/**
 * Whether `snapshot` is at most `maxAgeSeconds` old at `now` (the boundary counts as
 * fresh). A snapshot dated after `now` is not fresh: its age can't be established, which
 * happens when the clock moved back since it was taken. An invalid `maxAgeSeconds` falls
 * back to the default.
 */
export function environmentFreshness(
  snapshot: Pick<EnvironmentSnapshot, "capturedAt">,
  now: Date,
  maxAgeSeconds: number = environmentMaxAgeSeconds(),
): EnvironmentFreshness {
  const max = validMaxAge(maxAgeSeconds) ? maxAgeSeconds : DEFAULT_ENV_MAX_AGE_SECONDS;
  const ageSeconds = (now.getTime() - Date.parse(snapshot.capturedAt)) / 1000;
  // NaN from an unparsable timestamp fails both comparisons, so it reads as stale.
  return { fresh: ageSeconds >= 0 && ageSeconds <= max, ageSeconds, maxAgeSeconds: max };
}

/** Whether a snapshot can feed planning, and every reason it can't. */
export interface PlanningReadiness {
  usable: boolean;
  reasons: string[];
}

/** A base URL in comparable form; a string that doesn't parse is compared as written. */
function comparableBaseUrl(url: string): string {
  try {
    return new URL(url).href.replace(/\/+$/, "");
  } catch {
    return url.trim().replace(/\/+$/, "");
  }
}

/**
 * Whether `snapshot` can feed planning at `now` for the target at `expectedBaseUrl`. Not
 * usable when it is stale, when its node classes or installed models are unknown (the
 * planner checks every candidate against both), or when it describes another target.
 * Hardware fields don't block: resource estimates stay unknown until measured profiles
 * exist (spec §9.3). Unanswered model folders don't block either; the planner treats a
 * file in one as unknown, per folder.
 */
export function planningReadiness(
  snapshot: EnvironmentSnapshot,
  now: Date,
  expectedBaseUrl: string,
  maxAgeSeconds?: number,
): PlanningReadiness {
  const reasons: string[] = [];
  const probeError = (probe: EnvironmentProbe): string | undefined =>
    snapshot.probeErrors.find((e) => e.probe === probe)?.message;

  const freshness = environmentFreshness(snapshot, now, maxAgeSeconds);
  if (!freshness.fresh) {
    reasons.push(
      Number.isNaN(freshness.ageSeconds)
        ? "the snapshot's capture time can't be read; its age is unknown"
        : freshness.ageSeconds < 0
          ? `the snapshot is dated ${-freshness.ageSeconds}s after now; its age is unknown`
          : `the snapshot is ${freshness.ageSeconds}s old, over the ${freshness.maxAgeSeconds}s maximum`,
    );
  }

  const objectInfoError = probeError("object_info");
  const nodesMissing = snapshot.nodeClassCount === undefined || snapshot.nodeSchemaDigest === undefined;
  if (objectInfoError !== undefined || nodesMissing) {
    const why = objectInfoError ?? "not in the snapshot";
    reasons.push(`installed node classes are unknown: ${why}`);
  }

  const modelsError = probeError("models");
  if (modelsError !== undefined || snapshot.installedModels === undefined) {
    const why = modelsError ?? "not in the snapshot";
    reasons.push(`installed models are unknown: ${why}`);
  }

  if (comparableBaseUrl(snapshot.target.baseUrl) !== comparableBaseUrl(expectedBaseUrl)) {
    reasons.push(`the snapshot describes ${snapshot.target.baseUrl}, not ${expectedBaseUrl}`);
  }

  return { usable: reasons.length === 0, reasons };
}
