# ComfyUI Architect

ComfyUI Architect plans a ComfyUI workflow before an agent builds it. You describe what you want made. Architect starts from curated recipes and the models installed on your machine, builds up to three candidate graphs, validates each against your live ComfyUI, and tells you which ones run as they are and what blocks the others. It renders the one you choose once you approve it, checks the output and keeps the record. It asks before anything runs, downloads, installs code or costs money, and it records why it chose what it did.

It's a fork of [`artokun/comfyui-mcp`](https://github.com/artokun/comfyui-mcp), the MCP server and sidebar agent for ComfyUI. Everything upstream does keeps working; Architect adds a planning layer next to it, switched on with one environment variable. Upstream's README is kept as [README_BASE.md](README_BASE.md), and it describes all the inherited tools.

> **Status: early.** Planning, export, approved local renders and approved model downloads work for images. Architect doesn't install custom nodes; more recipes, repair and the acceptance suite come with the next milestones ([roadmap](#roadmap)). The package isn't published: run it from a clone.

## What it does today

With `COMFYUI_ARCHITECT=1`, the server adds three tools and two prompts to upstream's:

| Tool | Actions | What it does |
|---|---|---|
| `architect_inspect` | `environment`, `capabilities` | Reads the connected ComfyUI: versions, devices, loaded node classes, installed model files, and which probes failed. Lists the recipe catalog and how well the installed files fit each recipe. |
| `architect_plan` | `prepare`, `propose`, `get`, `validate`, `select`, `export` | Stores the task, builds and validates candidates, records your choice and writes the chosen graph with its evidence to disk. |
| `architect_run` | `prepare`, `start`, `status`, `cancel`, `evaluate`, `finalize` | Renders the chosen candidate on your ComfyUI once you approve it, follows the job, checks the output and records your verdict. When the candidate needs model files a recipe pins, the same approval covers downloading them from Hugging Face; each file is checked against its pinned sha256 before it goes into your model folder. |

A planning run looks like this:

1. **Prepare.** The agent turns your request into a task: intent, kind, operation, output size, constraints. Architect stores it, takes a snapshot of the target and returns the recipes that fit, with any missing fields to ask you about.
2. **Propose.** Architect binds each fitting recipe to installed models, compiles it to an API graph and validates it in layers: contract, structure, node types, model families, dependencies, policy. Each candidate comes back as `feasible`, `blocked` or `diagnostic`, with its blockers grouped (missing dependencies, unsupported operation, insufficient evidence, resource limits, policy conflicts).
3. **Select and export.** You pick a feasible candidate. Export writes the task, the plan, the API graph, the validation report and a dependency lock under `~/.comfyui-mcp/architect/artifacts/`. You can drag the graph into ComfyUI, or queue it with upstream's tools.

Selecting a candidate records a choice and authorizes nothing. To render it:

4. **Prepare a run.** Architect validates the candidate again and shows an action plan: what runs, on which target, within which limits, with a short hash.
5. **Approve it yourself.** Where your MCP client can show a dialog, you approve there. Otherwise the agent gives you a command to run in your own terminal:

   ```bash
   COMFYUI_ARCHITECT=1 node dist/index.js architect approve <request-id>
   ```

   It shows the plan and asks you to type its hash. `architect pending` lists what's waiting. The agent can't approve for you; an approval is bound to that plan, one run and 30 minutes, and anything that changes the plan voids it.
6. **Run and review.** Architect submits the job with its own prompt ID, follows it, and checks the output's count, format, size and readability. If a response gets lost, the run is marked `OUTCOME_UNKNOWN` and reconciled, never submitted twice. `cancel` stops only this job. You give your verdict in a dialog or with `architect review <run-id>`; execution, acceptance and your verdict are reported separately. `finalize` writes `run.json` and `evaluation.json` next to the plan's files.

### The rules it follows

- **The agent chooses; it doesn't invent.** It picks recipes and fills their slots from the files your ComfyUI lists. It never makes up node names, model files, download URLs or measurements.
- **Unknown is not pass.** Every check is `pass`, `fail`, `unknown` or `not_applicable`. A hard unknown keeps a candidate from being feasible.
- **Nothing is relaxed silently.** No lower resolution, other model or dropped constraint without your approval.
- **Verdicts stay separate.** A graph that validates, a run that finished, an output that passed its checks and an output you accepted are four different statements.
- **Approvals are yours.** A render needs your approval for that exact plan, given in a client dialog or your terminal. An agent that has a shell on your account could still run the terminal command itself, so a strict setup also restricts the agent's host ([SEC](dev/SEC.md#known-issues)).

### Recipes

Recipes live in [`architect/recipes/`](architect/recipes/). Each records its graph, typed slots, dependencies and the evidence behind it. A recipe is `proposed` when an agent wrote it, `curated` after a maintainer reviewed it, and `certified` once it passes a recorded test matrix.

| Recipe | Operation | Tier |
|---|---|---|
| Z-Image Turbo | text to image | curated |
| Z-Image Turbo | image to image | curated |
| FLUX.1-schnell, separate components | text to image | curated |
| FLUX.1-schnell, all-in-one checkpoint | text to image | proposed |
| Z-Image Turbo at half size, upscaled 2× with RealESRGAN (downloads the 67 MB upscaler) | text to image | proposed |

