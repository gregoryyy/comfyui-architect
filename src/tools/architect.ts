// The Architect tool group (spec §16.1). Registered only when the Architect flag is on, and
// always through upstream's registrar, so the tool-surface policy and compact `call_tool`
// cover it like any other tool (spec §14.3).
//
// Phase 0 has one read-only tool, `architect_inspect`, with one action. Its description is
// prompt text for models: English, exact, and not translated (STYLE, MCP tools).

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
