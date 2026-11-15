// The Architect tool group (spec §16.1). Registered only when the Architect flag is on, and
// always through upstream's registrar, so the tool-surface policy and compact `call_tool`
// cover it like any other tool (spec §14.3).
//
// Phase 0 has one read-only tool, `architect_inspect`, with one action. Its description is
// prompt text for models: English, exact, and not translated (STYLE, MCP tools).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { architectEnabled } from "../services/architect/config.js";
import { ArchitectService, defaultDeps } from "../services/architect/service.js";
import { createUpstreamFacade } from "../services/architect/upstream.js";

/** The category the compact surface lists Architect tools under. */
export const ARCHITECT_CATEGORY = "architect";

export function registerArchitectTools(
  server: McpServer,
  service: ArchitectService = new ArchitectService(defaultDeps(createUpstreamFacade())),
): void {
  server.tool(
    "architect_inspect",
    "ComfyUI Architect: read-only inspection of the connected ComfyUI target. " +
      'action:"environment" returns a snapshot: ComfyUI and Python versions, OS, RAM, ' +
      "compute devices with their memory, the number of loaded node classes and a digest " +
      "of their names. A probe that fails is listed in `probeErrors` and its fields are " +
      "absent: treat them as unknown, never as empty. No downloads, installs or executions.",
    {
      action: z
        .enum(["environment"])
        .describe('What to inspect. "environment": the target\'s versions, hardware and node classes.'),
    },
    async () => {
      const envelope = await service.inspectEnvironmentEnvelope();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
        ...(envelope.status === "error" ? { isError: true } : {}),
      };
    },
  );
}

/**
 * The seam in upstream's registration (src/tools/index.ts): registers the group when the
 * flag is on and does nothing otherwise, so Architect off leaves upstream's surface as it
 * is (spec AT-12).
 */
export function registerArchitectToolGroup(server: McpServer, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!architectEnabled(env)) return false;
  registerArchitectTools(server);
  return true;
}

/** The skill and command texts, shipped in `architect/` at the package root (TODO 2.7). */
const ARCHITECT_TEXT_DIR = fileURLToPath(new URL("../../architect/", import.meta.url));

/** A markdown file without its YAML front matter, or undefined when it can't be read. */
function readMarkdownBody(relPath: string): string | undefined {
  try {
    const text = readFileSync(join(ARCHITECT_TEXT_DIR, relPath), "utf-8");
    return text.replace(/^---\n[\s\S]*?\n---\n+/, "");
  } catch {
    return undefined;
  }
}

/**
 * MCP prompts for the skill and the `/architect` command (TODO 2.7), only while the flag is
 * on. Files in `plugin/` would be visible with the flag off and change upstream's README
 * counts (spec AT-12), so the texts reach clients this way until Architect is on by
 * default. Returns whether any prompt was registered: upstream's boot installs its empty
 * prompts/list handler only when none was, because the SDK allows one handler per method.
 */
export function registerArchitectPrompts(server: McpServer, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!architectEnabled(env)) return false;
  const skill = readMarkdownBody("skills/comfyui-architect/SKILL.md");
  const command = readMarkdownBody("commands/architect.md");
  if (skill === undefined || command === undefined) return false;
  server.registerPrompt(
    "architect",
    {
      title: "Plan a workflow with ComfyUI Architect",
      description: "Plan a ComfyUI workflow for a task from installed models and curated recipes, without downloads or renders.",
      argsSchema: { task: z.string().describe("What to make, in the user's words.") },
    },
    ({ task }) => ({
      messages: [
        { role: "user" as const, content: { type: "text" as const, text: `${command.replace("$ARGUMENTS", task)}\n\n---\n\n${skill}` } },
      ],
    }),
  );
  server.registerPrompt(
    "architect_skill",
    {
      title: "ComfyUI Architect: how to plan",
      description: "The planning guide for the architect_* tools: call order, what an agent may supply, how to read verdicts and blockers.",
    },
    () => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: skill } }] }),
  );
  return true;
}
