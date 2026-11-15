# Development process

How work moves from a TODO item to merged, documented, tested code on the fork, and how the fork stays in step with upstream. It applies to people and agents alike. Style is in [STYLE](STYLE.md), dependencies in [SBOM](SBOM.md), security in [SEC](SEC.md); [AGENTS](../AGENTS.md#process) summarizes this file. Status: 2026-11-15 14:43.

## Work items

- **TODO is the plan.** Milestones (`## 1.`), tasks (`1.1`), subtasks (`1.1.1`); numbers never change, new work gets new numbers. *(decision)* items are settled before dependent work starts.
- **GAPS holds what only the owner decides.** A question that blocks a milestone is marked blocking; work never proceeds on a blocking question without the owner's answer.
- **ROAD holds the phases.** A phase becomes TODO milestones when it starts.
- **DONE records every completed item** with the TODO numbers, the PR or commit, the agent, and what deviated from the plan.

## Branches and pull requests

- `main` on the fork changes only through PRs. Only the owner merges; agents never run `gh pr merge` or push to `main`.
- Branches: `feat/…`, `fix/…`, `chore/…`, `docs/…`, `sync/…`, one topic each. A branch that builds on an unmerged one starts from it, targets `main`, and says so in the PR.
- PRs are opened on `gregoryyy/comfyui-architect` (`gh pr create --repo gregoryyy/comfyui-architect`), never on upstream. PR text follows [STYLE](STYLE.md#commits-and-pull-requests): neutral, third person, no agent signature.
- Commits: conventional commits with a `Refs:` trailer ([STYLE](STYLE.md#commits-and-pull-requests)). Commits meant for upstream contain nothing Architect-specific.
- After a merge, work continues from the updated `main`; merging `main` into a branch to update it is fine.

## Definition of done

- **Tests** for the change; policy, approval and lifecycle behaviour always with negative cases (SPEC §19.1).
- **Checks pass:** `npm run lint`, `npm run build`, `npm test`, and the CI-only gates (`node scripts/asset-counts.mjs --check`, `npm run check:vocabulary`, `npm run check:unknown-collapse`, `npm run vocab:export -- --check`, `npm run docs:gen` as a no-op). A failure that also occurs on the baseline ([input/BASE](input/BASE.md)) is recorded as such, not attributed to the change.
- **Architect off still means upstream:** the feature-flag-off tests pass (SPEC AT-12).
- **Docs current:** AGENTS layout, the affected `ext/` documents, generated tool pages.
- **Security impact** stated in the PR against [SEC](SEC.md).
- **TODO ticked and a DONE entry** on top.
- **Upstream footprint:** any change to an upstream file outside the seams in [ARCH](ARCH.md#upstream-footprint) is named in DONE and the PR, and added to that list.

The PR template (`.github/pull_request_template.md`) carries this list.

## Testing

- **Unit and contract tests** run in CI with fixtures and mocks: no GPU, no model downloads, no provider subscription (SPEC §19.1). Architect tests live in `src/__tests__/architect/`.
- **Integration tests** against a live ComfyUI are opt-in (`npm run test:integration`) and run on the reference target (GAPS Q5) with `COMFYUI_PATH` set; their hardware, model and runtime matrix is recorded with the results.
- **Upstream's suite runs unchanged** on every PR. Architect never edits an upstream test to make it pass; a needed change to one is an upstream-footprint change.

## Upstream sync

1. Branch `sync/upstream-YYYY-MM-DD` from `main`.
2. `git fetch upstream && git merge upstream/main`; resolve conflicts at the seams.
3. Rebuild the generated files (`npm run docs:gen`, `npm run vocab:export`, README counts).
4. Run upstream's suite and the Architect tests.
5. Open a PR; after the merge, add the new baseline to [input/BASE](input/BASE.md) as a new section on top.

Merge, don't rebase: `main` is public and PRs build on it.

## Upstream contributions

Contributing upstream is the owner's decision and never part of TODO mode. Branch from `upstream/main`, cherry-pick the commits meant for upstream, push to `origin` and open the PR against `artokun/comfyui-mcp`.

## TODO mode

When the owner sends "TODO mode: …", work through the remaining TODO milestones in order, one PR per milestone, with its tests, documentation and DONE entry. Stop when a milestone is complete and the next one is blocked, or on any of these:
- a blocking GAPS question, or a *(decision)* item the docs don't settle;
- a failing gate that isn't a recorded baseline failure;
- missing access or permission;
- a needed change to an upstream file outside the seams.

Record the blocker in GAPS, DONE and the PR, then ask. A milestone PR that depends on an unmerged one starts from its branch and says so.

## Decisions

Architectural decisions go into the [ARCH](ARCH.md#decision-log) decision log with their reason. Owner decisions arrive as GAPS answers and move into the documents they affect, with a `Resolved` line in GAPS.

## Versions and releases

- One semantic version for the fork, starting at 0.1.0 (GAPS Q3), in `package.json`. The upstream commit and version travel in build metadata and the startup handshake.
- A version bump is its own change in a PR. After the owner merges it, the merge commit on `main` is tagged `vX.Y.Z`; tags are never moved.
- Publishing to npm and the MCP registry stays disabled until the fork's identity and secrets exist (GAPS Q6). Upstream's `npm run release` scripts push tags; they aren't used on the fork until then.
