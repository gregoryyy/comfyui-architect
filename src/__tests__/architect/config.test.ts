import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  architectChildEnv,
  panelRunsAllowed,
  architectEnabled,
  architectMode,
  onPanelRoute,
} from "../../services/architect/config.js";
import { applyArchitectMode } from "../../services/architect/mode.js";
import { resolveToolSurfacePolicy, toolAllowed } from "../../tools/tool-surface-filter.js";

describe("Architect modes (GAPS Q21)", () => {
  it("reads off, assist and managed from the flag", () => {
    expect(architectMode({})).toBe("off");
    expect(architectMode({ COMFYUI_ARCHITECT: "" })).toBe("off");
    expect(architectMode({ COMFYUI_ARCHITECT: "0" })).toBe("off");
    for (const v of ["1", "true", "YES", " on "]) expect(architectMode({ COMFYUI_ARCHITECT: v })).toBe("assist");
    expect(architectMode({ COMFYUI_ARCHITECT: "Managed" })).toBe("managed");
    expect(architectEnabled({ COMFYUI_ARCHITECT: "managed" })).toBe(true);
  });

  it("managed mode applies upstream's readonly preset, which withholds rendering, installs and panel tools", () => {
    const env: NodeJS.ProcessEnv = { COMFYUI_ARCHITECT: "managed" };
    expect(applyArchitectMode(env)).toBe(true);
    expect(env.COMFYUI_MCP_TOOL_PRESET).toBe("readonly");
    const policy = resolveToolSurfacePolicy(env);
    for (const tool of ["enqueue_workflow", "generate_image", "download_model", "install_custom_node", "restart_comfyui", "queue", "panel_run"]) {
      expect(toolAllowed(tool, policy), tool).toBe(false);
    }
    for (const tool of ["architect_inspect", "architect_plan", "architect_run", "get_history", "get_system_stats"]) {
      expect(toolAllowed(tool, policy), tool).toBe(true);
    }
  });

  it("assist and off leave upstream's tools and the operator's preset alone", () => {
    for (const flag of [undefined, "1"]) {
      const env: NodeJS.ProcessEnv = flag ? { COMFYUI_ARCHITECT: flag } : {};
      expect(applyArchitectMode(env)).toBe(false);
      expect(env.COMFYUI_MCP_TOOL_PRESET).toBeUndefined();
    }
  });

  it("managed mode refuses an allow list that would re-admit a withheld tool", () => {
    expect(() => applyArchitectMode({ COMFYUI_ARCHITECT: "managed", COMFYUI_MCP_TOOL_ALLOW: "architect_run,get_history,enqueue_workflow" })).toThrow(/enqueue_workflow/);
    const env: NodeJS.ProcessEnv = { COMFYUI_ARCHITECT: "managed", COMFYUI_MCP_TOOL_ALLOW: "architect_run,get_history" };
    expect(applyArchitectMode(env)).toBe(true);
  });

  it("managed mode with an operator's looser preset refuses to start; readonly is kept as set", () => {
    expect(() => applyArchitectMode({ COMFYUI_ARCHITECT: "managed", COMFYUI_MCP_TOOL_PRESET: "safe" })).toThrow(/managed needs/);
    const env: NodeJS.ProcessEnv = { COMFYUI_ARCHITECT: "managed", COMFYUI_MCP_TOOL_PRESET: "readonly" };
    expect(applyArchitectMode(env)).toBe(false);
    expect(env.COMFYUI_MCP_TOOL_PRESET).toBe("readonly");
  });

  it("marks the panel agent's server so it never asks for approval by elicitation (GAPS Q20)", () => {
    const child = architectChildEnv({ COMFYUI_ARCHITECT: "managed" });
    expect(child).toEqual({ COMFYUI_ARCHITECT: "managed", ARCHITECT_ROUTE: "panel" });
    expect(onPanelRoute(child)).toBe(true);
    expect(onPanelRoute({})).toBe(false);
    expect(architectChildEnv({})).toEqual({});
  });

  it("allows runs on the panel route only with ARCHITECT_PANEL_RUNS=terminal, forwarded to the panel's server (GAPS Q22)", () => {
    expect(panelRunsAllowed({})).toBe(false);
    expect(panelRunsAllowed({ ARCHITECT_PANEL_RUNS: "off" })).toBe(false);
    expect(panelRunsAllowed({ ARCHITECT_PANEL_RUNS: "1" })).toBe(false);
    expect(panelRunsAllowed({ ARCHITECT_PANEL_RUNS: "elicitation" })).toBe(false);
    expect(panelRunsAllowed({ ARCHITECT_PANEL_RUNS: " Terminal " })).toBe(true);
    expect(architectChildEnv({ COMFYUI_ARCHITECT: "1", ARCHITECT_PANEL_RUNS: "terminal" })).toMatchObject({ ARCHITECT_PANEL_RUNS: "terminal", ARCHITECT_ROUTE: "panel" });
  });
});

describe("config.ts", () => {
  it("imports nothing, so upstream's panel-secrets.ts pulls no Architect module into tests that mock upstream's client", () => {
    const source = readFileSync(fileURLToPath(new URL("../../services/architect/config.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
