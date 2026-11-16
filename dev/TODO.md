# TODO

The plan: milestones (`## 1.`), tasks (`1.1`) and subtasks (`1.1.1`) with checkboxes. Numbers never change; new work gets new numbers. *(decision)* marks a choice to settle before dependent work starts, *(variant)* an alternative built for comparison. When an item is done, tick it here and add an entry to [DONE](DONE.md); the process is in [AGENTS](../AGENTS.md#process). Phases beyond the current milestones are in [ROAD](ROAD.md), questions for the owner in [GAPS](GAPS.md). Status: 2026-11-16 07:50.

Goal: the spec's first usable MVP, an approved candidate that executes locally and records its outcome (ROAD phase 2, done with milestone 3), then the certified recipe set with approved acquisition (ROAD phase 3, milestones 4 to 6). Milestone 1 is spec Phase 0, milestone 2 spec Phase 1, milestone 3 spec Phase 2. Spec section numbers (§) refer to [SPEC](design/SPEC.md).

## 0. Project setup and initial inputs

The steps of [BOOT](input/BOOT.md), on 2026-11-15.

- [x] 0.1 Collect the input: the spec v1.0 in `dev/input/`
- [x] 0.2 Assess it and state the idea: [IDEA](IDEA.md), [GAPS](GAPS.md); the fork assessment in the first DONE entry
- [x] 0.3 Design concept and security
  - [x] 0.3.1 `AGENTS.md`, `CLAUDE.md` at the root, force-added past upstream's `.gitignore`
  - [x] 0.3.2 The design authority according to GAPS Q1: [SPEC](design/SPEC.md), a working copy of the input spec
  - [x] 0.3.3 [SEC](SEC.md): from spec §14, plus what the fork brings: the public repository, upstream's HTTP transport and tunnel, the panel bridge, custom nodes
- [x] 0.4 Plan
  - [x] 0.4.1 This file, [ROAD](ROAD.md), [DONE](DONE.md), [BASE](input/BASE.md)
  - [x] 0.4.2 [ARCH](ARCH.md) with the decision log, and [EVAL](EVAL.md) from spec §19, as GAPS Q1 decides
- [x] 0.5 Readable and buildable
  - [x] 0.5.1 `dev/README.md`, [BOOT](input/BOOT.md)
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
  - [x] 1.3.4 `dev/input/BASE.md` and build metadata carry the upstream commit (spec §17.4): `src/fork-identity.ts`, checked against BASE by a test
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
  - [x] 2.4.2 Retrieval: filter by kind and operation, then rank by installed-dependency overlap, at most 20 (spec §8.5, §9.2). A model slot counts as fillable only by a file that could make a feasible candidate: its default file, or for a slot with neither default nor family any listed file (fixed 2026-11-15 20:49; before, any file in the folder counted)
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

## 3. Managed execution and evidence (spec Phase 2)

Exit (spec §20): an approved candidate executes locally, survives reconnect and restart, records its outcome and can't bypass its effect restrictions. Gate ([ROAD](ROAD.md) phase 2): AT-05, AT-06, AT-07, AT-08 and AT-10. The only effect in this milestone is a local render of a selected candidate, with its cancellation; downloads and installs come with milestone 4 (ROAD phase 3). Research: [research/approval-channel.md](research/approval-channel.md).

- [x] 3.1 Contracts and storage (spec §7.1, §15.2, §15.3): `ActionPlan`, `ApprovalRequest`, `ApprovalGrant`, `RunRecord` with its events, `EvaluationRecord` and `ResourceLease` as Zod schemas read through `parseStored`; migration 2 adds `action_plans`, `approval_requests`, `approval_grants`, `runs`, `run_events`, `evaluations` and `resource_leases` (`operations` waits for a record that needs it). Kind-neutral: what is image-specific lives in the evaluator, not the record
  - [x] 3.1.1 Schemas, with tests for valid, missing, newer and unknown-property records
  - [x] 3.1.2 Migration and repositories; the run state machine of §15.3 as a transition table with guards, each transition stored with time, principal and reason before it's announced
- [x] 3.2 *(decision)* The approval channel for external MCP clients (GAPS Q20: form elicitation where the client supports it, a terminal command as fallback) and what Architect mode does with upstream's effectful tools (GAPS Q21: `1` assist keeps them, `managed` hides them on every route); answered 2026-11-15 21:09
- [x] 3.3 Action plans and grants (spec §14.1, §14.2): `architect_run prepare` turns a selected candidate into an action plan with a content hash (graph fingerprint, target, budgets, expiry) and opens an approval request; a grant binds that hash, target, limits and expiry, is consumed by one start, and is invalidated by any material change. No model-callable tool creates or widens a grant
  - [x] 3.3.1 Action plan and request, with the plan hash computed from canonical JSON
  - [x] 3.3.2 Grant capture through the channel Q20 chooses; the channel is recorded in the grant
  - [x] 3.3.3 Negative tests: a model-supplied grant, a grant for another hash or target, an expired, consumed or invalidated grant, a changed environment between grant and start (SEC T1)
- [x] 3.4 Effect admission (spec §14.3, AT-05): one service gate every Architect effect passes, the same on direct tools, compact `call_tool` and the panel route; a test drives each route with and without a grant. On the panel route start is refused unless the operator sets `ARCHITECT_PANEL_RUNS=terminal` (GAPS Q22)
- [x] 3.5 The durable run controller (spec §15.3, §15.4, AT-06, AT-07)
  - [x] 3.5.1 Facade: submission with a client-chosen prompt ID, queue and history reads, interrupt of one prompt ID. Submitting with a prompt ID needs an optional parameter on upstream's `enqueuePrompt` (`src/comfyui/client.ts`), a seam recorded in ARCH; ComfyUI 0.44 accepts a client UUID as `prompt_id`
  - [x] 3.5.2 The controller: idempotency key per target, task and plan revision; the attempt is stored before the network call; a lost response enters `OUTCOME_UNKNOWN` and reconciles against queue and history, never resubmits blindly; progress by polling; resume of every non-final run after a restart
  - [x] 3.5.3 Cancellation of Architect's own prompt only: dequeue if pending, interrupt if running and its prompt ID matches; never clear the queue; tests with unrelated jobs queued and running
- [x] 3.6 Resource coordination (spec §11.3, §11.4, AT-10): a lease per memory pool with owner, heartbeat, expiry and recovery; one render per pool; with an unknown estimate the run counts as the bounded probe the grant names; a local reasoning model resident on the same pool blocks the render unless the user permits releasing it (`manageSharedModelResidency` off by default); unified memory counted once. Built as `ARCHITECT_MANAGE_RESIDENCY`: the approval names the models to unload, and they are loaded back after the render (GAPS Q23)
- [x] 3.7 Evaluation and review (spec §13.1, §13.2, AT-08): artifact existence and readability, count, format and dimensions against the task, run completion; the user's verdict through the trusted channel; an agent's opinion stored as the agent's, never as the user's; execution, acceptance and user verdict kept apart
- [x] 3.8 Run export and lineage (spec §15.1, FR-11): `runs/<run-id>/run.json` and `evaluation.json` under the plan's artifacts, linking task, plan, graph, dependency lock, environment, prompt ID and outputs
- [x] 3.9 The skill and command describe the run actions; a live run against the reference target through `stdio-smoke.mjs --run` (e2e-runner)

## 4. Approved dependency acquisition (spec Phase 3, first part)

Exit: a candidate blocked only by missing model files becomes feasible after the user approves a pinned download manifest, and the downloaded files carry their source, commit and verified sha256 into the dependency lock. Gate: SEC T4 and T9 controls verified; no download without a grant on any route (AT-05 extended to the new effect); a hash mismatch, an unexpected redirect host or a size over the bound leaves nothing in a model folder. Research: [research/acquisition-sources.md](research/acquisition-sources.md).

- [x] 4.1 *(decision)* Sources, limits and custom nodes (GAPS Q25, Q26, answered 2026-11-16 03:19): Hugging Face only, pinned to a commit and hash-checked, redirects only to its hosts, `.safetensors` only, 40 GB per approval and 50 GB kept free, a token only for gated repositories from `HF_TOKEN`; no custom-node installs in phase 3
- [x] 4.2 Contracts and storage (spec §8.3, §8.5, §14.4): `SourceRegistryEntry` (adapter, root or URL, allowed operations, trust status, refresh policy, last refresh), `DependencyManifest` (per file: source, repository as resolved, commit, path, size, sha256, licence, gated, destination folder and name), an `acquire_models` effect in the effect union, and acquisition records; migration 4. An unreachable source is `unavailable`, never empty. Built differently (ARCH 2026-11-16): the manifest is the recipe's pinned `modelSources` and the `acquire_models` effect, without `gated`; `SourceRegistryEntry` waits for the template sources (GAPS Q32, TODO 5.2)
  - [x] 4.2.1 Schemas with tests for valid, missing, newer and unknown-property records
  - [x] 4.2.2 Migration, repositories, and the acquisition states (planned, downloading, verifying, placed, failed, cancelled) as a transition table
- [x] 4.3 Manifest resolution: a recipe's model slot names its source (repository and path), never a URL the agent supplies (spec §9.2); Architect resolves the revision to a commit and reads size and sha256 from the Hugging Face API, through the configured source registry and only where the network profile allows it. A missing slot source leaves the dependency `unknown` with the reason. Built without network at run time: `scripts/architect/pin-source.mjs` reads the commit, size and sha256 from Hugging Face's API when a maintainer pins a source, and planning and execution use the pin. A missing file without a pinned source keeps the candidate `blocked`, with the reason, since the check itself is an observed `fail`
- [x] 4.4 *(decision)* Redirect checking (spec §14.4): Architect checks each hop against the source's allowed hosts before handing upstream the commit-pinned URL; no upstream file changes ([ARCH](ARCH.md#decision-log), 2026-11-16)
- [x] 4.5 The acquisition effect through `admitEffect`: `architect_run prepare` adds the manifest to the action plan, the approval shows each file, its source, commit, size, destination and the free disk left, and the hash covers the manifest. The download runs through the facade on upstream's `startDownloadJob` into a staging folder under the model root, the sha256 is checked against the manifest, and only then is the file moved into place; an existing file is never overwritten; the ComfyUI-Manager route is refused
  - [x] 4.5.1 Facade functions over upstream's download jobs and file hasher, with contract tests (file hasher: Architect hashes with node:crypto and checks inodes, so upstream's is unused)
  - [x] 4.5.2 Staging, verification and placement, with negative tests: hash mismatch, size over bound, redirect to another host, existing destination, path escape, a remote target, the Manager route (SEC T4, T9)
  - [x] 4.5.3 Cancellation and restart: a download in progress resumes or is cancelled as its own operation; a staged file left by a crash is never placed without verification
