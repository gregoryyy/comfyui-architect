# Gaps

Open questions and explicit assumptions. **Questions** are for the owner to answer. **Assumptions** are what the docs currently take for granted because they seemed clear enough not to ask; check them and correct any that are wrong. Status: 2026-11-15 18:49.

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
- **Answer** (2026-11-15 18:17, Gregor Heinrich, through Q17): the Desktop install on port 8188, with its second model root `~/Documents/model/comfyui/models` (Q12).
- *Earlier answers:* ~~(2026-11-15 13:45, Gregor Heinrich): The install under `~/Documents/opt/flux/ComfyUI`.~~
- **Resolved** (2026-11-15 18:17, Opus 5.5 for Gregor Heinrich): the reference target from milestone 2 on is the Desktop install (Q17); [research/reference-target.md](research/reference-target.md) and [ARCH](ARCH.md) say so. The source install stays a second target for the live checks of milestone 1.
- **Resolved** (2026-11-15 13:45, Opus 5.5 for Gregor Heinrich): TODO 1.1.3 and 1.2.1. Read as: the source install with its own venv. Upstream auto-selects the Desktop install, so tests set `COMFYUI_PATH`; its models sit three levels deep (`ComfyUI/ComfyUI/ComfyUI/models`, one MiniMax video LoRA, 1.8 GB), which TODO 1.2.1 checks first. Machine: Apple M5 Pro, 48 GB unified memory. The model families are chosen after that record.

### Q6. Should GitHub Actions run on the fork? — blocking for TODO 1.9

Actions is off on a new fork. Public repositories run it at no cost, but enabling it also arms upstream's `release.yml` (`npm publish` on `v*` tags) and `mcp-registry.yml`.

- **Proposed:** enable Actions, and disable the two tag workflows (`gh workflow disable`) until the fork's identity and secrets exist.
- **Answer** (2026-11-15 13:45, Gregor Heinrich): Enable Actions, and disable the tag workflows, as proposed.
- **Resolved** (2026-11-15 13:45, Opus 5.5 for Gregor Heinrich): TODO 1.9: `release.yml` and `mcp-registry.yml` are disabled when Actions is enabled, until the fork's identity and secrets exist.
- **Answer** (2026-11-15 18:49, Gregor Heinrich): enable Actions on the fork, run CI, and disable it again if it doesn't work on GitHub.

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

Q2 chose the package `@gregoryyy/comfyui-architect` and the command `comfyui-architect`. Milestone 1 found that upstream names `comfyui-mcp` well beyond `package.json`, `self-update.ts`, `server.json` and the marketplace: in about 25 source files (the panel launcher, self-restart, agent setup that writes MCP client configs, the npx restart scope, broken-install detection, report-issue, runpod), the plugin launcher (`plugin/scripts/launch-server.mjs`, 18 mentions), `scripts/smoke-install.mjs` (9) and 137 test files. Renaming only the listed files leaves launchers that start upstream's package. `boot.ts` also runs self-update at startup, which from a global or npx install would replace the fork with upstream's `comfyui-mcp`; a source checkout isn't affected. The panel's launcher runs a fixed `npx -y comfyui-mcp@latest connect` (`src/services/panel-launcher.ts`), so with the panel's "Autostart MCP" on, it starts upstream whatever the fork is called, until the fork changes that command ([research/panel-connection.md](research/panel-connection.md)).

- **Proposed:** keep `comfyui-mcp` as the package, command and MCP server name while the fork runs from a source checkout and isn't published, and identify the fork through `src/fork-identity.ts`, `serverInfo.title` and the handshake line (done in milestone 1). Do the full rename, routed through one identity module, as its own milestone before the first publish. The alternative is the full rename now: a large change across upstream files and tests, with sync conflicts to match.
- **Answer** (2026-11-15 18:49, Gregor Heinrich): keep `comfyui-mcp` as the package, as proposed.
- **Resolved** (2026-11-15 18:49, Opus 5.5 for Gregor Heinrich): package, command and MCP server name stay `comfyui-mcp` while the fork runs from a source checkout and isn't published; the fork identifies itself through `src/fork-identity.ts`, `serverInfo.title` and the handshake line. The full rename, through one identity module, is its own milestone before the first publish ([ROAD](ROAD.md)); TODO 1.3.1–1.3.3 wait for it.

