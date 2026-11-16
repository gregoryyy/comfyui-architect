import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ARCHITECT_SCHEMA_VERSION,
  FORK_IDENTITY,
  UPSTREAM_BASELINE,
  forkHandshakeLine,
  forkServerTitle,
  upstreamShortCommit,
} from "../../fork-identity.js";

describe("fork identity", () => {
  // TODO 1.3.4: the code and dev/input/BASE.md must name the same upstream commit, or a
  // bug report quotes a baseline the docs don't record.
  it("names the upstream commit recorded as the current baseline in dev/input/BASE.md", () => {
    const base = readFileSync(new URL("../../../dev/input/BASE.md", import.meta.url), "utf-8");
    const current = base.split(/^## /m).find((s) => s.startsWith("Current baseline"));
    expect(current, "BASE.md has a 'Current baseline' section").toBeDefined();
    expect(current).toContain(UPSTREAM_BASELINE.commit);
    expect(current).toContain(UPSTREAM_BASELINE.version);
  });

  it("keeps package.json's version as upstream's until the rename is decided (GAPS Q11)", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf-8")) as {
      version: string;
    };
    expect(pkg.version).toBe(UPSTREAM_BASELINE.version);
    expect(FORK_IDENTITY.version).not.toBe(pkg.version);
  });

  it("reports product, fork version, upstream version and commit in the handshake line", () => {
    const off = forkHandshakeLine(false);
    expect(off).toContain(FORK_IDENTITY.product);
    expect(off).toContain(FORK_IDENTITY.version);
    expect(off).toContain(UPSTREAM_BASELINE.version);
    expect(off).toContain(upstreamShortCommit());
    expect(off).toContain("Architect tools off");
    expect(forkHandshakeLine(true)).toContain("Architect tools on (architect_*)");
  });

  // The line is appended to upstream's stdio instructions, which carry a 2048-byte budget
  // of their own; keep the fork's share small.
  it("keeps the handshake line under 160 bytes", () => {
    expect(Buffer.byteLength(forkHandshakeLine(true), "utf8")).toBeLessThan(160);
  });

  it("titles the server as a fork without changing upstream's server name", () => {
    expect(forkServerTitle()).toContain("fork of comfyui-mcp");
    expect(ARCHITECT_SCHEMA_VERSION).toBe(1);
  });
});
