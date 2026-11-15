---
name: comfyui-architect
description: Plan a ComfyUI workflow from a task with ComfyUI Architect's architect_* tools. Compare candidates built from installed models and curated recipes, see what blocks each one, and export a validated graph, with no downloads or renders.
---

# Planning with ComfyUI Architect

ComfyUI Architect turns a task into a validated ComfyUI graph. It starts from a curated recipe and the models the target has installed, and doesn't write graph JSON from scratch. Its tools exist only when the server runs with `COMFYUI_ARCHITECT=1`. When `architect_plan` isn't in your tool list, use the normal comfyui-mcp tools instead.

This version plans and exports. It never downloads, installs, renders or changes the canvas. Execution comes in a later version.

## When to use it

- The user describes what they want made (an image now; video, audio and 3D later) and wants a workflow that fits this machine.
- The user wants to compare options ("which of my models can do this, and what would each need?").
- The user wants to know why something can't be done here.

For a quick one-off generation with a graph the user already has, the normal tools are faster.

## The order of calls

1. **`architect_inspect`**, action `environment`: what the target is, which node classes and model files it has, and which probes failed. Use action `capabilities` to list the catalog's recipes and what each needs.
2. **`architect_plan`**, action `prepare`, with the task: the intent in the user's words, the kind and operation, the output shape, and any constraints the user stated. It returns the stored task, the environment it was checked against, the recipes that fit, and any missing fields. Ask the user for missing fields; don't guess them.
3. **`architect_plan`**, action `propose`: builds up to three candidates from the fitting recipes and the installed models, validates each, and returns them with their blockers. You may pass bindings for a recipe's slots; model files have to be ones `architect_inspect` listed.
4. **`architect_plan`**, action `get`: read a plan and its candidates again, with the compiled graph on request.
5. **`architect_plan`**, action `validate`: check a candidate again against a fresh snapshot, for example after the user installed something.
6. **`architect_plan`**, action `select`: record the user's choice. Selecting authorizes nothing.
7. **`architect_plan`**, action `export`: write the selected candidate's graph, task, plan, validation report and dependency lock to the Architect data directory, and return their paths.

## What you may and may not supply

You may choose a recipe ID, fill a recipe's slots with values and pick from the model files the snapshot lists.

You may not invent node names, model file names, download URLs, memory figures or evaluation results. If a needed model isn't listed, say so: the candidate's blockers already name it. Don't pick a file with a similar name.

## Reading results

- Every check has a verdict of `pass`, `fail`, `unknown` or `not_applicable`. **`unknown` is not `pass`.** A check that's both hard and unknown blocks the candidate; tell the user what couldn't be verified and why.
- A candidate is `feasible`, `blocked` or `diagnostic`. Present blocked ones with their reasons grouped as the plan reports them: missing dependencies, unsupported operation, insufficient evidence, resource limits and policy conflicts.
- Resource estimates are `unknown` in this version, because nothing has been measured yet. Don't estimate memory or time yourself.
- Never relax a requirement on the user's behalf: no smaller output, no other model, no dropped constraint without asking.

## Presenting candidates

For each candidate give the recipe, the models it binds, its evidence tier (`certified`, `curated` or `proposed`; `proposed` means an agent wrote the recipe and no maintainer has reviewed it yet), what it would need that isn't installed, and its blockers. Recommend one, say why in terms of the recorded facts, and let the user choose.
