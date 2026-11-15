# Bootstrapping a project

How ComfyUI Architect gets set up, from raw idea to a fork that agents and people can work in. The steps come from Lakeshore's `docs/BOOT.md`. Here it's adapted to a project that extends a fork of `artokun/comfyui-mcp` instead of starting from an empty repository. The fork was created on 2026-11-15 at 12:54 from upstream commit `707474d2` (v0.52.206). Use this as the checklist for the steps still open. Status: 2026-11-15 13:07.

## Fork specifics

Lakeshore started from an empty repository. ComfyUI Architect lives inside someone else's.

**`ext/` is the docs folder.** Everything Lakeshore keeps in `docs/` lives in `ext/` here. Upstream's `docs/` is its published documentation site (`docs/docs.json`, 13 locales, a generated tool reference), and upstream's gates check it: `check:docs-links`, `check:docs-locale`, `check:docs-mdx` and the blog checks. Architect documents there would end up in upstream's site structure, trip those gates and conflict on every sync. `docs/` only receives what upstream's tooling generates from Architect code (below).

**Upstream files stay nearly untouched.** Every edit to an upstream file can conflict on each sync. Architect code goes into new directories (spec §17.1), and upstream files get small, named seams only. Some upstream files must change anyway, because upstream's own gates require it once Architect tools exist:

