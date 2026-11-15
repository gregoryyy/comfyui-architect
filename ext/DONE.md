# Done

The progress log, newest entry on top. Each entry: `## YYYY-MM-DD HH:MM — Title` (time from `date`), the TODO items and PR or commit, an `Agent:` line, then **Implementation notes**, **Deviations** and **Insights**. The plan is in [TODO](TODO.md).

## 2026-11-15 19:03 — Milestone 2 follow-ups: FLUX checkpoint, curated recipes, panel in the browser

TODO items: 1.2.4, 1.10 (done), notes on 1.3, 1.9 and 2.4.4. GAPS Q6, Q11–Q16 answered. PR #8, branch `feat/milestone-2-followups`, built on #7.

Agent: Opus 5.5, subagents: none.

### Implementation notes

- **FLUX.1-schnell (GAPS Q13):**
  - `checkpoints/flux1-schnell-fp8.safetensors` is a symbolic link to the all-in-one file in `diffusion_models/` of the second model root.
  - The new recipe `recipe-flux1-schnell.ckpt-t2i` loads it with `CheckpointLoaderSimple`, node for node as ComfyUI's `flux_schnell` template does. It's `proposed`.
  - `stdio-smoke.mjs --plan` against the Desktop install now gives two feasible candidates, Z-Image Turbo and FLUX.1-schnell, and exports the first. The `UNETLoader` recipe stays blocked for lack of separate encoders.
- **The three first recipes** are `curated` at revision 3, with a `maintainer_review` entry recording the owner's acceptance. A test ties `curated` to that evidence.
- **The captured `/object_info` fixture** gains `CheckpointLoaderSimple` from the live Desktop.
- **GAPS answers:**
  - Q11: the package stays `comfyui-mcp`, and the rename becomes its own milestone before the first publish (ROAD, ARCH, TODO 1.3).
  - Q14–Q16: the proposals, as implemented in #7.
- **Browser panel checks:**
  - Setup: a headless Chromium (Playwright from the npx cache with the cached browser, nothing installed) against the reference install on port 8190 and the fork's `connect` server with the flag on.
  - With "Autostart MCP" off, the Agent tab connects to the fork's server ([research/panel-connection.md](research/panel-connection.md#observed-with-the-panel-installed)).

### Deviations

- **CI didn't run.** Actions is enabled with the tag workflows disabled, but a fork's workflows start only after the owner confirms them in the Actions tab, and no browser that has the owner's GitHub session was reachable from this session. So TODO 1.9 stays open.
- **The greeting wasn't seen in the browser.** The one agent turn tried was retired after 5 s by the bridge's flipping connection, which is baseline behaviour, so neither the greeting nor the agent's `architect_*` tools were observed there. No second turn was tried: the panel had fallen back to a ChatGPT conversation, and a retry could have spent another subscription.

### Insights

- The stock panel's flipping status isn't only cosmetic. A dropped socket that re-hellos is taken for a workflow switch, which retires the agent mid-turn and switches the panel's conversation. Panel work in a later milestone depends on that upstream behaviour.
- Testing the panel leaves state in the target install: settings (`autostartMcp`, `bridgeUrl.claude`) and a saved workflow. A browser test needs its own ComfyUI user directory.

## 2026-11-15 18:28 — Milestone 2: one end-to-end planning slice

TODO items: 2.1–2.7 with their subtasks; notes on 1.3.1. GAPS Q14–Q19 (new; Q17–Q19 answered). PR #7, branch `feat/milestone-2`.

Agent: Opus 5.5, subagents: implementer ×4 (Opus 5.5: the store, the compiler and validation, the environment models, the first recipes), assurance ×1 (Opus 5.5, read-only review).

### Implementation notes

