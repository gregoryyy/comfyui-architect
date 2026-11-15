# Baseline

The upstream commit the fork is built on, and what has been checked against it. A newer baseline comes only through an upstream sync ([AGENTS](../../AGENTS.md#process)), and each sync adds a section on top. Status: 2026-11-15 17:05.

## Current baseline: `707474d2` (v0.52.206)

| | |
| --- | --- |
| Repository | [`artokun/comfyui-mcp`](https://github.com/artokun/comfyui-mcp) |
| Commit | `707474d24d0d251ba04a1bebdf86620cef2eaa8b`, 2026-11-04 02:40, "fix(3002): get_image names workable remedies when a video /view fetch is refused or stalls (#3003)" |
| Package version | `0.52.206` |
| Pinned since | 2026-11-15 12:54 (fork created) |
| Spec inspected the same commit | Yes (spec source [S1]) |

### Checks run

Recorded on 2026-11-15 on the owner's macOS workstation, Node from the local install, with ComfyUI reachable on port 8188.

| Check | Result |
| --- | --- |
| `npm ci` | Passed |
| `npm run lint` (`tsc --noEmit`) | Passed, 0.7 s |
| `npm run check:vocabulary` | Passed: 1,929 files scanned, 160 retired names in the ledger, no live references (with `ext/` present) |
| `npm run check:unknown-collapse` | Passed: no new collapses |
| `npm run build` | Passed |
| `npm test` (Vitest, 798 files) | Doesn't finish locally: `services/bridge-port-reclaim.test.ts` hangs, on `707474d2` as well. The other 797 files: 14,679 tests, **14 baseline failures** in six files, the same on `707474d2` and on `feat/milestone-1`: `orchestrator/install-accepted-never-enqueued` (9), `orchestrator/install-node-git-expectation`, `orchestrator/confirm-late-answer-recovery`, `services/divergent-install-reachable`, `services/ui-bridge`, `tools/stale-note-route-aware` (1 each). Not investigated; several wait on real timeouts, and a ComfyUI Desktop listens on 8188 |
| `asset-counts --check`, `vocab:export -- --check` | Passed (38 core, 96 panel, 160 retired names) |
| `docs:gen` | No-op: 16 pages, 38/38 tools |
| `scripts/smoke-install.mjs` (pack and install) | Passed: 38 core tools plus 3 compact-mode tools, 96 panel tools |
| `npm run test:integration` | Not run yet (TODO 1.1.3) |

### Baseline facts for the fork

- **The bridge leaves about half of all panel hellos unanswered** (6 of 10 within 5 s on 2026-11-15; answered ones take under 50 ms), so the panel's 1.2 s status probe flips between "running" and "port held by another process" ([research](../research/panel-connection.md#observed-with-the-panel-installed)). Cause not investigated.
- **Size:** about 238,000 lines of TypeScript source and 304,000 lines of tests in 795 test files.
- **Hotspot:** `src/orchestrator/panel-tools.ts`, 31,000 lines, touched by 143 of the last 500 source commits. Avoid editing it; conflicts there are the most likely on a sync.
- **Activity:** 2,045 commits in August 2026, 61 in October, 1 in November up to the baseline.
- **No external tool registration:** `src/tools/index.ts` registers a fixed set; the panel agent picks up other MCP servers only on the Claude backend (`backendInheritsUserMcpServers` in `src/services/user-mcp-config.ts`).
- **Tool policy is per tool:** `src/tools/tool-surface-filter.ts` filters whole tools by environment configuration and states that per-action policy is deliberately not attempted.
- **Hardcoded package name:** `PACKAGE_NAME = "comfyui-mcp"` in `src/services/self-update.ts`.
- **Ignored agent files:** upstream's `.gitignore` excludes `/AGENTS.md`, `/CLAUDE.md` and `.claude/`.
- **CI leftover:** `.github/workflows/ci.yml` keeps the comment of the Oxlint gate removed in `1d5b12b1` (#2928), with no step under it. Harmless; a candidate for an upstream fix.