### Q12. Which image model families does the MVP certify first?

SPEC §2.2 certifies 12–20 recipe variants across 2–3 families. The reference machine (Apple M5 Pro, 48 GB unified memory) has no image-only family installed; the shared models folder holds video and audio models (LTX 2.5, MiniMax H3, MiniMax Music 3, YuE2), so every image family means downloads ([research/reference-target.md](research/reference-target.md)). Upstream ships skills and packs for Flux, Qwen-Image, Z-Image, ERNIE and others.

- **Proposed:** two families with upstream skills and packs that run on 48 GB of unified memory, for example Flux and Qwen-Image, chosen by the owner with the download size in view.
- **Answer** (2026-11-15 17:27, Gregor Heinrich): the models in `~/Documents/model/comfyui/models`. That folder is the Desktop install's second model root (`comfy.desktop_1` in its model-path configuration), which the first survey missed. Its image families are **Z-Image Turbo** (diffusion model, its Qwen 3 4B text encoder and the `ae` VAE: complete) and **FLUX.1-schnell** (diffusion model fp8 and the `ae` VAE; its T5-XXL and CLIP-L text encoders aren't installed). Its Wan 2.2 models are video (ROAD phase 6).
- **Resolved** (2026-11-15 17:27, Opus 5.5 for Gregor Heinrich): the first recipes are for Z-Image Turbo and FLUX.1-schnell (TODO 2.4.4). They ship as `proposed`, the tier for recipes an agent wrote and the owner hasn't reviewed (spec §8.4: an agent can't certify its own recipe); the owner's review makes them `curated`. The FLUX.1-schnell recipe stays blocked on this machine until its text encoders are installed, which milestone 2 can't do. [research/reference-target.md](research/reference-target.md) is corrected.
- **Answer** (2026-11-15 18:49, Gregor Heinrich): the three recipes are accepted as `curated`.
- **Resolved** (2026-11-15 18:49, Opus 5.5 for Gregor Heinrich): the three recipes are `curated` at revision 3, with a `maintainer_review` entry in their evidence. The checkpoint recipe of Q13, written afterwards, is `proposed` until reviewed.
- **Correction** (2026-11-15 17:43, Opus 5.5): the FLUX.1-schnell file is Comfy-Org's all-in-one checkpoint. Its safetensors header holds the diffusion model (776 tensors), both text encoders (`text_encoders.clip_l`, 198; `text_encoders.t5xxl`, 220) and the VAE. So nothing has to be downloaded; the file sits in `diffusion_models/`, where `CheckpointLoaderSimple` doesn't look. How to run it here is Q13.

### Q13. How should FLUX.1-schnell run on this machine?

The installed `diffusion_models/flux1-schnell-fp8.safetensors` is an all-in-one checkpoint (Q12, correction). The shipped recipe loads the diffusion model with `UNETLoader` and expects separate T5-XXL and CLIP-L files, which aren't installed, so it's blocked. ComfyUI's own `flux_schnell` template loads the all-in-one file with `CheckpointLoaderSimple`, which lists only `checkpoints/`.

