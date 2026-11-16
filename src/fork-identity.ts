// ComfyUI Architect's identity as a fork of artokun/comfyui-mcp.
//
// One place for what the fork is and which upstream it is built on, so the startup
// handshake, the Architect tools and the docs can't disagree (spec §18.2: the fork
// identifies itself at connection time, and a stock upstream connection must never look
// Architect-enabled).
//
// The npm package name, the command and the MCP server name are still upstream's
// `comfyui-mcp`: renaming them reaches the plugin launcher, the panel launcher,
// self-restart, agent setup and about twenty-five other upstream files, so it waits for
// GAPS Q11. Until then this module states the intended names and the handshake reports
// the fork alongside the unchanged upstream ones.

/** The pinned upstream baseline. Keep in step with dev/input/BASE.md (a test checks it). */
export const UPSTREAM_BASELINE = Object.freeze({
  repository: "artokun/comfyui-mcp",
  commit: "707474d24d0d251ba04a1bebdf86620cef2eaa8b",
  version: "0.52.206",
});

/** Version of the Architect record schemas (spec §7: every stored record carries it). */
export const ARCHITECT_SCHEMA_VERSION = 1;

export const FORK_IDENTITY = Object.freeze({
  product: "ComfyUI Architect",
  /** The fork's own semantic version (GAPS Q3); package.json keeps upstream's until Q11. */
  version: "0.1.0",
  repository: "gregoryyy/comfyui-architect",
  /** Intended names (GAPS Q2), applied once GAPS Q11 settles the rename's scope. */
  intended: Object.freeze({
    packageName: "@gregoryyy/comfyui-architect",
    command: "comfyui-architect",
    mcpName: "io.github.gregoryyy/comfyui-architect",
  }),
  upstream: UPSTREAM_BASELINE,
  schemaVersion: ARCHITECT_SCHEMA_VERSION,
});

/** The upstream commit, shortened as git shows it. */
export function upstreamShortCommit(): string {
  return UPSTREAM_BASELINE.commit.slice(0, 8);
}

/**
 * One line for the MCP handshake: product, fork version, upstream build, and whether the
 * Architect tools are on. Kept short; it is appended to upstream's instructions, which
 * have their own byte budget.
 */
export function forkHandshakeLine(architectOn: boolean): string {
  return (
    `Fork: ${FORK_IDENTITY.product} ${FORK_IDENTITY.version} ` +
    `(upstream comfyui-mcp ${UPSTREAM_BASELINE.version} @${upstreamShortCommit()}); ` +
    `Architect tools ${architectOn ? "on (architect_*)" : "off"}.`
  );
}

/** `serverInfo.title` for MCP clients that show it. */
export function forkServerTitle(): string {
  return `${FORK_IDENTITY.product} ${FORK_IDENTITY.version} (fork of comfyui-mcp ${UPSTREAM_BASELINE.version})`;
}
