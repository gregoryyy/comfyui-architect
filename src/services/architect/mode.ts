// Managed mode (GAPS Q21): applied by boot.ts before upstream registers its tools.
//
// Kept out of config.ts because it reads upstream's tool filter through the facade, and
// config.ts is imported by upstream's panel-secrets.ts: through it, the facade's imports
// (the ComfyUI client among them) would load into upstream tests that mock that client.

import { ARCHITECT_FLAG_ENV, architectMode } from "./config.js";
import { presetWithholds } from "./upstream.js";

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
  const readmitted = readmittedByAllowList(env);
  if (readmitted.length > 0) {
    throw new Error(
      `${ARCHITECT_FLAG_ENV}=managed withholds upstream's effectful tools, but COMFYUI_MCP_TOOL_ALLOW names ${readmitted.join(", ")}, ` +
        `which an allow list would let through. Remove them from the allow list, or use ${ARCHITECT_FLAG_ENV}=1.`,
    );
  }
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

/**
 * Allow-list entries that would re-admit a tool managed mode withholds: upstream's filter
 * lets an exact allow-list name through a preset (`toolAllowed`), so managed mode with such
 * a list would claim a boundary it doesn't have.
 */
function readmittedByAllowList(env: NodeJS.ProcessEnv): string[] {
  const allow = (env.COMFYUI_MCP_TOOL_ALLOW ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (allow.length === 0) return [];
  return allow.filter((name) => !name.startsWith("architect_") && presetWithholds(MANAGED_TOOL_PRESET, name));
}
