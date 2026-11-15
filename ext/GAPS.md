# Gaps

Open questions and explicit assumptions. **Questions** are for the owner to answer. **Assumptions** are what the docs currently take for granted because they seemed clear enough not to ask; check them and correct any that are wrong. Status: 2026-11-15 15:19.

How this file works:
- Answers are recorded with date, time and author: `**Answer** (2026-11-15 13:30, Gregor Heinrich): …`. Corrections of assumptions record the same in the **Correction** column. Short answers are fine.
- **If an answer changes,** the new answer goes on top with its own date, time and author, and the earlier ones stay below it under *Earlier answers*, struck through, each with its date, time and author. Nothing is overwritten silently.
- Once answered, the decision moves into the document it affects (IDEA, AGENTS, TODO, ROAD …), and the entry gets a line `**Resolved** (date time, by whom): where the decision went`. Resolved entries stay as a record.
- Facts that would help answer a question are gathered in `research/` and linked from the entry.
- Agents add new questions and assumptions as they find them. A question that blocks a milestone is marked **blocking**.

Decisions taken before this file existed (owner, 2026-11-15): fork rather than separate package; keep the fork public; `ext/` as the docs folder; the spec v1.0 as frozen input in `ext/input/`; the name ComfyUI Architect. They're recorded in [DONE](DONE.md).

## Questions

### Q1. How do the design documents derive from the spec? — blocking for TODO 0.4

The spec covers most of what IDEA, SEC, ARCH, EVAL and ROAD would hold, and it's now frozen input ([BOOT](input/BOOT.md#the-steps)).

- **Proposed:** a working copy, `ext/design/SPEC.md`, becomes the one design authority and evolves; IDEA (written), SEC, ARCH and EVAL only add what the spec doesn't say and link to its sections. The alternative is splitting the spec into the standard documents now.
- **Answer** (2026-11-15 13:45, Gregor Heinrich): Working copy SPEC.md: `ext/design/SPEC.md` becomes the one design authority.
- **Resolved** (2026-11-15 13:45, Opus 5.5 for Gregor Heinrich): `ext/design/SPEC.md` created from the input spec v1.0, with the owner's decisions since applied (name, skill path, baseline file); AGENTS (current status), STYLE (documents), TODO 0.3.2. SEC, ARCH and EVAL add only what SPEC doesn't say (TODO 0.3.3, 0.4.2).

### Q2. What are the fork's package name and command name? — blocking for TODO 1.3

