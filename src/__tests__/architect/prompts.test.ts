import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerArchitectPrompts } from "../../tools/architect.js";

async function connected(env: NodeJS.ProcessEnv): Promise<{ client: Client; registered: boolean }> {
  const server = new McpServer({ name: "t", version: "0" }, { capabilities: { prompts: {} } });
  const registered = registerArchitectPrompts(server, env);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, registered };
}

describe("the Architect prompts (TODO 2.7)", () => {
  it("aren't registered with the flag off, so upstream's empty prompt list stays", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    expect(registerArchitectPrompts(server, {})).toBe(false);
    expect(registerArchitectPrompts(server, { COMFYUI_ARCHITECT: "0" })).toBe(false);
  });

  it("list the command and the skill with the flag on", async () => {
    const { client, registered } = await connected({ COMFYUI_ARCHITECT: "1" });
    expect(registered).toBe(true);
    const names = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(names).toEqual(["architect", "architect_skill"]);
  });

  it("fill the task into the command and append the skill, without front matter", async () => {
    const { client } = await connected({ COMFYUI_ARCHITECT: "1" });
    const res = await client.getPrompt({ name: "architect", arguments: { task: "a red bicycle" } });
    const first = res.messages[0].content;
    const text = first.type === "text" ? first.text : "";
    expect(text).toContain("The user wants a workflow planned for this task: a red bicycle");
    expect(text).toContain("# Planning with ComfyUI Architect");
    expect(text).not.toMatch(/^---/);
    expect(text).not.toContain("$ARGUMENTS");
  });
});
