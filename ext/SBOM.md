# Software and libraries

Rules for adding software, the licence policy, the toolchain and the major dependencies. The exact versions are in upstream's `package.json` and `package-lock.json`; Dependabot (`.github/dependabot.yml`, from upstream) proposes updates. Process is in [SDLC](SDLC.md), design limits in [SPEC](design/SPEC.md) §17.3. Status: 2026-11-15 14:43.

## Rules

- **Use what upstream ships** before adding anything. SPEC §17.3 lists what the initial release doesn't add: LangChain or LangGraph, a new web framework, a Python planner, Neo4j, a standalone vector database, a general constraint solver.
- **A new dependency earns its place:** the PR names what it does that existing code can't, its licence, its size and its maintenance state, and adds it to the table below.
- **Heavy evaluators stay out of the base install.** Optional ML evaluators run in a separately installed environment (SPEC §17.3).
- **Pinned and locked:** dependencies come from `package-lock.json` via `npm ci`; nothing is installed from an unpinned `latest`.
- **Upstream's dependency changes** arrive with upstream syncs and are reviewed there, not changed independently.

## Licence policy

- The repository is MIT (GAPS Q4).
- **Allowed:** MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, and comparable permissive licences.
- **Not allowed** in shipped code: GPL, AGPL, SSPL, BUSL, Elastic, and licences that restrict use.
- **Optional provider SDKs** under vendor terms (see below) are installed on the user's machine as optional dependencies, as upstream does; the fork doesn't redistribute them.
- **Model weights, node packs and templates** carry their own licences, recorded with their provenance in the catalog (SPEC §8, §17.4); the repository's licence settles nothing about them.

## Toolchain

| Tool | Version | Note |
| --- | --- | --- |
| Node.js | ≥ 22 (`engines`); CI runs 22 | The development machine runs 26.13.0 |
| npm | the one bundled with Node | 11.20.0 on the development machine |
| TypeScript | ^7.0.2 | `tsc --noEmit` is `npm run lint` |
| Vitest | ^4.1.11 | `npm test` runs `scripts/run-checks.mjs` |
| tsx | ^4.23.12 | `npm run dev`, scripts |

## Major dependencies

From upstream at the baseline ([input/BASE](input/BASE.md)); licences read from the installed packages on 2026-11-15.

| Package | Range | Licence | Used for |
| --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` | ~1.32.1 | MIT | MCP server and transports |
| `zod` | ^4.0.0 | MIT | Schemas; Architect's contracts |
| `better-sqlite3` | ^13.0.3 | MIT | Upstream's databases; `architect.db` |
| `yaml` | ^2.9.0 | ISC | Recipes and rules |
| `ws`, `undici` | ^8.21.3, 7.29.0 | MIT | ComfyUI WebSocket and HTTP |
| `sharp` | ^0.35.3 | Apache-2.0 | Image processing; output checks |
| `@comfyorg/sdk`, `@stable-canvas/comfyui-client` | ^0.1.7, ^1.5.9 | MIT | ComfyUI clients |
| `dotenv` | ^17.4.2 | BSD-2-Clause | Configuration |
| `@ai-sdk/*`, `ai` (optional) | ^4, ^7 | Apache-2.0 | HTTP provider backends |
| `@openai/codex` (optional) | 0.162.1 | Apache-2.0 | Codex backend |
| `@anthropic-ai/claude-agent-sdk` (optional) | ^0.3.296 | Vendor terms (see its README) | Claude backend |
| `@aws-sdk/client-s3`, `@azure/storage-blob` (optional) | ^3, ^12 | Apache-2.0, MIT | Output storage |
| `cloudflared` (optional) | ^0.7.3 | MIT | Tunnels |

Architect adds no dependency yet.
