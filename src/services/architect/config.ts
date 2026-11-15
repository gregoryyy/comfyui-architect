// Architect's configuration, read in one place (TODO 1.5.1).
//
// Kept here rather than in src/config.ts so the upstream file stays untouched; the
// domain code receives values from these functions and never reads the environment
// itself.

/** Environment variable that switches the Architect tools on. Off by default. */
export const ARCHITECT_FLAG_ENV = "COMFYUI_ARCHITECT";

/**
 * Whether the Architect tool group is registered. Off unless the variable is `1`, `true`,
 * `yes` or `on`. Off means upstream behaviour: no Architect tool is registered on any
 * route (spec AT-12).
 */
export function architectEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ARCHITECT_FLAG_ENV];
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}
