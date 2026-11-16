// Architect's configuration, read in one place (TODO 1.5.1).
//
// Kept here rather than in src/config.ts so the upstream file stays untouched. Two
// settings are read where their rule lives: the data directory in store.ts and the
// snapshot's maximum age in environment.ts; ARCHITECT_ENV_KEYS lists all of them.
//
// No imports: upstream's panel-secrets.ts imports this file, so anything it imported would
// load into every upstream test that mocks a module this one doesn't need. Managed mode,
// which reads upstream's tool filter, is in mode.ts.

/** Environment variable that switches the Architect tools on. Off by default. */
export const ARCHITECT_FLAG_ENV = "COMFYUI_ARCHITECT";

/**
 * Marks the server the panel orchestrator starts for its agent. Set by `architectChildEnv`,
 * never by a user: on that route an elicitation can be answered by upstream's panel Codex
 * agent, which accepts every elicitation (`codex-backend.ts`), so approvals there go
 * through the terminal command only (GAPS Q20, ARCH 2026-11-15).
 */
export const ARCHITECT_ROUTE_ENV = "ARCHITECT_ROUTE";

/**
 * Whether a run may start on the panel route (GAPS Q22). Unset or `off`: refused, because
 * upstream's panel agents run shells that approve their own commands and could complete
 * the terminal approval themselves. `terminal`: allowed with a grant the user issued, which
 * on that route only the terminal command can, never a dialog. An operator setting, read
 * from the environment the panel's server starts with; no tool sets it.
 */
export const ARCHITECT_PANEL_RUNS_ENV = "ARCHITECT_PANEL_RUNS";

/** Lets Architect unload a loopback Ollama's resident models before a render (spec §18.1). */
export const ARCHITECT_RESIDENCY_ENV = "ARCHITECT_MANAGE_RESIDENCY";

/**
 * The Ollama tag the OCR evaluator uses when Ollama lists more than one `glm-ocr` tag
 * (TODO 6.4). Unset with several tags, or naming none of them, the OCR verdict is `unknown`.
 */
export const ARCHITECT_OCR_MODEL_ENV = "ARCHITECT_OCR_MODEL";

/** The OCR model tag the operator chose, if any (see ARCHITECT_OCR_MODEL_ENV). */
export function ocrModelPreference(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[ARCHITECT_OCR_MODEL_ENV]?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
}

/**
 * - `off`: upstream behaviour, no Architect tool on any route (spec AT-12).
 * - `assist`: Architect's tools next to upstream's; grants govern Architect's own runs.
 * - `managed`: as assist, and upstream's effectful tools are withheld on every route, so
 *   every effect goes through `architect_run` (GAPS Q21).
 */
export type ArchitectMode = "off" | "assist" | "managed";

const TRUE_VALUES = ["1", "true", "yes", "on"];

/** The mode the flag selects: `1`, `true`, `yes` or `on` is assist, `managed` is managed. */
export function architectMode(env: NodeJS.ProcessEnv = process.env): ArchitectMode {
  const raw = env[ARCHITECT_FLAG_ENV]?.trim().toLowerCase();
  if (raw === undefined) return "off";
  if (raw === "managed") return "managed";
  return TRUE_VALUES.includes(raw) ? "assist" : "off";
}

/**
 * Whether the Architect tool group is registered. Off unless the variable selects assist
 * or managed mode. Off means upstream behaviour: no Architect tool is registered on any
 * route (spec AT-12).
 */
export function architectEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return architectMode(env) !== "off";
}

/** Whether this server runs for the panel's agent (see ARCHITECT_ROUTE_ENV). */
export function onPanelRoute(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ARCHITECT_ROUTE_ENV] === "panel";
}

/** Whether the operator allowed runs on the panel route (see ARCHITECT_PANEL_RUNS_ENV). */
export function panelRunsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ARCHITECT_PANEL_RUNS_ENV]?.trim().toLowerCase() === "terminal";
}

/**
 * Every variable Architect reads. The panel orchestrator builds its agent's tool-server
 * environment from an allowlist (upstream #873), so these are forwarded explicitly through
 * `architectChildEnv`; a variable missing here doesn't exist on the panel route.
 */
export const ARCHITECT_ENV_KEYS = [
  ARCHITECT_FLAG_ENV,
  "ARCHITECT_DATA_DIR",
  "ARCHITECT_ENV_MAX_AGE_SECONDS",
  ARCHITECT_RESIDENCY_ENV,
  ARCHITECT_PANEL_RUNS_ENV,
  ARCHITECT_OCR_MODEL_ENV,
] as const;

/**
 * The Architect variables for the panel agent's tool server, the one caller of this
 * function (`buildComfyuiMcpEnv`). Adds the panel route marker when Architect is on, so
 * that server never asks for an approval by elicitation.
 */
export function architectChildEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ARCHITECT_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  if (architectEnabled(env)) out[ARCHITECT_ROUTE_ENV] = "panel";
  return out;
}
