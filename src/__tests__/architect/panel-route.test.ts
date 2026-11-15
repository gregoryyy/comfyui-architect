import { afterEach, describe, expect, it } from "vitest";
import { architectGreetingLine, withArchitectGreeting } from "../../services/architect/panel.js";
import { readyBannerText } from "../../orchestrator/ready-banner.js";
import { buildComfyuiMcpEnv } from "../../services/panel-secrets.js";
import { UPSTREAM_BASELINE, upstreamShortCommit } from "../../fork-identity.js";

const saved = process.env.COMFYUI_ARCHITECT;
afterEach(() => {
  if (saved === undefined) delete process.env.COMFYUI_ARCHITECT;
  else process.env.COMFYUI_ARCHITECT = saved;
});

describe("the panel greeting", () => {
  it("is upstream's unchanged with the flag off (spec AT-12)", () => {
    delete process.env.COMFYUI_ARCHITECT;
    const text = readyBannerText("claude", "opus", "", "en");
    expect(text).toBe("🟢 comfyui-mcp agent ready — opus on your Claude subscription. Ask away.");
    expect(withArchitectGreeting("hello", {})).toBe("hello");
  });

  it("names the fork, its upstream and the flag with the flag on", () => {
    process.env.COMFYUI_ARCHITECT = "1";
    const text = readyBannerText("claude", "opus", "", "en");
    expect(text.startsWith("🟢 comfyui-mcp agent ready — opus")).toBe(true);
    expect(text.endsWith(`\n\n${architectGreetingLine()}`)).toBe(true);
    expect(architectGreetingLine()).toContain(`comfyui-mcp ${UPSTREAM_BASELINE.version} @${upstreamShortCommit()}`);
  });
});

describe("the panel agent's tool server", () => {
  // The orchestrator builds the child's environment instead of inheriting it, so a
  // variable it doesn't forward is absent over there (upstream #873).
  it("receives COMFYUI_ARCHITECT when the orchestrator has it", () => {
    process.env.COMFYUI_ARCHITECT = "1";
    expect(buildComfyuiMcpEnv({ COMFYUI_URL: "http://127.0.0.1:8190" }).COMFYUI_ARCHITECT).toBe("1");
  });

  it("doesn't receive it when the orchestrator runs with the flag off", () => {
    delete process.env.COMFYUI_ARCHITECT;
    expect("COMFYUI_ARCHITECT" in buildComfyuiMcpEnv({ COMFYUI_URL: "http://127.0.0.1:8190" })).toBe(false);
  });
});
