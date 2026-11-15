import { afterEach, describe, expect, it } from "vitest";
import { ARCHITECT_FLAG_ENV } from "../../services/architect/config.js";
import { ARCHITECT_CATEGORY } from "../../tools/architect.js";

// Architect off means upstream (spec AT-12): with the flag off, no Architect tool is
// registered on any route and the catalog has no Architect category. With the flag on,
// the group goes through the same policy-filtered registrar as upstream's tools, so the
// compact call_tool route and the operator's deny list cover it too (spec §14.3).

const touched = [ARCHITECT_FLAG_ENV, "COMFYUI_MCP_TOOL_DENY"] as const;
const saved = new Map<string, string | undefined>(touched.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of touched) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function catalog() {
  const { collectToolCatalog } = await import("../../tools/index.js");
  return collectToolCatalog();
}

function names(cat: Awaited<ReturnType<typeof catalog>>): string[] {
  return [...cat.byCategory().values()].flat().map((t) => t.name);
}

describe("Architect tool registration", () => {
  it("registers nothing when the flag is off", async () => {
    delete process.env[ARCHITECT_FLAG_ENV];
    const cat = await catalog();
    expect(names(cat).filter((n) => n.startsWith("architect_"))).toEqual([]);
    expect(cat.byCategory().has(ARCHITECT_CATEGORY)).toBe(false);
  });

  it("leaves upstream's tool list unchanged when the flag is off", async () => {
    delete process.env[ARCHITECT_FLAG_ENV];
    const off = names(await catalog());
    process.env[ARCHITECT_FLAG_ENV] = "1";
    const on = names(await catalog());
    expect(on.filter((n) => !n.startsWith("architect_"))).toEqual(off);
  });

  it("registers architect_inspect under its own category when the flag is on", async () => {
    process.env[ARCHITECT_FLAG_ENV] = "1";
    const cat = await catalog();
    const tool = cat.get("architect_inspect");
    expect(tool?.category).toBe(ARCHITECT_CATEGORY);
    expect(tool?.description).toContain("read-only");
  });

  it("is withheld by the operator's deny list like any upstream tool", async () => {
    process.env[ARCHITECT_FLAG_ENV] = "1";
    process.env.COMFYUI_MCP_TOOL_DENY = "architect_inspect";
    const cat = await catalog();
    expect(cat.get("architect_inspect")).toBeUndefined();
  });
});
