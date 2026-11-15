# TODO

The plan: milestones (`## 1.`), tasks (`1.1`) and subtasks (`1.1.1`) with checkboxes. Numbers never change; new work gets new numbers. *(decision)* marks a choice to settle before dependent work starts, *(variant)* an alternative built for comparison. When an item is done, tick it here and add an entry to [DONE](DONE.md); the process is in [AGENTS](../AGENTS.md#process). Phases beyond the current milestones are in [ROAD](ROAD.md), questions for the owner in [GAPS](GAPS.md). Status: 2026-11-15 19:03.

Goal: the spec's first usable MVP, an approved candidate that executes locally and records its outcome (ROAD phase 2). Milestone 1 is spec Phase 0, milestone 2 spec Phase 1. Spec section numbers (§) refer to [SPEC](design/SPEC.md).

## 0. Project setup and initial inputs

The steps of [BOOT](input/BOOT.md), on 2026-11-15.

- [x] 0.1 Collect the input: the spec v1.0 in `ext/input/`
- [x] 0.2 Assess it and state the idea: [IDEA](IDEA.md), [GAPS](GAPS.md); the fork assessment in the first DONE entry
- [x] 0.3 Design concept and security
  - [x] 0.3.1 `AGENTS.md`, `CLAUDE.md` at the root, force-added past upstream's `.gitignore`
  - [x] 0.3.2 The design authority according to GAPS Q1: [SPEC](design/SPEC.md), a working copy of the input spec
  - [x] 0.3.3 [SEC](SEC.md): from spec §14, plus what the fork brings: the public repository, upstream's HTTP transport and tunnel, the panel bridge, custom nodes
- [x] 0.4 Plan
  - [x] 0.4.1 This file, [ROAD](ROAD.md), [DONE](DONE.md), [BASE](input/BASE.md)
  - [x] 0.4.2 [ARCH](ARCH.md) with the decision log, and [EVAL](EVAL.md) from spec §19, as GAPS Q1 decides
- [x] 0.5 Readable and buildable
  - [x] 0.5.1 `ext/README.md`, [BOOT](input/BOOT.md)
  - [x] 0.5.2 Process and conventions
    - [x] 0.5.2.1 [SDLC](SDLC.md)
    - [x] 0.5.2.2 [STYLE](STYLE.md): code, tools and interfaces, written output, and the writing style from Lakeshore
    - [x] 0.5.2.3 [SBOM](SBOM.md)
  - [x] 0.5.3 `.github/pull_request_template.md` with the definition of done
- [x] 0.6 Version control: public fork `gregoryyy/comfyui-architect` (forked as `comfyui-mcp`, renamed 2026-11-15) with `origin` and `upstream`, `gh` defaulting to the fork, noreply commit identity
- [x] 0.7 Remaining setup items
  - [x] 0.7.1 Owner answers the blocking GAPS questions: Q1 (design authority), Q2 (package name), Q3 (versions), Q5 (target), Q6 (Actions)
  - [x] 0.7.2 Licence of the additions according to GAPS Q4: MIT, the fork's copyright line in `LICENSE`
  - [x] 0.7.3 Automatic deletion of merged branches in the fork's settings (2026-11-15)

## 1. Reproducible fork and seam audit (spec Phase 0)

Exit (spec §20): the fork launches from an installed package, identifies itself correctly, works with an external MCP client and the stock panel, and preserves upstream behaviour with Architect disabled. Baseline failures are recorded, not attributed to the new layer.

- [x] 1.1 Baseline run on `707474d2`, recorded in [BASE](input/BASE.md)
  - [x] 1.1.1 `npm ci`, `npm run lint`, `check:vocabulary`, `check:unknown-collapse` (2026-11-15)
  - [x] 1.1.2 `npm run build`, `npm test`, `asset-counts --check`, `vocab:export -- --check`, `docs:gen` as a no-op, the pack and install smoke (`scripts/smoke-install.mjs`) (2026-11-15): 14 baseline failures, and one file that hangs on the baseline too ([BASE](input/BASE.md#checks-run))
  - [x] 1.1.3 The integration suite against the reference ComfyUI (`npm run test:integration`), with the target from GAPS Q5. (2026-11-15): the reference install runs on port 8190 next to the Desktop install on 8188, and `scripts/architect/stdio-smoke.mjs` passes against it (ComfyUI 0.44.2, 1,042 node classes). Upstream's `test:integration` only sets `COMFYUI_INTEGRATION=true`, which no test or configuration reads at `707474d2`, so it runs the unit suite; the live check against the reference install is `scripts/architect/stdio-smoke.mjs` with `COMFYUI_URL` set to it
- [ ] 1.2 Environment and surface record, as a research note
  - [x] 1.2.1 The reference target `~/Documents/opt/flux/ComfyUI` (GAPS Q5; Apple M5 Pro, 48 GB unified memory): its model path layout (models three levels deep, `ComfyUI/ComfyUI/ComfyUI/models`), `COMFYUI_PATH` for tests (upstream auto-selects the Desktop install), ComfyUI version, node classes and installed model families ([research/reference-target.md](research/reference-target.md)); the first certified families are GAPS Q12
  - [ ] 1.2.2 The installed Ollama models, and upstream's default `artokun/gemma4-comfyui-mcp:e4b` as the first local planner profile, named in configuration rather than code (GAPS Q9). Models recorded (15; the default isn't installed); the profile follows with the planner configuration in milestone 2
  - [x] 1.2.3 Upstream's tool surface (direct and compact) and panel surface at the baseline, as the reference for 1.5: 38 core tools plus 3 compact-mode tools, 96 panel tools, 160 retired names ([input/BASE](input/BASE.md))
  - [x] 1.2.4 The stock panel's connection behaviour with autospawn off (GAPS A6) and with two servers present (A5). Read from the panel's code ([research/panel-connection.md](research/panel-connection.md)): the switch is the panel's "Autostart MCP" setting; its code doesn't read `COMFYUI_MCP_NO_AUTOSPAWN`. Run on 2026-11-15 with the panel linked into the reference install ([research](research/panel-connection.md#observed-with-the-panel-installed)): the panel finds the fork's server on 9199, a second server runs without the bridge (A5), and the panel's status probe flips because the server leaves about half of all hellos unanswered, on `707474d2` as well. The browser side ran headless on 2026-11-15 19:00: with "Autostart MCP" off, the Agent tab connects to the fork's server, its status flipping as above; a first agent turn was cut off by that flipping, so the greeting wasn't seen in the browser ([research](research/panel-connection.md#observed-with-the-panel-installed))
- [ ] 1.3 Fork identity, according to GAPS Q2 and Q3. 1.3.1–1.3.3 wait for the rename milestone before the first publish: package, command and server name stay `comfyui-mcp` until then (GAPS Q11, answered 2026-11-15 18:49 and 20:21; [ROAD](ROAD.md#unscheduled-ideas))
  - [ ] 1.3.1 `package.json`: `name` `@gregoryyy/comfyui-architect`, `bin` `comfyui-architect`, `mcpName` `io.github.gregoryyy/comfyui-architect`, `repository` and `homepage` on `gregoryyy/comfyui-architect`, `version` 0.1.0; `architect/` in `files` (GAPS Q2, Q3). `architect` is in `files` since milestone 2; the rest waits on GAPS Q11
  - [ ] 1.3.2 `PACKAGE_NAME` in `src/services/self-update.ts`, with a test that self-update never resolves upstream's package
  - [ ] 1.3.3 `server.json` and `.claude-plugin/marketplace.json`
  - [x] 1.3.4 `ext/input/BASE.md` and build metadata carry the upstream commit (spec §17.4): `src/fork-identity.ts`, checked against BASE by a test
- [x] 1.4 Startup handshake (spec §18.2): package identity, fork version, upstream commit, Architect schema version, active policy, available features; no secrets. Done in `src/boot.ts`: `serverInfo.title` and a line after upstream's stdio instructions with product, fork version, upstream version and commit, and whether the Architect tools are on; `handshake-instructions.ts` and its byte budget stay untouched. Active policy and the schema version join the line when they exist beyond Phase 0
- [x] 1.5 Feature flag
  - [x] 1.5.1 Configuration read in one place, default off: `COMFYUI_ARCHITECT` in `src/services/architect/config.ts`, so `src/config.ts` stays upstream's
  - [x] 1.5.2 A test that the tool list, the compact catalog and the panel surface with the flag off equal the 1.2.3 record (spec AT-12): `src/__tests__/architect/registration.test.ts` compares the catalog with the flag off and on; the panel surface isn't touched by Architect code
- [x] 1.6 Facade and service skeleton
  - [x] 1.6.1 `src/services/architect/schemas.ts`: the envelope and `schemaVersion` conventions (spec §7, §16.2)
  - [x] 1.6.2 `src/services/architect/upstream.ts`: the facade interface over the inherited services the first slice needs, with contract tests
  - [x] 1.6.3 `src/services/architect/service.ts`: the service boundary with injected facade, store, clock and hash service (spec §16.3); facade, clock and ids are injected, the store follows with TODO 2.2
- [x] 1.7 Tool registration seam: the Architect tool group in `src/tools/index.ts`, behind the flag, through the existing registrar so the tool-surface policy and compact `call_tool` cover it (spec §14.3)
- [x] 1.8 Upstream gates with the first Architect tool: README counts (`asset-counts --check`), a `docs/tools/` page and its `CATEGORIES` entry in `scripts/gen-tool-docs.ts`, `docs/design/tool-vocabulary.json`. All pass unchanged, because the gates read the default surface and `architect_inspect` registers only with the flag on; its page, category and vocabulary entry come when Architect tools are on by default
- [ ] 1.9 CI on the fork (GAPS Q6): Actions enabled with `release.yml` and `mcp-registry.yml` disabled, the PR template (0.5.3). Done except the runs. On 2026-11-15 19:03 Actions was enabled for the repository (API: `enabled: true`), `CI` and `packs` were active, and `Release` and `Publish to MCP Registry` were disabled. Still no workflow ran, on PRs #7 and #8 included: GitHub starts a fork's workflows only after the owner confirms them once in the repository's Actions tab ("I understand my workflows, go ahead and enable them"), which no API does
- [x] 1.10 Smoke fixture: the installed tarball launches outside the repository, identifies itself, serves an external MCP client and the stock panel with its "Autostart MCP" setting off. Done except the panel: `scripts/smoke-install.mjs` passes with the fork's code, and an MCP client over stdio sees the fork's title and handshake line, 41 tools with the flag off and `architect_inspect` with it on (`scripts/architect/stdio-smoke.mjs`). The panel part: the fork's server serves the panel's bridge and, with the flag on, names itself in the greeting (1.12); in the browser, the stock panel with "Autostart MCP" off connects to the fork's server (1.2.4)
- [ ] 1.11 Upstream sync dry run: a `sync/upstream-…` branch merges `upstream/main`, passes the suite, records the new baseline, so the procedure is proven before it's needed. On 2026-11-15 (checked again at 17:05) upstream had no commits after the baseline, so there was nothing to merge; re-run when upstream moves
- [x] 1.12 Fork identity and the Architect flag on the panel route (spec §3.2, point 2; found with 1.2.4): the stock panel reads no server identity from the bridge, and the orchestrator builds its agent's tool environment without `COMFYUI_ARCHITECT`. With the flag on, the ready greeting gets a line naming the fork (`src/services/architect/panel.ts`, called from `src/orchestrator/ready-banner.ts`), and `buildComfyuiMcpEnv` forwards the flag to the agent's tool server (`src/services/panel-secrets.ts`). With the flag off, both are upstream's. The panel's direct `call_tool` channel keeps refusing `architect_*` (its read-only allowlist)

## 2. One end-to-end planning slice (spec Phase 1)

Exit (spec §20): a user can describe an image task, compare installed-asset candidates and obtain an editable graph with explicit constraints and provenance. No downloads, no automatic execution. The design decisions are in [ARCH](ARCH.md#decision-log) (2026-11-15, milestone 2 rows). GAPS Q12 chose Z-Image Turbo and FLUX.1-schnell; the tests run on fixture recipes.

- [x] 2.1 Domain schemas with migration tests: `TaskSpec`, `EnvironmentSnapshot`, `Recipe`, `PlanCandidate` (spec §7.1), with image-specific fields in a kind-specific part, so video and audio later add a kind without a migration of the core records (AGENTS, scope decisions)
  - [x] 2.1.1 `src/services/architect/schemas.ts`: `TaskSpecInput` and `TaskSpec` (kind-specific `media`), `Recipe` and `RecipeSlot`, `ApiGraph`, `CheckResult` and `ValidationReport`, `PlanCandidate`, `Plan` with the planning states, `PlanBlockers` (spec §9.5)
  - [x] 2.1.2 `parseStored`: step-wise upgrades by `schemaVersion`, refusal of newer versions; tests for valid, missing, newer and unknown-property records of each kind
- [x] 2.2 `architect.db`: store, WAL, migrations, the planning tables (spec §15)
  - [x] 2.2.1 `ARCHITECT_DATA_DIR` resolution and `src/services/architect/store.ts`: open with WAL and foreign keys, numbered migrations in `schema_migrations`, transactional writes
  - [x] 2.2.2 Repositories for tasks and task revisions, environments, catalog sources and recipes, plans and candidates; every read goes through `parseStored`
  - [x] 2.2.3 Tests on a temporary directory: migrations idempotent, a reopened database keeps its records, a tampered payload is refused on read, two connections in WAL mode
  - [x] 2.2.4 `ARCHITECT_DATA_DIR` reaches the panel agent's tool server (`buildComfyuiMcpEnv`, the TODO 1.12 seam)
- [x] 2.3 Environment snapshot through the facade, with freshness and probe errors (spec §8.3)
  - [x] 2.3.1 Facade: installed models by folder from upstream's `listLocalModelsWithCoverage`, keeping answered, unanswered and absent folders apart (#796)
  - [x] 2.3.2 `installedModels` in the snapshot; freshness with a configurable maximum age; a stale or partial snapshot says so
- [x] 2.4 Local catalog and three curated recipes for the families chosen in GAPS Q12 (spec §8)
  - [x] 2.4.1 Recipe loader: shipped recipes from `architect/recipes/`, validated, content-hashed, recorded with their catalog source; an invalid file is reported, never skipped silently
  - [x] 2.4.2 Retrieval: filter by kind and operation, then rank by installed-dependency overlap, at most 20 (spec §8.5, §9.2)
  - [x] 2.4.3 Fixture recipes for tests (certification `fixture`)
  - [x] 2.4.4 Three recipes for Z-Image Turbo and FLUX.1-schnell (GAPS Q12), shipped as `proposed` until the owner reviews them, each checked against the live node schemas of the Desktop install. On that install Z-Image Turbo plans to a feasible candidate. The three are `curated` after the owner's review (GAPS Q12). A fourth, `recipe-flux1-schnell.ckpt-t2i` (`proposed`), loads FLUX.1-schnell's all-in-one file from `checkpoints/` and plans to a feasible candidate too (GAPS Q13)
- [x] 2.5 `architect_inspect` and the planning actions of `architect_plan` (spec §16.1)
  - [x] 2.5.1 `architect_inspect`: `environment` with installed models, and `capabilities` (the catalog's recipes and their dependency status)
  - [x] 2.5.2 `architect_plan`: `prepare`, `propose`, `get`, `validate`, `select`, `export`; agent-supplied bindings are checked against the snapshot, so a model file the target doesn't list is refused (spec §9.2)
  - [x] 2.5.3 Candidate enumeration: bounded (24 expanded, 3 presented), hard constraints before ranking, blocked candidates and an unsatisfied-constraints report grouped by spec §9.5
- [x] 2.6 Template binding and layered validation, one task to a validated export (spec §10)
  - [x] 2.6.1 Compiler: recipe and bindings to an API graph, a role map and a canonical graph fingerprint (spec §10.2, §10.5)
  - [x] 2.6.2 Validation layers against the live node schemas: contract, structure, native types, dependencies, policy; semantic types where the recipe annotates families, otherwise unknown; runtime not applicable without execution (spec §10.3)
  - [x] 2.6.3 Export into `ARCHITECT_DATA_DIR/artifacts/<task-id>/<plan-id>/`: `task.json`, `plan.json`, `workflow.api.json`, `validation.json`, `dependencies.lock.json` (spec §15.1)
- [x] 2.7 The skill `plugin/skills/comfyui-architect/` and the command `plugin/commands/architect.md`. Written in `architect/skills/` and `architect/commands/` and served as MCP prompts while the flag is on; a file in `plugin/` would change the flag-off surface and upstream's README counts ([ARCH](ARCH.md#decision-log))
  - [x] 2.7.1 The skill: when to plan with Architect, the action order, what the agent may and may not supply (spec §9.2), and how to present candidates and blockers
  - [x] 2.7.2 The command, and both registered as MCP prompts with the Architect tools, absent with the flag off
