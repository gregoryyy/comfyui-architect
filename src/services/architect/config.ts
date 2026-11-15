// Architect's configuration, read in one place (TODO 1.5.1).
//
// Kept here rather than in src/config.ts so the upstream file stays untouched. Two
// settings are read where their rule lives: the data directory in store.ts and the
// snapshot's maximum age in environment.ts; ARCHITECT_ENV_KEYS lists all of them.

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

/**
 * Every variable Architect reads. The panel orchestrator builds its agent's tool-server
 * environment from an allowlist (upstream #873), so these are forwarded explicitly through
 * `architectChildEnv`; a variable missing here doesn't exist on the panel route.
 */
export const ARCHITECT_ENV_KEYS = [ARCHITECT_FLAG_ENV, "ARCHITECT_DATA_DIR", "ARCHITECT_ENV_MAX_AGE_SECONDS"] as const;

/** The Architect variables that are set, for a child process's constructed environment. */
export function architectChildEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ARCHITECT_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out;
}