- **Proposed:** add a second FLUX.1-schnell recipe that uses `CheckpointLoaderSimple`, and make the file visible in `checkpoints/` (a symlink, or moving it), which is a change to the owner's model folders the owner makes. The alternative is downloading the two separate encoders (about 5 GB), which needs approval and comes with managed acquisition (ROAD phase 3).
- **Answer** (2026-11-15 18:49, Gregor Heinrich): make it visible in `checkpoints/`.
- **Resolved** (2026-11-15 18:49, Opus 5.5 for Gregor Heinrich): a symbolic link `checkpoints/flux1-schnell-fp8.safetensors` → `../diffusion_models/flux1-schnell-fp8.safetensors` in the second model root, and the recipe `recipe-flux1-schnell.ckpt-t2i`, which loads it with `CheckpointLoaderSimple` as ComfyUI's own `flux_schnell` template does. The `UNETLoader` recipe stays for an install with separate encoders.

### Q14. Should a model file of an unverified family block a candidate?

A recipe annotates the family each model slot expects, but the snapshot doesn't say which family a file is. A proposal or the enumeration of a slot without a default can bind any file of the folder; on the first live run that put a Gemma encoder into FLUX's T5 slot. The spec says an incompatible component can't be offset (§9.3), and a hard unknown blocks automatic action (§7.3).

