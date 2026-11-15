# Architecture

The architecture to be built and the log of architectural decisions. The architecture itself is in [SPEC](design/SPEC.md); this file maps it, records what has been decided since, and lists the decisions still open (GAPS Q1: SEC, ARCH and EVAL only add what SPEC doesn't say). Security is in [SEC](SEC.md), evaluations in [EVAL](EVAL.md). Status: 2026-11-15 17:05.

## Map

| Topic | Where |
| --- | --- |
| Components and execution ownership | SPEC §5: clients, agent session, Architect tools, Architect domain, upstream facade, existing infrastructure, persistence |
| Domain contracts | SPEC §7, generalised to every kind of workflow (decision log, 2026-11-15) |
| Catalog and knowledge model | SPEC §8 |
| Planning and ranking | SPEC §9 |
| Compilation and validation | SPEC §10 |
| Resources and scheduling | SPEC §11 |
| Providers and privacy | SPEC §12 |
| Execution and evaluation | SPEC §13 |
| Policy and trust boundaries | SPEC §14, [SEC](SEC.md) |
| Persistence and state | SPEC §15 |
| Tool surface and internal API | SPEC §16, [STYLE](STYLE.md#mcp-tools) |
| Repository layout and fork maintenance | SPEC §17, [AGENTS](../AGENTS.md#layout), [input/BOOT](input/BOOT.md#fork-specifics) |
| Configuration and deployment | SPEC §18 |

## Principles

The design rules in [AGENTS](../AGENTS.md#design-rules) are the principles: Architect off means upstream; upstream only through the facade; models propose and the core decides; unknown is never pass; execution never destroys unrelated work.

## Upstream footprint

Every upstream file the fork changes, and why. Changing any other upstream file needs a decision recorded in DONE and the PR ([SDLC](SDLC.md#definition-of-done)). The list started in [input/BOOT](input/BOOT.md#fork-specifics) and is kept here.

| File | Change | Since |
| --- | --- | --- |
| `LICENSE` | The fork's copyright line (GAPS Q4) | PR #2 |
| `src/tools/index.ts` | One import and two calls: the Architect group registers after upstream's groups, in `registerAllTools` and in `collectToolCatalog`, only when `COMFYUI_ARCHITECT` is on | TODO 1.7 |
| `src/boot.ts` | One import block, `serverInfo.title`, and a line appended to the stdio handshake instructions naming the fork (`src/fork-identity.ts`). The line is concatenated so the source still reads `instructions: STDIO_HANDSHAKE_INSTRUCTIONS…`, which `handshake-instructions.test.ts` checks as text | TODO 1.4 |
| `src/orchestrator/ready-banner.ts` | `readyBannerText` wraps upstream's function, renamed `upstreamReadyBannerText`, and appends the fork's line when `COMFYUI_ARCHITECT` is on; both greeting paths (first banner and the #376 correction) pass through it, and the call sites in `src/orchestrator/index.ts` stay as `ui-bridge-locale.test.ts` reads them | TODO 1.12 |
| `src/services/panel-secrets.ts` | `buildComfyuiMcpEnv` forwards `COMFYUI_ARCHITECT` to the panel agent's tool server, after upstream's tool-policy variables, outside the window `tool-surface-filter.test.ts` reads | TODO 1.12 |
| `.github/pull_request_template.md` | New file; upstream has none | PR #3 |
| Planned with the rename (GAPS Q11) | `package.json`, `package-lock.json`, `src/services/self-update.ts`, `server.json`, `.claude-plugin/marketplace.json`, and whatever else Q11's answer includes | TODO 1.3 |
| Planned when Architect tools are on by default | upstream's `README.md` tool counts, `docs/tools/` pages and `scripts/gen-tool-docs.ts` categories, `docs/design/tool-vocabulary.json`, `src/tools/vocabulary.ts` | Later |

Untouched on purpose: `src/config.ts` (Architect reads its flag in `src/services/architect/config.ts`), `src/handshake-instructions.ts` (the fork line is appended in `boot.ts`, so upstream's byte budget and its test stay as they are), and `src/orchestrator/panel-tools.ts`.

## Decision log

Newest first. Each entry: date, decision, reason, where it's recorded.

| Date | Decision | Reason | Recorded in |
| --- | --- | --- | --- |
| 2026-11-15 | The skill and the command live in `architect/skills/comfyui-architect/SKILL.md` and `architect/commands/architect.md` and reach clients as MCP prompts registered with the Architect tools, so only while the flag is on; they move into `plugin/skills/` and `plugin/commands/` when Architect is on by default | A file in `plugin/skills/` or `plugin/commands/` is visible with the flag off and changes the counts in upstream's README and `docs/plugin.mdx` (`asset-counts --check`), against AT-12; `boot.ts` already declares the prompts capability | TODO 2.7 |
| 2026-11-15 | Exports go to `ARCHITECT_DATA_DIR/artifacts/<task-id>/<plan-id>/`; the compiled graph isn't stored, it's compiled again from recipe and bindings on `get` and `export` and must match the candidate's fingerprint | Plan IDs are unique where task revisions aren't (several plans per revision); recompiling keeps one source of truth and detects a recipe that changed underneath | TODO 2.6.3 |
| 2026-11-15 | Milestone 2 contracts in `src/services/architect/schemas.ts`: `TaskSpec` carries the kind-specific part in `media`, a union discriminated by `kind` with only `image` so far; `Recipe` slots write node inputs and say where values come from (`fromTask`, model folder); `PlanCandidate` keeps bindings, compiled-graph fingerprint, role map, layered validation report, dependency delta and an unknown resource estimate; `parseStored` reads stored records with step-wise upgrades and refuses newer versions | Kind-neutral core records (AGENTS); spec §7, §9, §10; a resource number nobody measured would be invented (spec §9.3) | TODO 2.1 |
| 2026-11-15 | `architect.db` lives in `ARCHITECT_DATA_DIR`, default `<COMFYUI_MCP_DATA_DIR or ~/.comfyui-mcp>/architect/`, opened with WAL and foreign keys like upstream's `generations.db`; migrations are numbered and in code. Milestone 2 creates `schema_migrations`, `tasks`, `task_revisions`, `environments`, `catalog_sources`, `recipes`, `plans` and `plan_candidates`; the other spec §15.2 tables come with the milestones that use them | Next to upstream's data, never inside the ComfyUI install (upstream #872); tables only when something writes them | TODO 2.2 |
| 2026-11-15 | Recipes are JSON files validated by the `Recipe` schema: shipped ones in `architect/recipes/`, test fixtures under `src/__tests__/architect/fixtures/` with certification `fixture`, never offered from the shipped catalog | JSON hashes deterministically and holds API graphs as they are; fixtures let the pipeline be tested before GAPS Q12 picks families | TODO 2.4 |
| 2026-11-15 | Milestone 2 compiles and exports the API-format graph only; the UI graph (spec §10.4) comes with the first certified recipe, from its original UI template | The API graph is the execution authority; a UI graph built without a template would claim a round trip nobody tested | TODO 2.6 |
| 2026-11-15 | Candidates rank by evidence tier (certified, curated, fixture), then by dependency delta; no quality or resource numbers until runs measure them | Spec §9.3 allows ordered evidence tiers and forbids fabricated scores | TODO 2.5 |
| 2026-11-15 | Architect is switched on by the environment variable `COMFYUI_ARCHITECT` (`1`, `true`, `yes`, `on`), read in `src/services/architect/config.ts`; off by default | Keeps `src/config.ts` untouched; one place to read it; off means upstream | TODO 1.5 |
| 2026-11-15 | The fork identifies itself through `src/fork-identity.ts`, `serverInfo.title` and a handshake line, while package, command and server name stay `comfyui-mcp` pending GAPS Q11 | Identity without touching launch paths; `boot-server-version.test.ts` pins the server name | TODO 1.4 |
| 2026-11-15 | The first local planner profile is upstream's default `artokun/gemma4-comfyui-mcp:e4b`, named in configuration | Fastest start with a model trained on the tool suite; SPEC §12.3 forbids hardcoding a best model in code | GAPS Q9, TODO 1.2.2 |
| 2026-11-15 | The three fork seams (panel-agent tool registration on every backend, per-action policy, pausing the agent loop) are built upstreamable; the offer is decided after ROAD phase 1 | Keeps the option of shrinking the fork to an add-on package | GAPS Q8 |
| 2026-11-15 | The panel fork starts in ROAD phase 4 | The stock panel's chat and choice controls are enough until managed execution has a UI need | GAPS Q7 |
| 2026-11-15 | GitHub Actions on, `release.yml` and `mcp-registry.yml` disabled | CI on PRs at no cost; no accidental publish under upstream's identity | GAPS Q6, TODO 1.9 |
| 2026-11-15 | Reference target: the source install at `~/Documents/opt/flux/ComfyUI` on an Apple M5 Pro with 48 GB unified memory | The owner's choice; unified memory makes shared-memory scheduling (SPEC §11.3) relevant from the first run | GAPS Q5, TODO 1.2.1 |
| 2026-11-15 | MIT for everything; the fork's copyright line in `LICENSE` | One licence keeps contributions back upstream simple | GAPS Q4 |
| 2026-11-15 | Own semantic version from 0.1.0; upstream commit and version in build metadata and the handshake | Versions that don't collide with upstream's and don't change on every sync | GAPS Q3, TODO 1.3 |
| 2026-11-15 | Package `@gregoryyy/comfyui-architect`, command `comfyui-architect`, MCP name `io.github.gregoryyy/comfyui-architect` | Never shadows an upstream install; npm's `comfyui-mcp` is upstream's | GAPS Q2, TODO 1.3 |
| 2026-11-15 | `ext/design/SPEC.md`, a working copy of the frozen input spec, is the design authority | Avoids rewriting 1,000 lines into standard documents; the input stays as the record | GAPS Q1 |
| 2026-11-15 | Contracts work for every kind of workflow; images are the MVP's certified scope | The product covers every kind of ComfyUI workflow; kind-specific fields live in recipes, resource profiles and evaluators, so new kinds need no core migration | IDEA, AGENTS (scope), ROAD phase 6 |
| 2026-11-15 | The product is called ComfyUI Architect; the repository is `gregoryyy/comfyui-architect` | Owner's naming | DONE |
| 2026-11-15 | `ext/` is the project's docs folder; `ext/input/` holds bootstrap material | Upstream's `docs/` is its published site, checked by upstream's gates | input/BOOT, AGENTS |
| 2026-11-15 | The fork stays public | A fork of a public repository can't be private; free Actions; direct PRs upstream | DONE |
| 2026-11-15 | A fork rather than an add-on package | Upstream gives the panel agent other MCP servers only on the Claude backend, filters policy per tool, and has no hook to pause the agent loop | DONE, input/BASE |

## Open decisions

| Decision | Needed by | Tracked |
| --- | --- | --- |
| The first certified model families (2–3); until then milestone 2 runs on fixture recipes and ships none | TODO 2.4 | GAPS Q12 |
| The kind of workflow after images | ROAD phase 6 | GAPS Q10, decided after the MVP |
| How far the rename reaches, and with it the fork's package version (upstream's version checks apply to the panel's version, not the server's; A9) | TODO 1.3 | GAPS Q11 |