- [x] 4.6 After acquisition the environment is snapshot again and the candidate revalidated before its render; the run's dependency lock records each acquired file with source, commit and sha256 (FR-11)
- [x] 4.7 The skill and command describe acquisition; a live acquisition of one small file (an upscale model) on the reference target through `stdio-smoke.mjs --acquire` (e2e-runner)

## 5. Certified recipe set and template sources (spec Phase 3, second part)

Exit: the certified set (spec §2.2: 12 to 20 variants across 2 to 3 families) covers text to image, image to image, editing, inpainting, reference-guided generation and upscaling, each recipe passing its graph-contract tests with a pinned dependency fixture (AT-03), and its UI export round trip (AT-11).

- [x] 5.1 *(decision)* The families, variants and downloads of the certified set, and what "certified" requires beyond `curated` (GAPS Q24, Q27, answered 2026-11-16 03:19): 15 variants in Z-Image Turbo, FLUX.1-schnell and FLUX.2 Klein 4B, a 4× upscale model and SeedVR2 3B; `certified` is `curated` plus a pinned dependency fixture, AT-03, AT-11 and one live render with passing checks ([ARCH](ARCH.md#decision-log))
- [ ] 5.2 Template-source adapters (spec §8.3, §8.4): ComfyUI's template index served by the target (`/templates/index.json`) and upstream's packs, both read-only. Import detects the format, flattens subgraphs, extracts the model list as candidate sources, and writes a conversion report with every unsupported construct; nothing is executed or installed by an import, and text in a template is data (SEC T2). An imported recipe is `proposed` until the owner reviews it
- [ ] 5.3 Semantic compatibility rules (spec §8.1, §9.3): a model file's family identified from its safetensors header (tensor names and shapes) as an observation with provenance; family relationships with their applicability (loader, precision, node revision). This replaces GAPS Q14's soft unknown for the recipe default with an observed check
- [ ] 5.4 The recipes of 5.1, each with its slots, sources, outputs and graph-contract tests
- [ ] 5.5 UI export (FR-07, spec §10.4): a certified recipe's UI graph loads and exports to the same executable graph, modulo documented fields (AT-11)
- [ ] 5.6 Live: each certified recipe renders once on the reference target, the outputs pass their checks, and the owner reviews each recipe for `curated`. The downloads are shown to the owner as a list before the runs; on the owner's go-ahead the smoke approves (GAPS Q34)
- [ ] 5.7 Input images (GAPS Q33): a task's inputs are files in the target ComfyUI's input folder (`comfyui-input:<name>`); `input_image` slots bind them; the action plan and the run record carry each input's sha256, and a changed input invalidates the grant; no other local file is read and nothing is uploaded
  - [ ] 5.7.1 Schemas, compile and validation, with negative tests: an unlisted name, a path escape in the name, an input no slot consumes, a mask without a mask slot
  - [ ] 5.7.2 Facade read of an input file, the effect's inputs in the hash, start's re-read; tests for a changed and a vanished input

## 6. Repair, region checks and the acceptance suite (spec Phase 3, third part)

Exit (spec §20): the reference acceptance suite passes on the documented test matrix; unsupported cases are reported as unsupported. Gate ([ROAD](ROAD.md) phase 3): AT-01 to AT-12, AT-04 at the proposed 90%, first-attempt and repaired success reported apart.

- [ ] 6.1 Bounded repair (spec §13.4): errors classified into schema or wiring, missing dependency, unsupported backend or precision, memory, transport, policy and quality; a repair is a new plan revision with a visible diff, limited to the approved scope and an allow list of transformations; limits two repair rounds, three previews, one final execution; anything beyond needs an amended grant
- [ ] 6.2 Validation stages (spec §13.1): a smoke or preview render as its own graph revision, never reported as the final graph's result
- [ ] 6.3 Protected-region evaluation (spec §13.2): an exact comparison of the pixels outside the mask for recipes that promise it, with the mask, threshold and colour handling part of the criterion
- [ ] 6.4 Optional visual evaluators (GAPS Q29, answered 2026-11-16 03:19): an OCR check through `glm-ocr` for text in the image, behind a versioned plugin contract; its verdicts stay advisory unless the user accepts the evaluator for a criterion, and an uncertain reading is `unknown`
- [ ] 6.5 The reference acceptance suite (spec §19.2): 30 task fixtures, 20 feasible across the certified recipes and 10 deliberate conflicts, policy and missing-evidence cases, reviewed by the owner; resource fixtures for an Apple unified-memory and a dedicated-GPU profile; a runner for AT-01 to AT-12, including AT-09's no-egress check
- [ ] 6.6 The test matrix documented in EVAL (GAPS Q28: the reference Mac only, a dedicated GPU in fixtures only, no paid machines); the suite run on it, results in EVAL and DONE
