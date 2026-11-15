# ComfyUI Architect

Planning: ChatGPT: Product Architect/ComfyUI Workflow Architecture

## 1. Purpose

[ComfyUI Architect](./input/comfyui-architect-system-spec.md) is designed to turn a natural-language task into an executable ComfyUI workflow, taking account of quality targets, installed models, available templates, and compute and memory limits. Rather than simply generating graph JSON, it retrieves suitable workflow patterns, selects compatible components, compares feasible alternatives, and explains their quality, speed, and resource trade-offs. Missing models or dependencies can be proposed for download, subject to user approval.

The implementation extends a fork of **`artokun/comfyui-mcp`**, reusing its provider integrations, workflow tooling, model management, and execution infrastructure. ComfyUI Architect adds structured task specifications, a capability knowledge base, constraint-aware planning, and a bounded execution-and-evaluation loop. The same core serves external MCP clients and the ComfyUI sidebar, using local Ollama models or configured Claude, Codex, and API providers. Deterministic checks govern graph compatibility and permitted actions; test renders and user feedback establish whether the resulting workflow actually meets the intended outcome.

## 2. Implementation

The project follows gregoryyy's agentic coding project structure, as adapted in [BOOT](input/BOOT.md). `ext/` holds the project's documents, the role `docs/` plays elsewhere, because upstream's `docs/` is its published documentation site.

**Where things go.** The Architect code is additive and has its own directories next to upstream's:

| Path | Content |
| --- | --- |
| `ext/` | Project documents: this README, [BOOT](input/BOOT.md), [IDEA](IDEA.md), [GAPS](GAPS.md), [TODO](TODO.md), [ROAD](ROAD.md), [DONE](DONE.md), [SEC](SEC.md), [ARCH](ARCH.md), [EVAL](EVAL.md), [SDLC](SDLC.md), [SBOM](SBOM.md), [STYLE](STYLE.md), [SPEC](design/SPEC.md) (the design), [BASE](input/BASE.md), and the [spec](input/comfyui-architect-system-spec.md) as input |
| `src/services/architect/` | The Architect domain: task specs, catalog, planner, constraints, policy, resources, run controller, evaluation, store |
| `src/services/architect/upstream.ts` | The one facade through which the Architect code calls upstream services |
| `src/tools/architect.ts` | The MCP tools `architect_inspect`, `architect_plan`, `architect_run`, `architect_library` |
| `src/__tests__/architect/` | Unit, contract and integration tests |
| `architect/` | Curated recipes, compatibility rules and fixtures, shipped with the package |
| `plugin/skills/comfyui-architect/`, `plugin/commands/architect.md` | The Claude Code skill and slash command |

Everything else is upstream's. The paths follow the spec (§17.1). `src/services/architect/`, `src/tools/architect.ts` and `src/__tests__/architect/` exist since milestone 1, together with `src/fork-identity.ts`; `architect/` and the plugin skill come with milestone 2. The Architect tools are off unless `COMFYUI_ARCHITECT=1` is set.

**Stack and build.** Upstream's stack: TypeScript on Node 22, Zod, Vitest and SQLite. No new framework or service (spec §17.3). Upstream's npm scripts build and test it: `npm ci`, `npm run lint`, `npm run build`, `npm test`.

**Status.** Setup. The fork exists (`gregoryyy/comfyui-architect`, from upstream `707474d2`, v0.52.206), and the work happens on the `architect/spec` branch. The next milestone is spec Phase 0: a reproducible baseline, the fork's own package identity, and a feature flag that keeps Architect switched off by default.

## 3. Compatibility

The fork is meant to stay a superset of upstream: everything upstream does keeps working, and Architect is added next to it. The rules that keep it that way:

**Architect off means upstream.** With the feature flag off, the fork behaves like the upstream version it's based on: the same tools, actions, panel surface and outputs. Upstream's own test suite runs unchanged on every release candidate (spec AT-12). With the flag on, the four `architect_*` tools are added, and existing tool contracts stay as they are.

**Upstream files change only at named seams.** The Architect code calls upstream through one facade (`upstream.ts`) rather than editing upstream's modules. Upstream files change only where a hook is needed, or where upstream's own CI gates require it:
- the tool registration;
- the README tool counts and the generated tool pages;
- the package identity;
- the hardcoded package name in self-update.

The list is in [ARCH](ARCH.md#upstream-footprint). Changing a file outside it needs a recorded decision.

**Upstream updates come in by merge.** The pinned upstream commit is recorded in `ext/input/BASE.md`. To take a newer upstream:
1. Merge `upstream/main` into a sync branch.
2. Run upstream's suite and the Architect tests against it.
3. Merge the sync branch through a PR, and record the new baseline.

The fork never builds against an unpinned upstream `latest`.

**One server per ComfyUI.** The fork replaces upstream rather than running beside it. Both bind the same panel bridge port, so two servers on one ComfyUI would fight over the panel. MCP clients are configured to launch the fork's build, not `npx comfyui-mcp`. The fork has its own package name, so self-update and installs never pull upstream over it.

**The panel is upstream's, unchanged.** The sidebar comes from the separate `comfyui-mcp-panel` project. The stock panel works with the fork through its existing chat and choice controls. Its autospawn is switched off (`COMFYUI_MCP_NO_AUTOSPAWN=1`), so it connects to the fork instead of launching upstream. At connection time, the fork identifies itself and its Architect capabilities, so a stock upstream connection never looks Architect-enabled. Richer panel UI (candidate cards, approvals, graph diffs) would come later as a small companion panel change (spec §3.2, Phase 4).

**Data stays separate.** Architect keeps its own `architect.db` and artifact directory. Upstream's generation history and configuration aren't modified, and model weights are referenced, not copied (spec §15.1).

**Generic fixes go back upstream.** Fixes and hooks that would help upstream regardless of Architect are kept in separate commits and offered upstream as PRs. If upstream ever adopts extension points for tool registration, per-action policy and agent pausing, Architect could shrink from a fork to an add-on package.

Open points: the fork's package name and version scheme, and whether the CLI keeps upstream's `comfyui-mcp` command name. These go to GAPS.