- Contracts in `src/services/architect/schemas.ts`: a kind-neutral `TaskSpec` whose `media` is a discriminated union (only `image` so far), `Recipe` with typed slots, `ValidationReport`, `PlanCandidate`, `Plan` and `PlanBlockers` (spec §9.5). Every stored record is read through `parseStored`, which refuses newer versions and unknown properties. A resource estimate can only be `unknown`, so no number can be invented before measured profiles exist.
- `architect.db` (better-sqlite3, WAL, numbered migrations) lives in `ARCHITECT_DATA_DIR`, by default `<COMFYUI_MCP_DATA_DIR or ~/.comfyui-mcp>/architect`. A plan's task and environment are immutable once written.
- The environment snapshot carries installed models by folder from upstream's `listLocalModelsWithCoverage`, with answered, unanswered and absent folders kept apart (#796), and a freshness check with `ARCHITECT_ENV_MAX_AGE_SECONDS`.
- The catalog loads `architect/recipes/*.recipe.json`, validates and content-hashes each file and reports invalid ones. Retrieval filters by kind and operation and ranks by evidence tier, installed fit and id, at most 20.
- The compiler binds slots into an API graph with a role map and a canonical fingerprint. Validation runs the contract, structure, native types, semantic types, dependencies, policy and runtime layers; any hard unknown keeps a candidate from being feasible.
- The planner expands at most 24 candidates, shared equally across recipes, and presents 3: feasible before blocked, then tier, then dependency burden. A slot default names the file used; only slots without one are enumerated over the installed files. Blockers are grouped by spec §9.5.
- `architect_plan` has `prepare`, `propose`, `get`, `validate`, `select` and `export`; `architect_inspect` gains `capabilities`. Export recompiles the graph, refuses it when the fingerprint differs from the validated one, and writes five files into `artifacts/<task-id>/<plan-id>/`.
- Three recipes, all `proposed`: Z-Image Turbo text to image and image edit, FLUX.1-schnell text to image (GAPS Q12). Against the Desktop install on port 8188, a text-to-image task plans to a feasible Z-Image Turbo candidate, is selected and exports; FLUX.1-schnell is blocked with the two text-encoder files it expects. `scripts/architect/stdio-smoke.mjs --plan` repeats this.
- The assurance review found five high, four medium and eleven low findings; all high and medium findings and six low ones are fixed in this branch, each with a negative test; L2 is recorded as deferred in ARCH, and L4 and L9–L11 stay open (Deviations):
  - Ranking: a blocked candidate no longer goes ahead of a feasible one (H1).
  - `validate` withdraws a selection whose candidate is no longer feasible. `select` and `export` recompute the verdict from the checks rather than trust a stored status (H2, L1).
  - A binding can't override a slot the task fills (H3, GAPS Q15).
  - Output count and format, an output size no slot sets, and task input assets are checked or stay hard unknowns. A recipe's output now declares `format` and `count`, so the shipped recipes are at revision 2 (H4, GAPS Q16).
  - A model file other than the slot's default is a hard unknown for its family (H5, GAPS Q14). A model file must also be one the loader's live COMBO offers (M2).
  - An unread model folder gives a diagnostic candidate, not a blocked one (M1, #796).
  - Planning uses only the recipes of the current catalog load, and `prepare` and `propose` carry the catalog's load errors as warnings (M3).
  - Smaller fixes:
    - the user's text reaches the `/architect` prompt literally (L5);
    - unexpected errors are `INTERNAL_ERROR`, not `OUTCOME_UNKNOWN` (L6);
    - export refuses a symbolic link under `artifacts/`, and `ARCHITECT_DATA_DIR` must be absolute (L7);
    - stale comments and tier lists are corrected (L8);
    - an input the node class doesn't declare fails (L3).
- The skill and the `/architect` command are served as the MCP prompts `architect` and `architect_skill`, with the flag on only.
- Checks: build, lint, asset counts, vocabulary, unknown collapse, vocabulary export and `docs:gen` pass. `smoke-install` passes and the tarball contains `architect/`. 279 Architect tests pass. Upstream's suite, without the hanging `bridge-port-reclaim` file: 13 failures in five files, all among the 14 baseline failures in [BASE](input/BASE.md) (`services/ui-bridge` passed). A second run with the target on an unused port passes 12 of the 13; the failures it adds are in files that pass without the override.

### Deviations

- Three upstream files changed at new seams, recorded in [ARCH](ARCH.md#upstream-footprint): `src/boot.ts` (the Architect prompts; upstream's empty `prompts/list` handler is installed only when none were registered, because the SDK allows one handler per method), `src/services/panel-secrets.ts` (the forwarded Architect variables now come from `architectChildEnv`) and `package.json` (`architect` in `files`, ahead of the rest of TODO 1.3.1).
- The skill and command aren't in `plugin/` (TODO 2.7): a file there would change the flag-off surface and upstream's README counts. They move when Architect is on by default.
- The recipes ship as `proposed`, a tier added for agent-written recipes (spec §8.4), not `curated` as TODO 2.4 says, until the owner reviews them.
- The export holds the API graph only; the UI graph waits for a later milestone. Its lock has no model hashes, node-pack revisions or full node-schema digest yet (ARCH; review L2).
- `INTERNAL_ERROR` is added to spec §16.4's error codes (ARCH).
- Left open from the review: blockers from structure and native-type checks still land in `missing_dependencies` (L4). `ARCHITECT_*` variables reach the panel's tool server with the flag off too, where nothing reads them (L9). `preferences`, `budgets` and `policyProfile` are accepted without a check saying they're ignored (L10). Tool IDs are plain strings, and the store's lookups are parameterised (L11).
- Milestone 2's exit is met with one feasible family on the reference machine (GAPS Q18): Z-Image Turbo text to image. The image-to-image recipe is diagnostic until input assets resolve to files (ROAD phase 2).

### Insights

- 13 of the 14 baseline failures of upstream's suite come from the Desktop ComfyUI on port 8188. Those tests assume no Plugin Manager is reachable, and the Desktop answers the Manager v4 API. Moving the target to an unused port makes them pass but breaks other tests that assume the default target, so a clean local run needs the Desktop closed. The fourteenth is a 30 s timeout on this machine ([BASE](input/BASE.md)).

- The first live run found three bugs the fixtures didn't: prompt and seed slots left unfilled, the planner binding files of the wrong family across a Cartesian product, and one recipe using up the whole candidate budget.
- Several upstream tests read the source as text (names like `getEnvironment`, `"graph_*"` strings, `homedir()…comfyui-mcp` on one line, a 3,200-character window of `buildComfyuiMcpEnv`). Architect code that matches them fails upstream's gates, so names were chosen around them.
- The FLUX.1-schnell file on the Desktop install is an all-in-one checkpoint with its own text encoders and VAE, but sits in `diffusion_models/`, where `CheckpointLoaderSimple` doesn't look. GAPS Q13 asks how to load it.
- Agent definitions in `.claude/agents/` load only at session start; within the session they were run as general-purpose agents told to read their role file.

## 2026-11-15 17:06 — Milestone 1 live checks: reference install, panel route

TODO items: 1.1.3, 1.12 (new), notes on 1.2.4, 1.10, 1.11. Branch `feat/milestone-1-live`.

Agent: Opus 5.5, subagents: none.

### Implementation notes

- The reference install (`~/Documents/opt/flux/ComfyUI`, ComfyUI 0.44.2) ran on port 8190 next to the Desktop install; `scripts/architect/stdio-smoke.mjs` passes against it with 1,042 node classes. With `main.py` at its top level, upstream keeps `COMFYUI_PATH` there and doesn't descend into the nested checkout.
- The panel, linked into the reference install's `custom_nodes`, was exercised through its HTTP routes and the bridge protocol, against the fork's `connect` server and a pristine `707474d2` build ([research/panel-connection.md](research/panel-connection.md#observed-with-the-panel-installed)).
- New TODO 1.12, found on the way: the panel route didn't identify the fork, and the panel's agent never got the Architect tools, because the orchestrator builds that tool server's environment without `COMFYUI_ARCHITECT`. With the flag on, the ready greeting now ends with "ComfyUI Architect 0.1.0 (fork of comfyui-mcp 0.52.206 @707474d2): Architect tools on.", and the flag is forwarded. With it off, both stay upstream's. `src/__tests__/architect/panel-route.test.ts` covers both states.

### Deviations

- Two upstream files changed outside the earlier seams, recorded in [ARCH](ARCH.md#upstream-footprint): `src/orchestrator/ready-banner.ts` (the greeting) and `src/services/panel-secrets.ts` (one forwarded variable). The greeting seam sits in `ready-banner.ts`: `ui-bridge-locale.test.ts` matches the call sites in `src/orchestrator/index.ts` as text, and `index.ts` is 7,400 lines.
- The browser side of the panel checks (TODO 1.2.4, 1.10) wasn't run.

### Insights

- The bridge leaves about half of all panel hellos unanswered within 5 s, on `707474d2` too, so the panel's status flips between "running" and "port held by another process". Recorded in BASE as baseline behaviour.
- A second server on the same bridge port runs on without the panel; GAPS A5 is confirmed by test.
- Upstream builds child environments by allowlist, so every new Architect variable has to be forwarded at `buildComfyuiMcpEnv`, or the panel route won't see it.
- The panel's direct `call_tool` channel admits a fixed read-only list; `architect_*` stays out of it until a decision says otherwise.

## 2026-11-15 16:52 — Stdio smoke in the repository

TODO items: 1.1.3, 1.10 (notes). Branch `chore/architect-stdio-smoke`.

Agent: Opus 5.5, subagents: none.

### Implementation notes

- `scripts/architect/stdio-smoke.mjs` starts the built server as an external MCP client does, with the Architect flag off, on, or both (the default). It checks that `serverInfo.title` and the handshake line name the fork, that the flag adds only `architect_*` tools (spec AT-12) and that `architect_inspect` reads the target; it exits 1 when a check fails. `--offline` accepts the `STALE_ENVIRONMENT` error, so the wiring can be checked without a ComfyUI.
- Against the Desktop ComfyUI on port 8188, all checks pass: 41 tools with the flag off, 42 with it on, ComfyUI 0.44.0.
- `architect_inspect` now says "No snapshot" when no probe answers; it said "Partial snapshot" next to the status `error`. The probe names are one constant, so the all-failed case no longer counts to two.

### Deviations

- None. The script is a new file; no upstream file changes.

### Insights

- The smoke replaces upstream's `test:integration` as the live check for now, because that script sets a variable no test reads.

## 2026-11-15 15:19 — Milestone 1: fork identity, feature flag, first Architect tool

TODO items: 1.1.2, 1.2.1, 1.2.3, 1.3.4, 1.4, 1.5, 1.6, 1.7, 1.8; notes on 1.1.3, 1.2.2, 1.2.4, 1.3, 1.9, 1.10, 1.11. Branch `feat/milestone-1`, built on `docs/milestone-0` (PR #3).

Agent: Opus 5.5, subagents: none.

### Implementation notes

- `src/fork-identity.ts` names the product, the fork version 0.1.0, the intended package identity (GAPS Q2) and the pinned upstream commit; a test checks the commit and version against [BASE](input/BASE.md).
- The MCP handshake identifies the fork: `serverInfo.title` and a line after upstream's stdio instructions with product, fork version, upstream version and commit, and whether the Architect tools are on. `serverInfo.name` stays `comfyui-mcp` until the rename (GAPS Q11).
- `COMFYUI_ARCHITECT` turns the Architect tools on; it is off by default. With it off, the tool catalog equals upstream's (spec AT-12), which `registration.test.ts` checks against the catalog with it on.
- `src/services/architect/`: the flag, the Zod schemas (`EnvironmentSnapshot`, the result envelope, the error codes of spec §16.4), the upstream facade and the service. A failed probe leaves its fields absent and is listed in `probeErrors`, never reported as zero (#796).
- `architect_inspect` (action `environment`) registers through upstream's registrar, so the tool-surface policy and compact `call_tool` cover it; a test withholds it with `COMFYUI_MCP_TOOL_DENY`.
- Against the Desktop ComfyUI on port 8188, an MCP client over stdio sees 41 tools with the flag off and 42 with it on; `architect_inspect` returns ComfyUI 0.44.0, 1,049 node classes and one `mps` device with 48 GB.
- [research/reference-target.md](research/reference-target.md) records the machine, both ComfyUI installs, the installed models and the Ollama models; [research/panel-connection.md](research/panel-connection.md) records how the stock panel finds and starts a server, read from its code (GAPS A5, A6, A9).

### Deviations

- Upstream files changed: `src/boot.ts` and `src/tools/index.ts`, at the seams in [ARCH](ARCH.md#upstream-footprint).
- The flag is read in `src/services/architect/config.ts`; `src/config.ts` stays upstream's.
- The tool page, its category and the vocabulary entry for `architect_inspect` wait until Architect tools are on by default; the gates read the default surface and pass unchanged.
- The package rename (TODO 1.3.1–1.3.3) waits on GAPS Q11: upstream names `comfyui-mcp` in about 25 source files, the plugin launcher and the install smoke.

### Insights

- Upstream pins some wiring as source text: `handshake-instructions.test.ts` expects `instructions:` followed by `STDIO_HANDSHAKE_INSTRUCTIONS` in `boot.ts`. A template literal failed it; concatenation keeps the output and the test. A seam has to keep the source form such tests read as well as the behaviour.
- The full suite doesn't finish locally: `bridge-port-reclaim.test.ts` hangs on the baseline as well. The 14 baseline failures and the hang are recorded in BASE; CI on Node 22 may differ.
- No workflow has run on the fork yet, including on PRs #2 and #3, although Actions is enabled. A fork's workflows start only after the owner enables them in the Actions tab.
- The panel's code doesn't read `COMFYUI_MCP_NO_AUTOSPAWN`, the variable SPEC v1.0 names for development (GAPS A6). The switch is the panel's "Autostart MCP" setting, and its launcher always runs `npx -y comfyui-mcp@latest connect`, so with "Autostart MCP" on the panel can only start upstream. SPEC §3.2 and §18.2 are corrected; Q11 notes the launcher.
- No image model is installed on either ComfyUI; the installed models are for video and audio. The first certified image families (GAPS Q12) need downloads.

## 2026-11-15 14:43 — Milestone 0 complete: SEC, ARCH, EVAL, SDLC, SBOM, PR template

TODO items: 0.3.3, 0.4.2, 0.5.2.1, 0.5.2.3, 0.5.3, 0.7.3. Branch `docs/milestone-0`, built on `docs/gaps-answers` (PR #2).

Agent: Opus 5.5, subagents: none.

### Implementation notes

- [SEC](SEC.md): assets, twelve threats with their design consequences, controls by ROAD phase, and how each control is verified; built on SPEC §14 with what the fork adds (public repository, upstream's transport and tunnel, custom nodes, model files).
- [ARCH](ARCH.md): a map of SPEC's architecture, the decision log of 2026-11-15 (fork, public, `ext/`, name, kind-neutral contracts, SPEC as authority, identity, versions, licence, reference target, Actions, panel timing, seams, planner), and four open decisions.
- [EVAL](EVAL.md): seven claims from IDEA mapped to four evaluations (the acceptance suite, security negative tests, the comparison with stock upstream, planner model qualification), with every number marked as a proposed target.
- [SDLC](SDLC.md): work items, branches and PRs, definition of done, testing, upstream sync, upstream contributions, TODO mode, decisions, versions and releases. AGENTS's process section now summarizes it.
- [SBOM](SBOM.md): rules, licence policy, toolchain, and the major dependencies with licences read from the installed packages.
- `.github/pull_request_template.md` with the definition of done; a new file, since upstream has none.
- Merged branches are deleted automatically (`delete_branch_on_merge`, set through the GitHub API).

### Deviations

- None from the plan. ARCH holds only the map, the decision log and open decisions, as GAPS Q1 decided.

### Insights

- Every direct dependency is permissive (MIT, Apache-2.0, BSD-2-Clause, ISC) except the optional Claude Agent SDK, which is under vendor terms and installed on the user's machine, not redistributed.
- The development machine runs Node 26.13.0 and npm 11.20.0; CI pins Node 22. A difference between local and CI results may come from that.
- ARCH's open decisions include one found while writing it: upstream code that compares the package version (panel compatibility, update gates) may react to the fork's 0.1.0. Milestone 1 checks it before changing `package.json`.

## 2026-11-15 14:26 — ComfyUI Architect in the input spec too

TODO item: 0.1. Branch `docs/gaps-answers`.

Agent: Opus 5.5, subagents: none.

### Implementation notes

- The input spec is now `ext/input/comfyui-architect-system-spec.md`, and its text says ComfyUI Architect, with the skill folder `plugin/skills/comfyui-architect/` (owner, 2026-11-15). Links in AGENTS, IDEA, README, BOOT and SPEC follow the new file name.
- SPEC's working-copy note, STYLE (documents) and BOOT (names) say that the input is frozen apart from the product name.
- No "Comfy Architect" or `comfy-architect` remains in tracked files, apart from DONE's earlier entries and the subject of commit `874c4489`.

### Deviations

- The rename at 13:19 left the spec unchanged as frozen input, against the owner's instruction to call the project ComfyUI Architect. The owner corrected it.
- The 13:46 entry, explaining the vocabulary fix, spelled out the retired tool name itself, so PR #2 failed `check:vocabulary` as pushed (`795e932a`). The gate had run before that line was added. Reworded; the gate passes (1,938 files).

## 2026-11-15 13:46 — GAPS questions answered

TODO items: 0.3.2, 0.7.1, 0.7.2. Branch `docs/gaps-answers`.

Agent: Opus 5.5, subagents: none.

### Implementation notes

- The owner answered all ten GAPS questions (2026-11-15 13:45); each has its answer and a Resolved line naming where the decision went. Eight followed the proposal. Q5 and Q9 chose differently: the reference target is the source install at `~/Documents/opt/flux/ComfyUI`, not the Desktop install, and the first local planner is upstream's default `artokun/gemma4-comfyui-mcp:e4b`.
- [SPEC](design/SPEC.md) is the design authority (Q1): a copy of the input spec with a working-copy note and the owner's decisions since applied (product name, skill folder, baseline record). AGENTS, IDEA, STYLE, TODO and README refer to it; § now means its sections.
- TODO 1.2.1, 1.2.2, 1.3.1 and 1.9 carry the answers to Q5, Q9, Q2 and Q3, and Q6.
- `LICENSE` gained the line `Copyright (c) 2026 Gregor Heinrich (ComfyUI Architect additions)` (Q4: MIT for everything).

### Deviations

- `LICENSE` is an upstream file outside the seams listed in BOOT; the change follows from Q4. Upstream has changed `LICENSE` once (`5ac899b4`), so a sync conflict there is unlikely.
- `main` after PR #1 fails `check:vocabulary`: AGENTS.md used a verb that is also the name of a tool upstream retired in 0.50.0 (now an action of `generate_image`), and the gate matches whole words in every tracked file. PR #1's checks passed because AGENTS.md was still ignored then and the gate scans only tracked and untracked-not-ignored files. Reworded to "rebuild the generated files"; the gate passes again (1,938 files).

### Insights

- Neither install holds image models: the reference install has one MiniMax video LoRA (1.8 GB in total) three levels deep, and the Desktop install's models folder is empty. The first certified families start with downloads, so TODO 1.2.1 checks the model path layout before any recipe work.
- The machine is an Apple M5 Pro with 48 GB of unified memory, so reasoning and rendering share one memory pool, and the spec's shared-memory scheduling (§11.3) applies from the first local run.

## 2026-11-15 13:35 — Repository renamed; neutral PR text

TODO item: 0.6. Branch `docs/gaps-answers`; PR #1 (merged 2026-11-15) got the rewritten description.

Agent: Opus 5.5, subagents: none.

### Implementation notes

- Renamed the fork on GitHub from `gregoryyy/comfyui-mcp` to `gregoryyy/comfyui-architect` (owner, 2026-11-15). It stays a fork of `artokun/comfyui-mcp`; `origin` and `gh`'s default repository point at the new name, and GitHub redirects the old URLs. AGENTS, README and TODO 0.6 use the new name; GAPS Q2 notes the rename, and the package and command names stay open there.
- PR text is neutral and in the third person, without addressing the owner or an agent signature (owner, 2026-11-15): a rule in STYLE (Commits and pull requests) and AGENTS (Commits). PR #1's description was rewritten to match.

### Deviations

- PR #1 was first written with an "Open for the owner" section and a generated-by line.

## 2026-11-15 13:31 — BOOT edits restored

TODO item: 0.1. Branch `architect/spec`, PR #1, not yet committed.

Agent: Opus 5.5, subagents: none.

### Implementation notes

- Restored the seven BOOT edits lost before commit `254ad1fc` (owner, 2026-11-15): step 1's state, the GAPS Q1 variants with the spec as frozen input, the first input named in step 1, `SPEC.md` as the central design document, the file tree (no spec at `ext/` root, `design/SPEC.md` as the decision, `input/` with the spec, BOOT and BASE), and the names rule for `input/`.

### Deviations

- Step 1 now says the move is done and committed, and the `input/` line also lists BOOT and BASE, which moved there after the lost edits were written.

## 2026-11-15 13:29 — STYLE as the central standard; BOOT and BASE to input

TODO items: 0.5.2.2. Branch `architect/spec`, not yet committed.

Agent: Opus 5.5, subagents: none.

### Implementation notes

- [STYLE](STYLE.md) is the project's standard (owner, 2026-11-15): code (upstream's TypeScript and ESM conventions, Zod contracts, no type escapes, stdout reserved for MCP stdio, upstream's #796 rule), tools and interfaces (action-oriented tool families, English tool text that is never translated, i18n for text a person reads), written output (documents, commits, PRs, DONE, replies), and the writing style from Lakeshore's `.claude/STYLE.md`, with its sections renumbered W1 to W4 and its llmkit and stop-slop attribution kept. The separate `.claude/STYLE.md` is gone, so nothing under `.claude/` needs force-adding.
- `BOOT.md` moved to `ext/input/` as bootstrap input (owner, 2026-11-15); links in AGENTS, README, GAPS, TODO and DONE point there, and BOOT's file tree lists itself under `input/`.
- `UPSTREAM_BASELINE.md` renamed to `BASELINE.md`, then moved to [ext/input/BASE.md](input/BASE.md) (owner, 2026-11-15), title "Baseline", with all live references. `ext/input/` now holds bootstrap material rather than only frozen input: the spec stays frozen, and BASE gains a section per upstream sync (AGENTS layout, STYLE documents).

### Deviations

- Spec §17.4 and BOOT call the file `UPSTREAM_BASELINE.md`. Both are input and keep the old name.
- Commit `254ad1fc` and the file on disk lack the seven edits that adapted BOOT to the spec's move into `ext/input/` (step 1 state, the GAPS Q1 variants, the file tree, the names). An editor save of the BOOT intro most likely overwrote them before the commit. BOOT therefore still describes the spec at `ext/` root; restoring the edits is the owner's call.

### Insights

- Upstream writes nothing but protocol to stdout (its logger goes to stderr), and it keeps tool descriptions in English on purpose, because models route on their wording; only about 150 strings a person reads are translated. Both rules are in STYLE now.

## 2026-11-15 13:23 — The product covers every kind of workflow

TODO items: 0.2, 2.1. Branch `architect/spec`, not yet committed.

Agent: Opus 5.5, subagents: none.

### Implementation notes

- Owner, 2026-11-15: the product covers every kind of ComfyUI workflow, and images are the MVP's scope only. IDEA gained a scope paragraph and an approach item for contracts that work for every kind; AGENTS's scope decisions say the same.
- ROAD gained phase 6, "Every kind of workflow", in place of the unscheduled idea for video and audio recipe families. GAPS Q10 asks which kind follows images. TODO 2.1 keeps image-specific fields in a kind-specific part of the schemas.

### Deviations

- The spec treats video and audio as later work (FR-17, "Later") and its TaskSpec example is image-shaped (§7.2). The contracts now generalise it, so adding a kind needs no migration of the core records.

### Insights

- Upstream has many video packs and skills, but audio exists only as a generation tool and as sound in LTX 2.3 video packs. Audio would start with less to build on than video.

## 2026-11-15 13:19 — Key project documents and writing style

TODO items: 0.2, 0.3.1, 0.4.1, 1.1.1. Branch `architect/spec`, not yet committed.

Agent: Opus 5.5, subagents: none.

### Implementation notes

- Root `AGENTS.md` and `CLAUDE.md` (`@AGENTS.md`): scope, design rules from the spec, layout, stack, process, style, security, commits. Upstream's `.gitignore` excludes both, so they need `git add -f` once.
- [IDEA](IDEA.md), [GAPS](GAPS.md) (nine questions, eight assumptions), [TODO](TODO.md) (milestone 0 setup, 1 spec Phase 0 in detail, 2 spec Phase 1 in outline), [ROAD](ROAD.md) (the spec's Phases 0–5 with their gates), [BASE](input/BASE.md) (the pinned commit, the checks run on it, the upstream facts the fork relies on), and this file.
- `.claude/STYLE.md`, the writing style for prose, copied from Lakeshore. pitch2canvas has the same file with American spelling; orgfab, orgfab.ai and proclens have an older version without the stop-slop rules. `.claude/` is ignored upstream, so it needs `git add -f` too.
- Swept all new documents with STYLE's grep table and fixed the hits that were habits: a counting head in GAPS Q8 and in BOOT, "deliberate" in AGENTS, GAPS and README, a manufactured contrast in README, sentence headings in BOOT, AGENTS and BASELINE, an absolute and a pull-quote in IDEA. BOOT's "What is different in a fork" became "Fork specifics", and the links to it moved.
- Renamed the product to ComfyUI Architect (owner, 2026-11-15) in AGENTS, BOOT and README; the planned skill is `plugin/skills/comfyui-architect/`.

### Deviations

- The spec plans `plugin/skills/comfy-architect/`; the rename makes it `comfyui-architect`. The spec stays unedited as input.
- Status lines in the new documents were first written with estimated times (13:20 to 13:26) and corrected to the clock.

### Insights

- `check:vocabulary` scans every tracked and untracked file, `ext/` included, so documents may only name current tool names. IDEA describes upstream's features in prose for that reason.
- The README title was already "ComfyUI Architect" when the rename was asked for; the spec, BOOT and the body still said "Comfy Architect".

## 2026-11-15 13:13 — BOOT, README structure, spec as input

TODO items: 0.1, 0.5.1. Commit `254ad1fc` on `architect/spec`.

Agent: Opus 5.5, subagents: none.

### Implementation notes

- [BOOT](input/BOOT.md) adapted from Lakeshore's `docs/BOOT.md`: `ext/` as the docs folder, the upstream files that must change because of upstream's gates, the public repository, the steps with their state, fork-specific options, subagents and hooks.
- README sections Implementation and Compatibility: where the Architect code goes, and the rules that keep the fork a superset of upstream.
- The owner moved the spec unchanged to `ext/input/`, making it frozen input.

### Deviations

- The owner moved the spec while BOOT was being written; BOOT's spec decision was rewritten from "where does the spec live" to "how do the design documents derive from it" (GAPS Q1).
- An earlier reply said commit `874c4489` contained the ChatGPT link; it didn't. The owner had replaced it with a plain line before the commit.

### Insights

- Upstream ignores `/AGENTS.md`, `/CLAUDE.md` and `.claude/` ("Contributors bring their own agent instructions"). Force-adding them keeps upstream's `.gitignore` unchanged.
- Adding an MCP tool touches upstream's README (tool counts), `docs/tools/` and the tool vocabulary, because upstream's CI derives them from the registry and fails on drift.

## 2026-11-15 13:04 — Spec committed

TODO item: 0.1. Commit `874c4489` on the new branch `architect/spec`.

Agent: Opus 5.5, subagents: none.

### Implementation notes

- Committed `ext/README.md` and the spec v1.0.
- Git had no author identity. Set it for this repository only: Gregor Heinrich with the GitHub noreply address, so no private address enters the public history.

## 2026-11-15 12:54 — Fork and assessment

TODO items: 0.6. No commit.

Agent: Opus 5.5, subagents: none.

### Implementation notes

- Analysed upstream at `707474d2` (v0.52.206) before forking; the facts are in [BASE](input/BASE.md). `npm ci` and `npm run lint` passed.
- Forked to the public `gregoryyy/comfyui-mcp` with `gh repo fork --remote`: `origin` is the fork, `upstream` is artokun's repository. Set `gh`'s default repository to the fork, so `gh pr create` targets it, and made `main` track `origin/main`.

Decisions by the owner:
- **Fork, not a separate package.** The spec needs Architect tools in the panel agent on every backend, approvals that gate upstream's own effects, and pausing the agent around a render. Upstream gives the panel agent other MCP servers only on the Claude backend, filters policy per tool rather than per action, and runs the agent loop in the orchestrator with no hook for pausing. The planning domain, recipes and skills would work outside a fork; these three wouldn't.
- **Keep the fork public.** A fork of a public repository can't be private. Public means free Actions minutes and direct PRs to upstream; the price is that everything committed is public for good.

### Insights

- Upstream activity fell from 2,045 commits in August to 61 in October and 1 in November, so syncs will likely be small for now. `src/orchestrator/panel-tools.ts` (31,000 lines) is where conflicts would concentrate.
- Upstream's `ci.yml` keeps the comment of an Oxlint gate removed in `1d5b12b1` (#2928) with no step under it. A one-line upstream fix.
- The spec's §18.2 covers the fork's package identity but not upstream's hardcoded `PACKAGE_NAME` in self-update, which would replace the fork with upstream.
