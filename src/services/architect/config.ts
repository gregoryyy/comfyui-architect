// Architect's configuration, read in one place (TODO 1.5.1).
//
// Kept here rather than in src/config.ts so the upstream file stays untouched. Two
// settings are read where their rule lives: the data directory in store.ts and the
// snapshot's maximum age in environment.ts; ARCHITECT_ENV_KEYS lists all of them.

/** Environment variable that switches the Architect tools on. Off by default. */
export const ARCHITECT_FLAG_ENV = "COMFYUI_ARCHITECT";

/**
 * Marks the server the panel orchestrator starts for its agent. Set by `architectChildEnv`,
 * never by a user: on that route an elicitation can be answered by upstream's panel Codex
 * agent, which accepts every elicitation (`codex-backend.ts`), so approvals there go
 * through the terminal command only (GAPS Q20, ARCH 2026-11-15).
 */
export const ARCHITECT_ROUTE_ENV = "ARCHITECT_ROUTE";

/** Lets Architect unload a loopback Ollama's resident models before a render (spec §18.1). */
export const ARCHITECT_RESIDENCY_ENV = "ARCHITECT_MANAGE_RESIDENCY";

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

/** Upstream's operator preset that withholds mutating, executing and panel tools (#873). */
export const MANAGED_TOOL_PRESET = "readonly";
const TOOL_PRESET_ENV = "COMFYUI_MCP_TOOL_PRESET";

/**
 * Applies managed mode before upstream registers its tools: sets upstream's `readonly`
 * preset, which its registrar decorator applies to the direct and compact routes and its
 * tool-policy forwarding passes to the panel agent's server. Reusing that filter keeps one
 * boundary instead of two (ARCH 2026-11-15). Throws when an operator set another preset,
 * since managed mode with a looser preset would claim a boundary it doesn't have.
 * Returns whether it set the preset. Does nothing outside managed mode.
 */
export function applyArchitectMode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (architectMode(env) !== "managed") return false;
  const preset = env[TOOL_PRESET_ENV];
  if (preset === undefined || preset.trim() === "") {
    env[TOOL_PRESET_ENV] = MANAGED_TOOL_PRESET;
    return true;
  }
  if (preset.trim() !== MANAGED_TOOL_PRESET) {
    throw new Error(
      `${ARCHITECT_FLAG_ENV}=managed needs ${TOOL_PRESET_ENV}=${MANAGED_TOOL_PRESET} or no preset, ` +
        `but ${TOOL_PRESET_ENV}="${preset}" is set. Managed mode withholds upstream's effectful tools; ` +
        `remove the preset, set it to ${MANAGED_TOOL_PRESET}, or use ${ARCHITECT_FLAG_ENV}=1.`,
    );
  }
  return false;
}

/** Whether this server runs for the panel's agent (see ARCHITECT_ROUTE_ENV). */
export function onPanelRoute(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ARCHITECT_ROUTE_ENV] === "panel";
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
