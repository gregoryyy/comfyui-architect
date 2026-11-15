# ComfyUI Architect: the idea

Purpose, intended users, added value and approach, including what is new and what isn't. The design input is the [spec v1.0](input/comfy-architect-system-spec.md), open questions are in [GAPS](GAPS.md), the plan is in [TODO](TODO.md). Status: 2026-11-15 13:23.

## Purpose

ComfyUI Architect turns what a user wants from ComfyUI (an image, a video, audio, a 3D asset, or a pipeline that combines them) into a workflow that runs on their machine and does what was asked. The input is the intended result, its quality requirements, the workflows and models available, and the machine's limits. The output is a tested, editable workflow together with the evidence behind it: why this graph, which dependencies it needs, what it costs in memory and time, and which requirements are proven, still pending or left to the user's judgement.

**Scope.** The idea covers every kind of ComfyUI workflow. The MVP certifies image workflows only: generation, editing, inpainting, reference-guided generation and upscaling (spec §2.2). Image renders are short, which keeps the build-and-test loop cheap, and the checks the MVP relies on (dimensions, format, protected-region comparison) exist for images. Video, audio, 3D and combined pipelines follow as their recipes, resource models and evaluators are built ([ROAD](ROAD.md) phase 6). Until then they run through upstream's normal mode, without Architect's certification.

## The problem

ComfyUI exposes the whole pipeline as nodes: model families, loaders, encoders, VAEs, samplers, conditioning branches, and hundreds of custom-node packs on top. That openness makes a new task expensive. A user who can describe the result they want still has to find out which model family fits, which files and node packs are needed, whether the components are compatible with each other, whether the graph fits into memory alongside everything else, and which settings make it work. A type-valid graph can still combine incompatible components and fail at run time, or run out of memory at the target resolution or clip length after succeeding at a smaller one. Video and multi-stage pipelines make each of these questions harder, and each failed attempt costs more render time.

An LLM agent driving ComfyUI moves that work to the agent and adds failures of its own: graphs that look plausible and don't run, guessed file names, models swapped or resolutions lowered without a word, a finished run reported as a success. The spec rules each of these out (§4.3, §9.2, §13). On a local machine, a large reasoning model and the generation model also compete for the same memory.

## Intended users

- **A ComfyUI user who can describe a task** (an image, a clip, a voice-over) but doesn't want to investigate model families, node dependencies, memory behaviour and graph wiring by hand (spec §2.1).
- **An experienced ComfyUI operator** who wants to adapt a known workflow to a new task, machine, model or quality and latency target, without losing control of the graph.
- **Agents and MCP clients** (Claude Code, Codex, the ComfyUI sidebar) that need a planning surface with feasibility, approvals and evidence instead of raw graph editing.

## Added value

- **Feasible alternatives instead of one guess:** up to three candidates, normally "use what is installed", "best quality within the limits" and "fastest feasible", each with its downloads, installs, resource estimate and remaining uncertainty.
- **Blockers instead of silent compromises:** an impossible request returns what blocks it and which relaxation would help. Nothing is lowered, dropped or switched without approval.
- **Approval that means something:** a selected candidate doesn't authorize downloads, installs, remote disclosure or paid nodes. Each effect needs its own grant, bound to the plan it was given for.
- **Honest results:** structural validity, successful execution, acceptance and the user's verdict are reported separately. Unknown stays unknown.
- **Memory-aware scheduling on one machine:** reasoning, rendering and evaluation take turns when they can't share memory.
- **Workflows that carry their evidence:** the exported package includes the task, the recipe, the dependency lock, the environment and the measured runs, so a result can be reproduced and explained later.

## Approach

- **Retrieve and adapt, don't generate from scratch.** Planning starts from curated, certified recipes and the user's own workflows, binds them to installed or approved models and applies allowlisted transformations. No second workflow language.
- **Contracts for every kind of workflow.** Task specs, recipes, resource estimates, run records and evaluations don't assume an image. What is specific to images, video, audio or 3D lives in recipe metadata, resource profiles and evaluator plugins, so a new kind of workflow adds recipes and evaluators without changing the core.
- **Models propose, the core decides.** The agent interprets the task, chooses among recorded options and explains them; deterministic checks govern compatibility, constraints and permitted actions.
- **An open-world catalog with provenance.** Compatibility is recorded with its source and applicability; missing evidence means unknown, and conflicting claims stay visible.
- **Bounded loops.** A few candidates, a few previews, at most two repair rounds, one final run, all inside an approved budget.
- **Extend, don't replace.** The fork keeps upstream's providers, MCP integration, graph tooling, model management, execution and live-canvas control, and adds the planning layer beside them.

## Innovation pursued

- **Constraint-aware candidate planning for ComfyUI:** comparing feasible workflow alternatives against a task specification, the live environment and the machine's memory, and explaining the trade-offs from recorded facts rather than from a model's opinion.
- **Approval grants bound to a plan:** effects authorized per action plan, target, budget and expiry, enforced across every tool route, so an agent can't authorize itself.
- **Shared-memory scheduling of reasoning and rendering** on a single workstation, including Apple unified memory, with leases and verified residency changes.
- **Separated verdicts:** structural, execution, acceptance and user verdicts kept apart, with evidence for each, and learning only from comparable runs.

**What isn't new.** Upstream already has most of the building blocks: workflow authoring and validation against the live node schemas, templates and installer packs, model search and download, missing-model resolution, settings suggestions from past generations, workflow locks, VRAM management, a provider-neutral agent and an arena that scores models on ComfyUI tasks. Comfy-Org ships its own agent tooling (Comfy Cloud MCP, an in-app agent, a local MCP in testing), and research systems generate ComfyUI workflows with LLM agents (ComfyBench and its ComfyAgent, ComfyGPT, ComfyUI-R1; named from memory, not yet checked, and to be cited in a SOTA note). Template retrieval, constraint filtering, provenance and human approval are each established. The claim is the combination on a local machine: feasibility, approvals and evidence as first-class records around a curated recipe set. It is unproven until the acceptance suite and the comparison with stock upstream show it (spec §19).

## Positioning in one line

ComfyUI Architect plans a workflow before an agent builds it: it picks what fits the task, the installed models and the machine, asks before anything costs money or installs code, and records why.
