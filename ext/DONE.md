# Done

The progress log, newest entry on top. Each entry: `## YYYY-MM-DD HH:MM — Title` (time from `date`), the TODO items and PR or commit, an `Agent:` line, then **Implementation notes**, **Deviations** and **Insights**. The plan is in [TODO](TODO.md).

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
