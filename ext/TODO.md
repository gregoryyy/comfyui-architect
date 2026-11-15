# TODO

The plan: milestones (`## 1.`), tasks (`1.1`) and subtasks (`1.1.1`) with checkboxes. Numbers never change; new work gets new numbers. *(decision)* marks a choice to settle before dependent work starts, *(variant)* an alternative built for comparison. When an item is done, tick it here and add an entry to [DONE](DONE.md); the process is in [AGENTS](../AGENTS.md#process). Phases beyond the current milestones are in [ROAD](ROAD.md), questions for the owner in [GAPS](GAPS.md). Status: 2026-11-15 13:29.

Goal: the spec's first usable MVP, an approved candidate that executes locally and records its outcome (ROAD phase 2). Milestone 1 is spec Phase 0, milestone 2 spec Phase 1. Spec section numbers (§) refer to the [spec v1.0](input/comfy-architect-system-spec.md).

## 0. Project setup and initial inputs

The steps of [BOOT](input/BOOT.md), on 2026-11-15.

- [x] 0.1 Collect the input: the spec v1.0 in `ext/input/`
- [x] 0.2 Assess it and state the idea: [IDEA](IDEA.md), [GAPS](GAPS.md); the fork assessment in the first DONE entry
- [ ] 0.3 Design concept and security
  - [x] 0.3.1 `AGENTS.md`, `CLAUDE.md` at the root, force-added past upstream's `.gitignore`
  - [ ] 0.3.2 The design authority according to GAPS Q1 *(decision)*: `ext/design/SPEC.md` as a working copy *(variant, proposed)*, or the spec split into the standard documents *(variant)*
  - [ ] 0.3.3 `ext/SEC.md` from spec §14, plus what the fork brings: the public repository, upstream's HTTP transport and tunnel, the panel bridge, custom nodes
- [ ] 0.4 Plan
  - [x] 0.4.1 This file, [ROAD](ROAD.md), [DONE](DONE.md), [BASE](input/BASE.md)
  - [ ] 0.4.2 `ext/ARCH.md` with the decision log, and `ext/EVAL.md` from spec §19, as GAPS Q1 decides
- [ ] 0.5 Readable and buildable
  - [x] 0.5.1 `ext/README.md`, [BOOT](input/BOOT.md)
  - [ ] 0.5.2 Process and conventions
    - [ ] 0.5.2.1 `ext/SDLC.md` (AGENTS holds the process until then)
    - [x] 0.5.2.2 [STYLE](STYLE.md): code, tools and interfaces, written output, and the writing style from Lakeshore
    - [ ] 0.5.2.3 `ext/SBOM.md`
  - [ ] 0.5.3 `.github/pull_request_template.md` with the definition of done
- [x] 0.6 Version control: public fork `gregoryyy/comfyui-mcp` with `origin` and `upstream`, `gh` defaulting to the fork, noreply commit identity
- [ ] 0.7 Remaining setup items
  - [ ] 0.7.1 Owner answers the blocking GAPS questions: Q1 (design authority), Q2 (package name), Q3 (versions), Q5 (target), Q6 (Actions)
  - [ ] 0.7.2 Licence of the additions according to GAPS Q4
  - [ ] 0.7.3 Automatic deletion of merged branches in the fork's settings

## 1. Reproducible fork and seam audit (spec Phase 0)

Exit (spec §20): the fork launches from an installed package, identifies itself correctly, works with an external MCP client and the stock panel, and preserves upstream behaviour with Architect disabled. Baseline failures are recorded, not attributed to the new layer.

- [ ] 1.1 Baseline run on `707474d2`, recorded in [BASE](input/BASE.md)
  - [x] 1.1.1 `npm ci`, `npm run lint`, `check:vocabulary`, `check:unknown-collapse` (2026-11-15)
  - [ ] 1.1.2 `npm run build`, `npm test`, `asset-counts --check`, `vocab:export -- --check`, `docs:gen` as a no-op, the pack and install smoke (`scripts/smoke-install.mjs`)
  - [ ] 1.1.3 The integration suite against the reference ComfyUI (`npm run test:integration`), with the target from GAPS Q5
- [ ] 1.2 Environment and surface record, as a research note
  - [ ] 1.2.1 The reference target's hardware, ComfyUI version, node classes and installed model families (GAPS Q5)
  - [ ] 1.2.2 The installed Ollama models (GAPS Q9)
  - [ ] 1.2.3 Upstream's tool surface (direct and compact) and panel surface at the baseline, as the reference for 1.5
  - [ ] 1.2.4 The stock panel's connection behaviour with autospawn off (GAPS A6) and with two servers present (A5)
- [ ] 1.3 Fork identity, according to GAPS Q2 and Q3
  - [ ] 1.3.1 `package.json`: `name`, `bin`, `mcpName`, `repository`, `homepage`, `version`; `architect/` in `files`
  - [ ] 1.3.2 `PACKAGE_NAME` in `src/services/self-update.ts`, with a test that self-update never resolves upstream's package
  - [ ] 1.3.3 `server.json` and `.claude-plugin/marketplace.json`
  - [ ] 1.3.4 `ext/input/BASE.md` and build metadata carry the upstream commit (spec §17.4)
- [ ] 1.4 Startup handshake (spec §18.2): package identity, fork version, upstream commit, Architect schema version, active policy, available features; no secrets. The likely seam is `src/handshake-instructions.ts`, whose instructions have byte ceilings (2048 for stdio, 1024 for the panel)
- [ ] 1.5 Feature flag
  - [ ] 1.5.1 Configuration read in one place (`src/config.ts`), default off
  - [ ] 1.5.2 A test that the tool list, the compact catalog and the panel surface with the flag off equal the 1.2.3 record (spec AT-12)
- [ ] 1.6 Facade and service skeleton
  - [ ] 1.6.1 `src/services/architect/schemas.ts`: the envelope and `schemaVersion` conventions (spec §7, §16.2)
  - [ ] 1.6.2 `src/services/architect/upstream.ts`: the facade interface over the inherited services the first slice needs, with contract tests
  - [ ] 1.6.3 `src/services/architect/service.ts`: the service boundary with injected facade, store, clock and hash service (spec §16.3)
- [ ] 1.7 Tool registration seam: the Architect tool group in `src/tools/index.ts`, behind the flag, through the existing registrar so the tool-surface policy and compact `call_tool` cover it (spec §14.3)
- [ ] 1.8 Upstream gates with the first Architect tool: README counts (`asset-counts --check`), a `docs/tools/` page and its `CATEGORIES` entry in `scripts/gen-tool-docs.ts`, `docs/design/tool-vocabulary.json`
- [ ] 1.9 CI on the fork according to GAPS Q6: Actions enabled, tag workflows disabled, the PR template (0.5.3)
- [ ] 1.10 Smoke fixture: the installed tarball launches outside the repository, identifies itself, serves an external MCP client and the stock panel with autospawn off
- [ ] 1.11 Upstream sync dry run: a `sync/upstream-…` branch merges `upstream/main`, passes the suite, records the new baseline, so the procedure is proven before it's needed

## 2. One end-to-end planning slice (spec Phase 1)

Exit (spec §20): a user can describe an image task, compare installed-asset candidates and obtain an editable graph with explicit constraints and provenance. No downloads, no automatic execution. Detailed when milestone 1 is done.

- [ ] 2.1 Domain schemas with migration tests: `TaskSpec`, `EnvironmentSnapshot`, `Recipe`, `PlanCandidate` (spec §7.1), with image-specific fields in a kind-specific part, so video and audio later add a kind without a migration of the core records (AGENTS, scope decisions)
- [ ] 2.2 `architect.db`: store, WAL, migrations, the planning tables (spec §15)
- [ ] 2.3 Environment snapshot through the facade, with freshness and probe errors (spec §8.3)
- [ ] 2.4 Local catalog and three curated recipes for the families chosen in GAPS Q5 (spec §8)
- [ ] 2.5 `architect_inspect` and the planning actions of `architect_plan` (spec §16.1)
- [ ] 2.6 Template binding and layered validation, one task to a validated export (spec §10)
- [ ] 2.7 The skill `plugin/skills/comfyui-architect/` and the command `plugin/commands/architect.md`