| File | Why it changes | Gate |
| --- | --- | --- |
| `src/tools/index.ts` | Registers the Architect tool group (spec §17.2) | — |
| `README.md` (upstream's) | The advertised tool count (`**N MCP tools**`, `N tools across`) must match the registry | `scripts/asset-counts.mjs --check` |
| `docs/tools/*.mdx`, `scripts/gen-tool-docs.ts` | Tool pages are generated from the schemas; a new tool needs a page and a `CATEGORIES` entry | `npm run docs:gen` must be a no-op |
| `docs/design/tool-vocabulary.json` | The panel copies the tool vocabulary from here | `npm run vocab:export -- --check` |
| `package.json` | Fork identity (`name`, `mcpName`, `repository`, `homepage`), and `architect/` in `files` | Pack and install smoke |
| `src/services/self-update.ts` | `PACKAGE_NAME` is hardcoded to `comfyui-mcp`; unchanged, self-update replaces the fork with upstream. Spec §18.2 doesn't mention it yet | — |
| `server.json`, `.claude-plugin/marketplace.json` | Fork identity for the MCP registry and the plugin marketplace | — |

`npm run check:vocabulary` scans every tracked file, `ext/` included, for retired tool names. A retired name in an `ext/` document fails CI. It passed with the spec committed (2026-11-15, `874c4489`). The docs-link checks cover `docs/` only, so links in `ext/` aren't checked.

**The repository is public.** A fork of a public repository can't be private, and the owner decided on 2026-11-15 to keep it public. Everything committed is public for good, including history: pushed commits stay reachable through upstream's fork network even after deletion. Confidential input stays out of the repository. Commits use the GitHub noreply address (set repo-local on 2026-11-15).

## The steps

| # | Step | Produces | ComfyUI Architect |
| --- | --- | --- | --- |
| 1 | Collect the input | `ext/input/` | Open. The source is the ChatGPT conversation linked from `ext/README.md`; nothing is copied yet |
| 2 | Assess it critically, state the idea, list the gaps | `ext/IDEA.md`, `ext/GAPS.md`, notes in the first DONE entry | Open. Spec §1–3 is the starting point; the fork assessment of 2026-11-15 goes into DONE |
| 3 | Write the design concept and its security implications | `ext/design/`, `ext/SEC.md`, `AGENTS.md`, `CLAUDE.md` | Concept and security are in the spec (§4–14), `874c4489`. AGENTS and CLAUDE are open |
| 4 | Plan the architecture, evaluations and work | `ext/ARCH.md`, `ext/EVAL.md`, `ext/TODO.md`, `ext/ROAD.md`, `ext/DONE.md` | Architecture (§5, §15–18), evaluation (§19) and phases (§20) are in the spec. TODO and DONE are open |
| 5 | Make it readable and buildable; set the process and conventions | `ext/README.md`, this file, `ext/SDLC.md`, `ext/STYLE.md`, `ext/SBOM.md` | `ext/README.md` is a draft (`874c4489`); this file. SDLC, STYLE and SBOM are open |
| 6 | Put it under version control | Public fork, remotes, working branch | Done 2026-11-15 12:54: `gregoryyy/comfyui-mcp`, branch `architect/spec` |
| 7 | Start the foundation, then TODO mode | TODO 0 remainder, then TODO 1 (spec Phase 0) | Not started |

**The spec and the standard documents** *(decision)*. `ext/comfy-architect-system-spec.md` already covers most of what Lakeshore splits into IDEA, design concept, SEC, ARCH, EVAL and ROAD. Two ways to go on:
- *(variant, proposed)* The spec stays the one design authority and is renamed to `ext/design/SPEC.md`, upper case as a central document. IDEA, SEC, ARCH, EVAL and ROAD are written only where the spec doesn't already say it, and they link to its sections rather than repeat them. TODO, DONE, GAPS, AGENTS, SDLC, STYLE and SBOM are new, since the spec has no equivalent.
- *(variant)* The spec v1.0 is frozen in `ext/input/` as the record of where the design came from, and its content is split into the standard documents, which then evolve on their own. This is cleaner later but duplicates 1,000 lines now.

### 1. Collect the input

Put the raw material in `ext/input/`: original notes, conversations with other assistants, sketches, links. Don't edit it later. It's the record of where the idea came from, and later documents cite it. Unlike Lakeshore, nothing in this repository is confidential, because the repository is public. Input that shouldn't be published stays outside it, for example in a private repository or local notes that `ext/input/` only names. The spec came out of a ChatGPT conversation; an export of it belongs here only if it's fine to publish.

### 2. Assess it critically

Before designing anything, read the input as a reviewer. Separate the claims that survive from flattery and invented market gaps. Check the competitive landscape as it is today: upstream itself, Comfy-Org's agent tooling (Comfy Cloud MCP, the in-app agent, Comfy Local MCP), and other ComfyUI MCP servers. Write down what the product has to beat; the spec's own baseline is stock upstream on the same tasks (§19.3). The reasoning goes into the first DONE entry, and the result into `ext/IDEA.md`: the purpose, the users and their added value, and the approach, including the innovation pursued if there is one. Be honest there about what isn't new.

The first DONE entry also records the fork assessment of 2026-11-15:
- **Why a fork is needed:** the sidebar agent picks up separate MCP servers only on the Claude backend (`src/services/user-mcp-config.ts`). Upstream's tool policy is per tool, not per action (`src/tools/tool-surface-filter.ts`). Pausing reasoning around a render happens inside the orchestrator's turn loop.
- **What doesn't need it:** the planning domain, recipes, rules and skills.
- **Upstream activity:** 2,045 commits in August, 61 in October, 1 in November up to the fork.
- **The hotspot:** `src/orchestrator/panel-tools.ts`, 31k lines, touched by 143 of the last 500 source commits.

Optionally write `ext/SOTA.md`, the state of the art, condensed from the research notes with a link for every claim.

Start `ext/GAPS.md` at the same time. It lists **questions** for the owner (`Q1` …, each with why it matters, a proposed answer where there is one, and an answer line) and **assumptions** that seemed clear enough not to ask (`A1` …, each with its basis and a correction column). **Every answer is recorded with date, time and author**. If an answer changes, the new one is added and the earlier ones stay, so nothing is overwritten silently. Answered entries move into the document they affect and get a `Resolved` line saying when, by whom and where. Questions that block a milestone are marked blocking. First candidates: the spec decision above, the package name, the panel fork (spec §3.2), and which model families the first recipes certify (spec §2.2).

### 3. Write the design concept

`ext/design/` holds the design documents. Central ones are upper case (the spec, once moved); other design notes are lower case. Mockups are ASCII in fenced `text` blocks, at 100 columns or fewer.

`ext/SEC.md` covers the assets, data protection obligations, threats with their consequences for the design, controls by phase and how they're verified. The spec's §14 (policy, approvals, trust boundaries) is the basis. Add what the fork brings with it: a public repository, upstream's HTTP transport and tunnel, the panel bridge, and third-party custom nodes.

**`AGENTS.md` and `CLAUDE.md` sit at the root, but upstream ignores them.** Upstream's `.gitignore` excludes `/AGENTS.md` and `/CLAUDE.md` ("Contributors bring their own agent instructions"). Add them with `git add -f` once. A tracked file isn't affected by an ignore rule, so upstream's `.gitignore` stays unchanged and syncs stay clean. `CLAUDE.md` contains only `@AGENTS.md`. Root placement keeps both Claude Code and Codex finding them.

`AGENTS.md` covers:
- what the project is;
- the layout, with `ext/` as the docs folder and the Architect code paths;
- the stack: upstream's, TypeScript on Node 22 with Zod, Vitest and SQLite (spec §17.3);
- the process and the docs conventions;
- the design rules that need a deliberate decision to change;
- security;
- the fork rules: the upstream footprint above, keeping commits that could go upstream separate from Architect commits, and upstream's conventions (`CONTRIBUTING.md`, conventional commits).

### 4. Plan

- `ext/ARCH.md`: the architecture to be built: principles, components, data model, flows, trust boundaries, budgets, open decisions and the decision log. The spec holds most of it (§5, §15–18); under the proposed variant, ARCH holds the decision log and links to the spec for the rest.
- `ext/EVAL.md`: evaluations of the project's claims. Questions or hypotheses, baselines, fixtures, procedure, measures, success and stop criteria, limitations, all defined before running. Spec §19 defines the acceptance suite (AT-01 to AT-12) and the comparison with stock upstream. Distinguish proposed targets (the 90% of AT-04) from observed results.
- `ext/TODO.md`: the plan. Numbered milestones (`## 1. …`), tasks (`1.1`) and subtasks (`1.1.1`) with checkboxes. Tag choices as *(decision)* and alternatives as *(variant)*. Never renumber.
  - **Milestone 0** is project setup: the steps in this file, ticked as they're done, plus the spec decision, GAPS answers and the PR template.
  - **Milestone 1** is spec Phase 0, the reproducible fork:
    - a baseline run of upstream's gates;
    - the fork identity (the footprint table above, including `self-update.ts`);
    - `ext/UPSTREAM_BASELINE.md` (spec §17.4);
    - the feature flag, the facade skeleton and the smoke fixture.
  - Later milestones follow the spec's §20.1 priorities.
- `ext/ROAD.md`: phases with a goal and a measured gate each. The spec's Phases 0–5 (§20) are the phases, and their *Exit* lines are the gates. A phase becomes TODO milestones when it starts.
- `ext/DONE.md`: the progress log, newest entry on top. Each entry has:
  - the heading `## YYYY-MM-DD HH:MM — Title` (time taken from `date`);
  - TODO items and PR;
  - the agent (`Agent: Opus 5.5, subagents: none.`), without a reasoning level, since the agent can't see it;
  - **Implementation notes**, **Deviations** and **Insights**.

  Start it with entries for the steps already taken: the fork (2026-11-15 12:54), the spec commit (13:04) and this file.

When the first work is studies or prototypes, frame each by one question and end it with a recorded review. A prototype of read-only planning as a separate MCP server (no fork needed for that slice) is an example.

### Subprojects and document precedence

A subproject may have its own version of any standard document. Within its declared scope, the local version supersedes the root one; root documents stay the defaults elsewhere. Each local document states what it supersedes and what it inherits, and the subproject README links to them. Qualify local references so their numbers are unambiguous (`panel TODO 2.1`, `TODO 1.3`).

A subproject's documents are in `ext/<name>/` and its code under `src/services/architect/<name>/`, with tests in `src/__tests__/architect/<name>/`. The likely first subproject is the companion panel change (spec §3.2, Phase 4). Its code lives in a separate fork of `artokun/comfyui-mcp-panel`. *(decision)* Its documents go in that fork's own `ext/` or here in `ext/panel/`.

### 5. Make it readable and buildable

- **`ext/README.md`:** what ComfyUI Architect is in two paragraphs, its status, a map of the `ext/` documents, how to build, and the layout. Upstream's `README.md` stays upstream's, apart from the tool counts its gate requires.
- **Build:** upstream's npm scripts are the entry point: `npm ci`, `npm run lint`, `npm run build`, `npm test`. Every PR also passes the CI-only gates (`asset-counts --check`, `check:vocabulary`, `check:unknown-collapse`, `vocab:export -- --check`, `docs:gen` as a no-op) and the pack smoke test. A `justfile` is added only with the PDF option.
- **`ext/SDLC.md`:** the development process that AGENTS refers to: lifecycle, work items, branches and PRs, definition of done, testing, studies, TODO mode, decisions, releases. It also covers the upstream sync:
  - branch `sync/upstream-YYYY-MM-DD` from `main`;
  - `git merge upstream/main`;
  - run upstream's suite unchanged (spec §17.4);
  - open a PR.

  Merge rather than rebase, since `main` is public and PRs build on it.
- **`ext/STYLE.md`:** code style, interface conventions and written output. For code, upstream's existing style applies (comments that explain why, issue references, Zod at the boundaries).
- **`ext/SBOM.md`:** rules for software and libraries, the licence policy, the toolchain and the major dependencies. The details stay in upstream's `package.json` and `package-lock.json`, and spec §17.3 lists what not to add. Upstream's `.github/dependabot.yml` comes with the fork. Upstream is MIT; keep its `LICENSE` and decide the licence of Architect additions explicitly.
- **PR template:** `.github/pull_request_template.md` with the definition-of-done checklist. Upstream has none, so it's a new file. `.editorconfig` is only worth adding if it matches upstream's formatting.
- **`ext/research/README.md`:** the index and format for research notes. Research informs; decisions stay with GAPS and the affected documents.
- **Optionally `ext/GLOS.md`:** the glossary, once the documents outgrow one reader's memory. The spec already coins many terms: TaskSpec, recipe, grant, lease, certified, `OUTCOME_UNKNOWN`.
- **`ext/.gitignore`:** ignore rules for anything generated under `ext/` (`*.md.pdf`, `.pdfstamps/`). A nested ignore file keeps upstream's `.gitignore` unchanged. Secrets, dependencies and caches are already covered by upstream's.

### 6. Put it under version control

Done on 2026-11-15, as a fork rather than `git init`:

```bash
gh repo fork --remote              # in the upstream clone: origin -> gregoryyy, upstream -> artokun
gh repo set-default gregoryyy/comfyui-mcp
git branch -u origin/main main
git switch -c architect/spec       # ext/ committed here, 874c4489
```

**Branches and remotes:**
- `main` on the fork is the integration branch. It changes only through PRs on the fork, and only the owner merges.
- `upstream/main` is the tracking branch and is never pushed to.
- `gh` defaults to the fork, so `gh pr create` doesn't target upstream by accident.

**Contributing upstream:** this is a real fork, so contributing works directly. Branch from `upstream/main`, cherry-pick the commits meant for upstream, push the branch to `origin` and open the PR against `artokun/comfyui-mcp`.

**GitHub Actions** is off on the fork until it's enabled. Public repositories run it at no cost. Enabling it also arms upstream's tag workflows: `release.yml` (`npm publish` on `v*` tags) and `mcp-registry.yml`. `npm run release` pushes such a tag. Before enabling Actions, disable those two workflows, or point them at the fork's identity and secrets.

### 7. Start the first milestone

Work on TODO 1 (spec Phase 0) on feature branches: baseline report, fork identity, CI, PR template, licence. Each PR ticks its TODO items and adds a DONE entry. Phase 0's exit gate:
- the fork launches from an installed package and identifies itself correctly;
- it works with an external MCP client and with the stock panel (autospawn off, `COMFYUI_MCP_NO_AUTOSPAWN=1`);
- with Architect disabled, it behaves exactly like upstream.

## TODO mode

Once the foundation is in place, the remaining work can be handed to a coding agent by starting **TODO mode** with one message:

> **TODO mode:** Work through the remaining TODO.md milestones in order, completing required tests and documentation and opening a separate PR for each milestone. Continue until all actionable milestones are complete or a documented blocker requires user input.

This works because the setup above gives the agent everything it needs:
- **What to do:** `ext/TODO.md`, in order, with numbered items it can reference.
- **How to do it:** `AGENTS.md`: branches, tests, docs conventions, design rules, security, the fork rules.
- **With what:** the model size and reasoning effort each task needs ([below](#claude-code-subagents-and-hooks)).
- **When it's done:** each milestone is one PR on the fork. Upstream's suite and the Architect tests pass, its TODO items are ticked, and a DONE entry sits on top.
- **When to stop:** any of these:
  - a blocking GAPS question;
  - a *(decision)* item the agent can't settle from the docs;
  - a failing gate;
  - missing access;
  - a needed change to an upstream file outside the footprint table.

  The agent records the blocker in GAPS, DONE and the PR, then asks for input.

TODO mode is part of the development process, and SDLC is where its rules are maintained once it exists, including how milestone PRs are based so they merge cleanly in order. A PR into upstream is never part of TODO mode; it's a separate decision by the owner.

Review the PRs as they come in. A deviation recorded in DONE is the agent's way of saying where the plan didn't survive contact with the code.

## Options

Parts of the setup that a project adopts when it benefits. None is adopted yet.

| Option | In ComfyUI Architect |
| --- | --- |
| [Markdown to PDF](#markdown-to-pdf) | Not adopted |
| [Local CI](#local-ci) | Not needed while hosted Actions is free for the public fork; available as a fallback |
| [Assurance and lineage](#assurance-and-lineage) | Not adopted; the spec's lineage requirement (FR-11) is product data, not this option |
| [Claude Code subagents and hooks](#claude-code-subagents-and-hooks) | Not adopted |

### Markdown to PDF

Every Markdown document under `ext/` gets a PDF next to it (`foo.md` → `foo.md.pdf`): pandoc renders it to HTML, and headless Chrome prints it to A4. Only changed documents are rebuilt, tracked by content hashes in `.pdfstamps/`. Copy the document section of Lakeshore's `justfile` to a new root `justfile` (upstream has none). Put `style.css`, `mermaid.html` and `latex.lua` in `ext/utils/pdf/`, and restrict the recipes to `ext/`, so upstream's Markdown isn't converted. The ignore rules go in `ext/.gitignore`. Needs pandoc and Google Chrome; TeX Live only for documents with ```` ```latex ```` blocks.

### Local CI

When hosted CI is unavailable, keep the workflow file as the one definition and run it locally: Lakeshore's `utils/ci/` reads `.github/workflows/ci.yml` from the commit, runs its `run:` steps in a clean worktree and maps each action to a local equivalent. Upstream's `ci.yml` uses only `actions/checkout` and `actions/setup-node` plus `run:` steps, so it maps. The OS matrix runs as the local OS only. If adopted, the tool goes in `ext/utils/ci/`, and `just ci --post` sets commit statuses through the API without Actions.

### Assurance and lineage

Propeller's assurance tracker (requirements, plans, commits, tests and confirmations in append-only ledgers), as Lakeshore adopted it in Python. For this project it would have to be reimplemented for TypeScript and Vitest, or kept as a separate tool that reads the repository. Worth considering once spec requirements (FR-01 …) and acceptance tests (AT-01 …) are linked to code; the spec's IDs are ready for it.

### Claude Code: subagents and hooks

With a coding agent doing most of the work (TODO mode), two Claude Code features keep it on the rails: **subagents** take on jobs that need their own context or an independent view, and **hooks** enforce the rules mechanically. Subagents live in `.claude/agents/*.md` and hooks in `.claude/settings.json`. Upstream's `.gitignore` excludes `.claude/`, so these files are added with `git add -f`, like `AGENTS.md`. Hook scripts go in `ext/utils/hooks/` with tests. Don't confuse them with `plugin/hooks/`, which are the product's hooks for its users.

**Subagents, by use case:**

| Agent | Use case | Tools | Why separate |
| --- | --- | --- | --- |
| **Implementer** | Writes a TODO item's code and tests; fixes a failing check from its output | All | Keeps the orchestrating context small |
| **Assurance** | At the end of a milestone: checks the design rules, SEC, the upstream footprint and the definition of done, writes the security impact part of the PR, raises GAPS questions | Read, search, `git diff` | Must not be the author: it gets the diff and the requirement texts, not the author's reasoning |
| **Upstream syncer** | Merges `upstream/main` into a sync branch, runs upstream's suite, regenerates generated files (`docs:gen`, `vocab:export`, README counts), reports what needs judgement | Shell, read, edit | Mechanical, so a small model; keeps conflict noise out of the main context |
| **E2E runner** | Runs integration tests against a live ComfyUI (`npm run test:integration`), returns only failures | Shell, read | Long test output stays out of the main context |
| **Gap researcher** | Writes one research note on one GAPS question in `ext/research/` | Read, web, write in `ext/research/` only | Research informs; it doesn't decide |

**Hooks, by use case:**

| Hook | Use case |
| --- | --- |
| **Stop** | Run the fast checks (`npm run lint`, the Architect unit tests) before the agent ends a turn; on failure it keeps working |
| **PreToolUse on Edit and Write** | Deny edits to `ext/input/`; deny anything that looks like an API key or private key; warn on edits to upstream files outside the footprint table |
| **PreToolUse on Bash** | Block `git commit` on `main`, pushes to `main` or to the `upstream` remote, `gh pr create` against `artokun/*`, `git push --force` without `--with-lease`, `gh pr merge`, and `npm run release*` |
| **PostToolUse on edits to `ext/DONE.md`** | Check that a new entry's timestamp comes from the clock (within minutes of `date`), not an estimate |
| **SessionStart** | Print the branch, `git status`, the open PR, the date and how far `main` is behind `upstream/main` |

Leave out hooks that commit, push or open PRs on their own (they would bypass the owner's confirmation) and slow suites (upstream's full `npm test` and integration tests belong to CI and the E2E runner).

**Model size and reasoning effort, by task.** Pick both to fit the task: what an error would cost, and how much judgement it takes.

| Task | Model | Effort |
| --- | --- | --- |
| Designs, contracts, policy and grants, security, seams in upstream files, reviews; root-causing a failure nobody understands yet | the largest | high |
| Implementing a TODO item to its design; tests with negative cases | the largest or the standard | medium to high |
| Mechanical work: upstream syncs by rule, regenerating files, bookkeeping in DONE, TODO and PR text, renames | a smaller, faster one | low |
| Subagents that search, summarize or run checks and return only their result | a smaller one, unless the result decides something | low to medium |

When in doubt, go up. Never go down for a security change or an edit to upstream code. An agent can't always change its own model or effort mid-session, so it applies the rule to the subagents it starts, and tells the owner when the session's setting doesn't fit the next task. DONE records the model, not the effort.

## File structure

The target layout. Entries marked *(open)* don't exist yet; the authoritative layout will be in AGENTS once it's written.

```text
comfyui-mcp/                    the fork; everything not listed is upstream's
├── AGENTS.md                   rules for agents and contributors (open; force-added)
├── CLAUDE.md                   @AGENTS.md (open; force-added)
├── README.md                   upstream's; only the tool counts change
├── package.json                upstream's, with the fork identity (open)
├── .claude/                    agents and settings (option; force-added)
├── .github/
│   ├── pull_request_template.md   (open)
│   └── workflows/              upstream's; release and registry disabled or retargeted
├── ext/                        the project's docs folder
│   ├── README.md               what it is, status, document map, build, layout
│   ├── comfy-architect-system-spec.md   the spec (to design/SPEC.md, decision)
│   ├── IDEA.md GAPS.md SEC.md ARCH.md EVAL.md        (open)
│   ├── TODO.md ROAD.md DONE.md                       (open)
│   ├── SDLC.md STYLE.md SBOM.md                      (open)
│   ├── UPSTREAM_BASELINE.md    pinned upstream commit (open, spec §17.4)
│   ├── GLOS.md SOTA.md         (optional)
│   ├── design/                 central design documents and notes (open)
│   ├── research/               research notes (open)
│   ├── input/                  raw input, not edited, publishable only: this file (moved 2026-11-15)
│   ├── utils/                  pdf/, ci/, hooks/ (options)
│   └── .gitignore              generated files under ext/ (open)
├── architect/                  recipes/, rules/, fixtures/ (open, spec §17.1)
├── src/
│   ├── services/architect/     the Architect domain (open, spec §17.1)
│   ├── tools/architect.ts      MCP registration (open)
│   └── __tests__/architect/    unit, contract and integration tests (open)
├── plugin/
│   ├── skills/comfyui-architect/ (open)
│   └── commands/architect.md   (open)
└── docs/                       upstream's site; Architect adds generated tool pages only
```

**Names:** upper case only for documents of central importance (`README.md`, `IDEA.md`, `ARCH.md`, `EVAL.md`, `SEC.md`, `GAPS.md`, `SDLC.md`, `STYLE.md`, `SBOM.md`, `TODO.md`, `ROAD.md`, `DONE.md`, `BOOT.md`, `UPSTREAM_BASELINE.md`, the optional `GLOS.md` and `SOTA.md`, the spec once moved). Everything else is lower case: input, research, notes, code.