- **Proposed:** the family check is a hard unknown whenever the bound file isn't the recipe's default, so such a candidate stays diagnostic and can't be selected; for the default, which the recipe's author named, it stays a soft unknown until files carry verified family metadata.
- **Answer** (2026-11-15 18:49, Gregor Heinrich): follow the proposal and best knowledge of ComfyUI.
- **Resolved** (2026-11-15 18:49, Opus 5.5 for Gregor Heinrich): implemented in milestone 2 ([ARCH](ARCH.md#decision-log)).

### Q15. May the agent's bindings override slots the task fills?

Slots marked `fromTask` (prompt, width, height) take the task's value. An explicit binding used to win, so a 2048×2048 task with a 512×512 proposal planned as feasible, which AGENTS forbids ("no lower resolution … without the user's approval", spec §4.3).

- **Proposed:** no. A binding that differs from the task's value fails the contract layer; a change goes through a new task revision.
- **Answer** (2026-11-15 18:49, Gregor Heinrich): follow the proposal and best knowledge of ComfyUI.
- **Resolved** (2026-11-15 18:49, Opus 5.5 for Gregor Heinrich): implemented in milestone 2 ([ARCH](ARCH.md#decision-log)).

### Q16. How does a recipe declare the task fields it honours?

A task sets the image count, format, dimensions and input assets; a recipe may not consume all of them (the shipped ones always save one PNG). Dropping one silently relaxes the task.

- **Proposed:** a task field that no slot of the recipe consumes and that differs from what the recipe produces fails the contract layer, as unsupported (spec §9.5 `unsupported_operation`); recipes declare what they produce in their slots and outputs. A field nothing decides (an undeclared format, an output size the recipe doesn't set, an input asset before execution resolves assets) is a hard unknown, so the candidate is diagnostic. Later recipes add slots for count and format.
- **Answer** (2026-11-15 18:49, Gregor Heinrich): follow the proposal and best knowledge of ComfyUI.
- **Resolved** (2026-11-15 18:49, Opus 5.5 for Gregor Heinrich): implemented in milestone 2 ([ARCH](ARCH.md#decision-log)).

### Q17. Is the Desktop install on port 8188 the reference target from milestone 2 on?

Q5 chose the source install on port 8190. The recipes of milestone 2 were checked, and its live run made, against the Desktop install (ComfyUI 0.44.0 on 8188), whose second model root holds the families of Q12.

- **Answer** (2026-11-15 18:17, Gregor Heinrich): yes.
- **Resolved** (2026-11-15 18:17, Opus 5.5 for Gregor Heinrich): Q5's answer is updated; [research/reference-target.md](research/reference-target.md) names the Desktop install.

### Q18. Is milestone 2's exit met with one feasible family?

The exit asks to compare installed-asset candidates. On the reference machine only Z-Image Turbo text to image is feasible; FLUX.1-schnell stays blocked until Q13 is answered.

- **Answer** (2026-11-15 18:17, Gregor Heinrich): yes.
- **Resolved** (2026-11-15 18:17, Opus 5.5 for Gregor Heinrich): recorded in the milestone 2 entry of [DONE](DONE.md).

### Q19. May the captured `/object_info` fixture keep the Desktop install's input-folder file names?

`src/__tests__/architect/fixtures/object-info-desktop-0.44.0.json` is the Desktop install's `/object_info`, which lists the files in its input folder (template sample names) in the `LoadImage` choices. The repository is public.

- **Answer** (2026-11-15 18:17, Gregor Heinrich): ok.
- **Resolved** (2026-11-15 18:17, Opus 5.5 for Gregor Heinrich): the fixture stays as captured.

## Assumptions

| # | Assumption | Basis | Correction |
| --- | --- | --- | --- |
| A1 | Phase 0 pins upstream `707474d2` (v0.52.206); a newer baseline comes only through a recorded sync | Spec §20 Phase 0, [BASE](input/BASE.md) | |
| A2 | The MVP target is one user on one workstation with a local ComfyUI; remote targets keep upstream's behaviour but aren't Architect-certified | Spec §18.3 | |
| A3 | Architect is off by default and enabled by configuration; off means upstream behaviour | Spec §17.2, AT-12 | |
| A4 | Nothing in the planning documents is confidential, since the repository is public | Owner decision to keep the fork public, 2026-11-15 | |
| A5 | Only one comfyui-mcp server, upstream or fork, runs per ComfyUI, because both bind the panel bridge port | Comment in `src/services/user-mcp-config.ts`; not tested | Partly (2026-11-15 15:23, Opus 5.5, from the panel's code at `54603d56`, [research/panel-connection.md](research/panel-connection.md)): a second server finds the bridge port taken and runs with the panel unavailable, and each panel tab dials one server. The panel doesn't enforce it, and a second server on the legacy port 9180 could run; the panel would take 9199 first. Not tested. Confirmed by test (2026-11-15 17:05, Opus 5.5, [research/panel-connection.md](research/panel-connection.md#observed-with-the-panel-installed)): the second server retries five times, then runs without the panel bridge; the first stays untouched |
| A6 | The panel's `COMFYUI_MCP_NO_AUTOSPAWN=1` makes it connect to a manually started server instead of launching upstream | Spec §3.2, citing the panel README; not checked in the panel's code | Wrong (2026-11-15 15:23, Opus 5.5, from the panel's code at `54603d56`, [research/panel-connection.md](research/panel-connection.md)): the panel's code doesn't read `COMFYUI_MCP_NO_AUTOSPAWN`; only its README and old changelog mention it. A companion launcher starts the server with the fixed command `npx -y comfyui-mcp@latest connect`. The switch is the panel's browser setting `comfyui-mcp.autostartMcp` ("Autostart MCP"), default on; with it off, Connect only dials a server the user started. SPEC §3.2 and §18.2 are corrected |
| A7 | Using "ComfyUI" in the product name is fine for a community project that doesn't claim affiliation, as upstream (`comfyui-mcp`) and others do | Community practice; no trademark review done | |
| A8 | Commits follow upstream's conventional-commit style, so commits meant for upstream can be cherry-picked as they are | Upstream history | |
| A9 | The panel doesn't refuse a server by its version; upstream's own version gates apply to the panel's version, and the server's version is used only for display and self-update | `src/services/ui-bridge.ts`, `panel-sync.ts`, `self-update.ts`; the panel's code (a separate repository, not installed here) is unchecked | Confirmed for the panel (2026-11-15 15:23, Opus 5.5, from the panel's code at `54603d56`, [research/panel-connection.md](research/panel-connection.md)): it accepts the first protocol frame with no version check. The server refuses a panel below its capability floors (`BRIDGE_CAPABILITY_MIN_PANEL_VERSION`), so the fork must not raise them without a matching panel |
