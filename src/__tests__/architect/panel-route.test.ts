import { afterEach, describe, expect, it } from "vitest";
import { architectGreetingLine, withArchitectGreeting } from "../../services/architect/panel.js";
import { readyBannerText } from "../../orchestrator/ready-banner.js";
import { buildComfyuiMcpEnv } from "../../services/panel-secrets.js";
import { UPSTREAM_BASELINE, upstreamShortCommit } from "../../fork-identity.js";
import { ARCHITECT_ENV_KEYS, architectChildEnv } from "../../services/architect/config.js";

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

  it("receives ARCHITECT_DATA_DIR and the freshness setting, so both routes share one architect.db", () => {
    process.env.ARCHITECT_DATA_DIR = "/tmp/architect-test";
    process.env.ARCHITECT_ENV_MAX_AGE_SECONDS = "60";
    try {
      const env = buildComfyuiMcpEnv({ COMFYUI_URL: "http://127.0.0.1:8190" });
      expect(env.ARCHITECT_DATA_DIR).toBe("/tmp/architect-test");
      expect(env.ARCHITECT_ENV_MAX_AGE_SECONDS).toBe("60");
    } finally {
      delete process.env.ARCHITECT_DATA_DIR;
      delete process.env.ARCHITECT_ENV_MAX_AGE_SECONDS;
    }
  });

  it("forwards every Architect variable and no other", () => {
    const all = Object.fromEntries(ARCHITECT_ENV_KEYS.map((k) => [k, "1"]));
    expect(architectChildEnv({ ...all, PATH: "/bin", HF_TOKEN: "secret" })).toEqual(all);
    expect(architectChildEnv({ COMFYUI_ARCHITECT: "" })).toEqual({});
  });

  it("doesn't receive it when the orchestrator runs with the flag off", () => {
    delete process.env.COMFYUI_ARCHITECT;
    expect("COMFYUI_ARCHITECT" in buildComfyuiMcpEnv({ COMFYUI_URL: "http://127.0.0.1:8190" })).toBe(false);
  });
});