npm's `comfyui-mcp` is upstream's. The name appears in `package.json`, `PACKAGE_NAME` in `src/services/self-update.ts`, the MCP registry name in `server.json` (`io.github.<owner>/<name>`) and the plugin marketplace. The command name decides whether the fork can be installed globally next to upstream; only one of them can run per ComfyUI anyway ([README](README.md#3-compatibility)).

- **Context** (2026-11-15 13:34): the repository is renamed to `gregoryyy/comfyui-architect` (owner); the package and command names are still open.
- **Proposed:** package `@gregoryyy/comfyui-architect`, MCP name `io.github.gregoryyy/comfyui-architect`, command `comfyui-architect`, so it never shadows an upstream install. Keep the plugin name `comfy` only if the fork's plugin replaces upstream's.
- **Answer** (2026-11-15 13:45, Gregor Heinrich): `@gregoryyy/comfyui-architect`, as proposed.
- **Resolved** (2026-11-15 13:45, Opus 5.5 for Gregor Heinrich): package `@gregoryyy/comfyui-architect`, MCP name `io.github.gregoryyy/comfyui-architect`, command `comfyui-architect`, in TODO 1.3.1–1.3.3; applied when milestone 1 changes `package.json`, `self-update.ts`, `server.json` and the marketplace entry.

### Q3. Which version scheme does the fork use? — blocking for TODO 1.3

Upstream is at 0.52.206 and releases several times a day at its peak. The fork needs versions that say which upstream they contain without colliding with upstream's.

- **Proposed:** the fork's own semantic version starting at 0.1.0, with the upstream commit and version in build metadata and the startup handshake (spec §18.2), rather than suffixing upstream's version.
- **Answer** (2026-11-15 13:45, Gregor Heinrich): Own semantic version from 0.1.0, as proposed.
- **Resolved** (2026-11-15 13:45, Opus 5.5 for Gregor Heinrich): TODO 1.3.1 (version 0.1.0) and 1.3.4 (upstream commit and version in build metadata and the handshake).

### Q4. Which licence do the Architect additions carry?

Upstream is MIT. A different licence for `src/services/architect/` and `architect/` is possible but makes one repository carry two licences.

- **Proposed:** MIT for everything, with upstream's `LICENSE` kept and the fork's copyright added to it.
- **Answer** (2026-11-15 13:45, Gregor Heinrich): MIT for everything, as proposed.
- **Resolved** (2026-11-15 13:45, Opus 5.5 for Gregor Heinrich): the fork's copyright line added to upstream's `LICENSE`; TODO 0.7.2.

### Q5. Which ComfyUI install, hardware and model families are the first target? — blocking for TODO 2 (recipes)

The spec certifies 12–20 recipe variants across 2–3 model families, "selected after inspecting the developer's available models and hardware" (§2.2). Upstream detected two installs on this machine on 2026-11-15: `~/ComfyUI-Installs/ComfyUI (1)/ComfyUI` (desktop installer, selected) and `~/Documents/opt/flux/ComfyUI`, with ComfyUI on port 8188.

- **Proposed:** pick one install as the reference target, record its hardware and installed model families in a research note in TODO 1.2, then choose the families.
- **Answer** (2026-11-15 13:45, Gregor Heinrich): The install under `~/Documents/opt/flux/ComfyUI`.
- **Resolved** (2026-11-15 13:45, Opus 5.5 for Gregor Heinrich): TODO 1.1.3 and 1.2.1. Read as: the source install with its own venv. Upstream auto-selects the Desktop install, so tests set `COMFYUI_PATH`; its models sit three levels deep (`ComfyUI/ComfyUI/ComfyUI/models`, one MiniMax video LoRA, 1.8 GB), which TODO 1.2.1 checks first. Machine: Apple M5 Pro, 48 GB unified memory. The model families are chosen after that record.

### Q6. Should GitHub Actions run on the fork? — blocking for TODO 1.9

Actions is off on a new fork. Public repositories run it at no cost, but enabling it also arms upstream's `release.yml` (`npm publish` on `v*` tags) and `mcp-registry.yml`.

- **Proposed:** enable Actions, and disable the two tag workflows (`gh workflow disable`) until the fork's identity and secrets exist.
- **Answer** (2026-11-15 13:45, Gregor Heinrich): Enable Actions, and disable the tag workflows, as proposed.
- **Resolved** (2026-11-15 13:45, Opus 5.5 for Gregor Heinrich): TODO 1.9: `release.yml` and `mcp-registry.yml` are disabled when Actions is enabled, until the fork's identity and secrets exist.

### Q7. When does the companion panel fork start?

The stock panel works through its chat and choice controls (spec §3.2). Candidate cards, approvals and graph diffs need a change to `artokun/comfyui-mcp-panel`, a separate repository.

- **Proposed:** not before Phase 4; until then, test the stock panel with autospawn off. Its documents then go in that fork's own `ext/`.
- **Answer** (2026-11-15 13:45, Gregor Heinrich): In ROAD phase 4, as proposed.
- **Resolved** (2026-11-15 13:45, Opus 5.5 for Gregor Heinrich): ROAD phase 4; until then the stock panel with autospawn off (TODO 1.2.4, 1.10).

### Q8. Which hooks are offered upstream, and when?

The fork is needed for tool registration for the panel agent on every backend, per-action policy, and pausing the agent loop around a render. If upstream accepted general extension points for them, ComfyUI Architect could shrink to an add-on package.

- **Proposed:** design the seams in TODO 1 so they're upstreamable, and decide after Phase 1 whether to offer them.
- **Answer** (2026-11-15 13:45, Gregor Heinrich): Design the seams so they're upstreamable; decide later, as proposed.
- **Resolved** (2026-11-15 13:45, Opus 5.5 for Gregor Heinrich): TODO 1.6.2 and 1.7 build the seams upstreamable; the offer is decided after ROAD phase 1 (ROAD, unscheduled ideas).

### Q9. Which local planner models are candidates?

The spec selects local models by measured schema adherence, tool selection, planning quality and latency, not by size, and forbids hardcoding a best model (§12.3). Upstream defaults the panel's Ollama backend to its own fine-tuned `artokun/gemma4-comfyui-mcp:e4b`.

- **Proposed:** list the Ollama models installed here in TODO 1.2, and measure the first candidates with upstream's arena before writing Architect-specific capability tests.
- **Answer** (2026-11-15 13:45, Gregor Heinrich): Start with upstream's default, `artokun/gemma4-comfyui-mcp:e4b`.
- **Resolved** (2026-11-15 13:45, Opus 5.5 for Gregor Heinrich): TODO 1.2.2. Read as: the first local planner profile names upstream's default in configuration, not in code (spec §12.3 forbids hardcoding a best model); alternatives are measured later.

### Q10. Which kind of workflow follows images?

The product covers every kind of workflow, and the MVP certifies images only (owner, 2026-11-15; [ROAD](ROAD.md) phase 6). Upstream ships skills and installer packs for video (WAN, LTX 2.3, MiniMax H3). For audio it has a generation tool and LTX 2.3 packs that render sound with the video, but no audio packs or skills of its own. Video has the larger memory and time costs, so planning saves the most there, and a wrong estimate costs the most.

- **Proposed:** decide after ROAD phase 2, from what the machine in Q5 can run. Until then the only effect is that contracts don't assume an image (AGENTS, scope decisions).
- **Answer** (2026-11-15 13:45, Gregor Heinrich): Decide after the MVP, as proposed.
- **Resolved** (2026-11-15 13:45, Opus 5.5 for Gregor Heinrich): ROAD phase 6 keeps the order open until after phase 2; contracts stay kind-neutral (AGENTS, scope decisions).

### Q11. How far does the rename to `@gregoryyy/comfyui-architect` reach? — blocking for TODO 1.3

Q2 chose the package `@gregoryyy/comfyui-architect` and the command `comfyui-architect`. Milestone 1 found that upstream names `comfyui-mcp` well beyond `package.json`, `self-update.ts`, `server.json` and the marketplace: in about 25 source files (the panel launcher, self-restart, agent setup that writes MCP client configs, the npx restart scope, broken-install detection, report-issue, runpod), the plugin launcher (`plugin/scripts/launch-server.mjs`, 18 mentions), `scripts/smoke-install.mjs` (9) and 137 test files. Renaming only the listed files leaves launchers that start upstream's package. `boot.ts` also runs self-update at startup, which from a global or npx install would replace the fork with upstream's `comfyui-mcp`; a source checkout isn't affected.

- **Proposed:** keep `comfyui-mcp` as the package, command and MCP server name while the fork runs from a source checkout and isn't published, and identify the fork through `src/fork-identity.ts`, `serverInfo.title` and the handshake line (done in milestone 1). Do the full rename, routed through one identity module, as its own milestone before the first publish. The alternative is the full rename now: a large change across upstream files and tests, with sync conflicts to match.
- **Answer:**

### Q12. Which image model families does the MVP certify first? — blocking for TODO 2.4

SPEC §2.2 certifies 12–20 recipe variants across 2–3 families. The reference machine (Apple M5 Pro, 48 GB unified memory) has no image-only family installed; the shared models folder holds video and audio models (LTX 2.5, MiniMax H3, MiniMax Music 3, YuE2), so every image family means downloads ([research/reference-target.md](research/reference-target.md)). Upstream ships skills and packs for Flux, Qwen-Image, Z-Image, ERNIE and others.

- **Proposed:** two families with upstream skills and packs that run on 48 GB of unified memory, for example Flux and Qwen-Image, chosen by the owner with the download size in view.
- **Answer:**

## Assumptions

| # | Assumption | Basis | Correction |
| --- | --- | --- | --- |
| A1 | Phase 0 pins upstream `707474d2` (v0.52.206); a newer baseline comes only through a recorded sync | Spec §20 Phase 0, [BASE](input/BASE.md) | |
| A2 | The MVP target is one user on one workstation with a local ComfyUI; remote targets keep upstream's behaviour but aren't Architect-certified | Spec §18.3 | |
| A3 | Architect is off by default and enabled by configuration; off means upstream behaviour | Spec §17.2, AT-12 | |
| A4 | Nothing in the planning documents is confidential, since the repository is public | Owner decision to keep the fork public, 2026-11-15 | |
| A5 | Only one comfyui-mcp server, upstream or fork, runs per ComfyUI, because both bind the panel bridge port | Comment in `src/services/user-mcp-config.ts`; not tested | |
| A6 | The panel's `COMFYUI_MCP_NO_AUTOSPAWN=1` makes it connect to a manually started server instead of launching upstream | Spec §3.2, citing the panel README; not checked in the panel's code | |
| A7 | Using "ComfyUI" in the product name is fine for a community project that doesn't claim affiliation, as upstream (`comfyui-mcp`) and others do | Community practice; no trademark review done | |
| A8 | Commits follow upstream's conventional-commit style, so commits meant for upstream can be cherry-picked as they are | Upstream history | |
| A9 | The panel doesn't refuse a server by its version; upstream's own version gates apply to the panel's version, and the server's version is used only for display and self-update | `src/services/ui-bridge.ts`, `panel-sync.ts`, `self-update.ts`; the panel's code (a separate repository, not installed here) is unchecked | |
