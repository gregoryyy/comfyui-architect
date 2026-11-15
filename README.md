# ComfyUI Architect

ComfyUI Architect plans a ComfyUI workflow before an agent builds it. You describe what you want made. Architect starts from curated recipes and the models installed on your machine, builds up to three candidate graphs, validates each against your live ComfyUI, and tells you which ones run as they are and what blocks the others. It asks before anything downloads, installs code or costs money, and it records why it chose what it did.

It's a fork of [`artokun/comfyui-mcp`](https://github.com/artokun/comfyui-mcp), the MCP server and sidebar agent for ComfyUI. Everything upstream does keeps working; Architect adds a planning layer next to it, switched on with one environment variable. Upstream's README is kept as [README_BASE.md](README_BASE.md), and it describes all the inherited tools.

> **Status: early.** Planning and export work for images. Architect doesn't run renders, download models or install nodes yet; that comes with the next phases ([roadmap](#roadmap)). The package isn't published: run it from a clone.

## What it does today

With `COMFYUI_ARCHITECT=1`, the server adds two tools and two prompts to upstream's:

| Tool | Actions | What it does |
|---|---|---|
| `architect_inspect` | `environment`, `capabilities` | Reads the connected ComfyUI: versions, devices, loaded node classes, installed model files, and which probes failed. Lists the recipe catalog and how well the installed files fit each recipe. |
| `architect_plan` | `prepare`, `propose`, `get`, `validate`, `select`, `export` | Stores the task, builds and validates candidates, records your choice and writes the chosen graph with its evidence to disk. |

A planning run looks like this:

1. **Prepare.** The agent turns your request into a task: intent, kind, operation, output size, constraints. Architect stores it, takes a snapshot of the target and returns the recipes that fit, with any missing fields to ask you about.
2. **Propose.** Architect binds each fitting recipe to installed models, compiles it to an API graph and validates it in layers: contract, structure, node types, model families, dependencies, policy. Each candidate comes back as `feasible`, `blocked` or `diagnostic`, with its blockers grouped (missing dependencies, unsupported operation, insufficient evidence, resource limits, policy conflicts).
3. **Select and export.** You pick a feasible candidate. Export writes the task, the plan, the API graph, the validation report and a dependency lock under `~/.comfyui-mcp/architect/artifacts/`. You can drag the graph into ComfyUI, or queue it with upstream's tools.

Selecting a candidate records a choice and authorizes nothing.

### The rules it follows

- **The agent chooses; it doesn't invent.** It picks recipes and fills their slots from the files your ComfyUI lists. It never makes up node names, model files, download URLs or measurements.
- **Unknown is not pass.** Every check is `pass`, `fail`, `unknown` or `not_applicable`. A hard unknown keeps a candidate from being feasible.
- **Nothing is relaxed silently.** No lower resolution, other model or dropped constraint without your approval.
- **Verdicts stay separate.** A graph that validates, a run that finished, an output that passed its checks and an output you accepted are four different statements.

### Recipes

Recipes live in [`architect/recipes/`](architect/recipes/). Each records its graph, typed slots, dependencies and the evidence behind it. A recipe is `proposed` when an agent wrote it, `curated` after a maintainer reviewed it, and `certified` once it passes a recorded test matrix.

| Recipe | Operation | Tier |
|---|---|---|
| Z-Image Turbo | text to image | curated |
| Z-Image Turbo | image to image | curated |
| FLUX.1-schnell, separate components | text to image | curated |
| FLUX.1-schnell, all-in-one checkpoint | text to image | proposed |

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
| `COMFYUI_ARCHITECT` | off | `1` adds the Architect tools and prompts. Off, the server behaves as upstream. |
| `ARCHITECT_DATA_DIR` | `~/.comfyui-mcp/architect` | Where `architect.db` and the exported artifacts go. Must be an absolute path. |
| `COMFYUI_URL` | auto-detected | The ComfyUI target, as upstream reads it. |

Don't install `comfyui-mcp` from npm or let upstream's panel launcher start a server: both start upstream's package. The package, the command and the server name stay `comfyui-mcp` until a rename before the first release.

## How it relates to upstream

- **Architect off means upstream.** Without the flag, the tool list, the tool contracts, the panel surface and the behaviour are those of the pinned upstream version, and upstream's test suite runs unchanged.
- **Additive code.** Architect lives in `src/services/architect/`, `src/tools/architect.ts`, `architect/` and `src/__tests__/architect/`, and reaches upstream's services through one facade. Upstream files change only at a few recorded seams ([ARCH](ext/ARCH.md#upstream-footprint)).
- **Separate data.** Architect keeps its own `architect.db`. Upstream's database and configuration aren't touched, and model weights are referenced, never copied.
- **Pinned and merged.** The fork builds against a recorded upstream commit ([BASE](ext/input/BASE.md)) and takes upstream changes by merge.
- **The sidebar panel** is upstream's [`comfyui-mcp-panel`](https://github.com/artokun/comfyui-mcp-panel), unchanged. It connects to a fork server you started yourself when its "Autostart MCP" setting is off. Architect-specific panel controls come in a later phase.

## Roadmap

| Phase | Content | State |
|---|---|---|
| 0 | Reproducible fork, feature flag, seam audit | done, except the first CI run |
| 1 | One end-to-end planning slice: tasks, catalog, recipes, validation, export | done |
| 2 | Managed execution: action plans, approvals you give, a durable run controller, output checks, your review | next |
| 3 | More recipes, approved downloads and installs, bounded repair | planned |
| 4 | Architect controls in the ComfyUI sidebar | planned |
| 5 | Learning from measured runs | planned |
| 6 | Video, audio, 3D and combined pipelines | planned |

Details are in [ROAD](ext/ROAD.md), the plan in [TODO](ext/TODO.md) and progress in [DONE](ext/DONE.md).

## Project documents

The project's documents are in [`ext/`](ext/), since upstream's `docs/` is its published documentation site:

- [SPEC](ext/design/SPEC.md): the design;
- [IDEA](ext/IDEA.md): purpose, users and approach;
- [ARCH](ext/ARCH.md): architecture map, decisions and the upstream footprint;
- [SEC](ext/SEC.md): threats and controls;
- [EVAL](ext/EVAL.md): claims and how they're tested;
- [GAPS](ext/GAPS.md): open questions;
- [SDLC](ext/SDLC.md): the development process.

Contributors and coding agents start with [AGENTS.md](AGENTS.md).

## License

MIT, as upstream. Copyright Arthur R. Longbottom (artokun) for upstream's code and Gregor Heinrich for the Architect additions; see [LICENSE](LICENSE).
