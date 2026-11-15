// What the fork adds on the panel route (TODO 1.12). The stock panel reads no server
// identity from the bridge, so the ready greeting is the one place a panel user sees which
// server answered (spec §3.2, point 2). With the flag off, the greeting stays upstream's
// (spec AT-12).

import { FORK_IDENTITY, UPSTREAM_BASELINE, upstreamShortCommit } from "../../fork-identity.js";
import { architectEnabled } from "./config.js";

/** The line the panel shows under upstream's ready greeting while the flag is on. Not
 *  translated: it names a product, versions and a commit. */
export function architectGreetingLine(): string {
  return (
    `${FORK_IDENTITY.product} ${FORK_IDENTITY.version} ` +
    `(fork of comfyui-mcp ${UPSTREAM_BASELINE.version} @${upstreamShortCommit()}): Architect tools on.`
  );
}

/** Upstream's ready greeting, with the fork's line appended when the flag is on. */
export function withArchitectGreeting(greeting: string, env: NodeJS.ProcessEnv = process.env): string {
  return architectEnabled(env) ? `${greeting}\n\n${architectGreetingLine()}` : greeting;
}