## Try it

You need Node.js 22 or newer and a running ComfyUI (the default target is `http://127.0.0.1:8188`) with the models of at least one recipe installed.

```bash
git clone https://github.com/gregoryyy/comfyui-architect.git
cd comfyui-architect
npm ci
npm run build
```

Register the build with Claude Code, with Architect switched on:

```bash
claude mcp add comfyui-architect \
  -e COMFYUI_ARCHITECT=1 \
  -e COMFYUI_URL=http://127.0.0.1:8188 \
  -- node "$PWD/dist/index.js" --full
```

`--full` lists every tool directly; without it, upstream's compact mode puts them behind `call_tool`. In the VS Code extension, run the same command with the `claude` binary that ships inside the extension, then reload the window. Other MCP clients take the same command and environment in their own configuration.

Then start a session and ask:

```text
/mcp__comfyui-architect__architect a 1024x1024 photo of a red bicycle against a white wall
```

or ask in your own words to plan a ComfyUI workflow. The prompt `/mcp__comfyui-architect__architect_skill` loads the planning guide the agent follows.

Settings:

| Variable | Default | Meaning |
|---|---|---|
| `COMFYUI_ARCHITECT` | off | `1` adds the Architect tools and prompts next to upstream's. `managed` also withholds upstream's tools that render, install or change things, so every effect goes through `architect_run`. Off, the server behaves as upstream. |
| `ARCHITECT_DATA_DIR` | `~/.comfyui-mcp/architect` | Where `architect.db` and the exported artifacts go. Must be an absolute path. |
| `COMFYUI_URL` | auto-detected | The ComfyUI target, as upstream reads it. |
| `ARCHITECT_PANEL_RUNS` | off | `terminal` lets the ComfyUI panel's agent start a run you approved with the terminal command. Off, runs start only from an external client. The panel's agents approve their own shell commands, so with `terminal` the panel's agent could approve for you. |
| `ARCHITECT_MANAGE_RESIDENCY` | off | `1` lets Architect unload the models a local Ollama holds in the render's memory and load them back after the render. The approval names each model and its size, so you're asked first; a model loaded after you approved isn't touched and blocks the render. Off, loaded models block the render until you unload them. |

Don't install `comfyui-mcp` from npm or let upstream's panel launcher start a server: both start upstream's package. The package, the command and the server name stay `comfyui-mcp` until a rename before the first release.

## How it relates to upstream

- **Architect off means upstream.** Without the flag, the tool list, the tool contracts, the panel surface and the behaviour are those of the pinned upstream version, and upstream's test suite runs unchanged.
- **Additive code.** Architect lives in `src/services/architect/`, `src/tools/architect.ts`, `architect/` and `src/__tests__/architect/`, and reaches upstream's services through one facade. Upstream files change only at a few recorded seams ([ARCH](dev/ARCH.md#upstream-footprint)).
- **Separate data.** Architect keeps its own `architect.db`. Upstream's database and configuration aren't touched, and model weights are referenced, never copied.
- **Pinned and merged.** The fork builds against a recorded upstream commit ([BASE](dev/input/BASE.md)) and takes upstream changes by merge.
- **The sidebar panel** is upstream's [`comfyui-mcp-panel`](https://github.com/artokun/comfyui-mcp-panel), unchanged. It connects to a fork server you started yourself when its "Autostart MCP" setting is off. Architect-specific panel controls come in a later phase.

## Roadmap

| Phase | Content | State |
|---|---|---|
| 0 | Reproducible fork, feature flag, seam audit | done, except the first CI run |
| 1 | One end-to-end planning slice: tasks, catalog, recipes, validation, export | done |
| 2 | Managed execution: action plans, approvals you give, a durable run controller, output checks, your review | done |
| 3 | Approved downloads (in review), the certified recipe set, bounded repair and the acceptance suite | in progress |
| 4 | Architect controls in the ComfyUI sidebar | planned |
| 5 | Learning from measured runs | planned |
| 6 | Video, audio, 3D and combined pipelines | planned |

Details are in [ROAD](dev/ROAD.md), the plan in [TODO](dev/TODO.md) and progress in [DONE](dev/DONE.md).

## Project documents

The project's documents are in [`dev/`](dev/), since upstream's `docs/` is its published documentation site:

- [SPEC](dev/design/SPEC.md): the design;
- [IDEA](dev/IDEA.md): purpose, users and approach;
- [ARCH](dev/ARCH.md): architecture map, decisions and the upstream footprint;
- [SEC](dev/SEC.md): threats and controls;
- [EVAL](dev/EVAL.md): claims and how they're tested;
- [GAPS](dev/GAPS.md): open questions;
- [SDLC](dev/SDLC.md): the development process.

Contributors and coding agents start with [AGENTS.md](AGENTS.md).

## License

MIT, as upstream. Copyright Arthur R. Longbottom (artokun) for upstream's code and Gregor Heinrich for the Architect additions; see [LICENSE](LICENSE).
