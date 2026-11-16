---
name: comfyui-architect
description: Plan a ComfyUI workflow from a task with ComfyUI Architect's architect_* tools. Compare candidates built from installed models and curated recipes, see what blocks each one, export a validated graph, and render it locally once the user approves, after downloading pinned model files the user approved; no node installs.
---

# Planning with ComfyUI Architect

ComfyUI Architect turns a task into a validated ComfyUI graph. It starts from a curated recipe and the models the target has installed, and doesn't write graph JSON from scratch. Its tools exist only when the server runs with `COMFYUI_ARCHITECT=1`. When `architect_plan` isn't in your tool list, use the normal comfyui-mcp tools instead.

This version plans, exports and renders a selected candidate locally once the user has approved it. When the candidate needs model files the target lacks and its recipe pins a source for each, the same approval covers downloading them first. It never installs custom nodes and never changes the canvas.

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
6. **`architect_plan`**, action `select`: record the user's choice of a `feasible` or `acquirable` candidate. Selecting authorizes nothing.
7. **`architect_plan`**, action `export`: write the selected candidate's API graph, task, plan, validation report and dependency lock to the Architect data directory, and return their paths. It also writes the UI graph (`workflow.ui.json`, loadable on the canvas) when converting it back gives the same API graph; otherwise a warning says why it is missing.

To render the selected candidate:

8. **`architect_run`**, action `prepare`, with the `planId`: validates the candidate again and returns an action plan with a short hash and an approval request. Tell the user what will run: the recipe, the models, the target and the limits. If the action plan also lists Ollama models to unload, name them: they are unloaded for the render and loaded back after it. If it starts with an `acquire_models` effect, name each file it downloads: the folder and file name, the Hugging Face repository and commit, the size, the destination folder, and the total; at least 50 GB of disk stays free.
9. **`architect_run`**, action `start`, with the `actionPlanId`. Where the client can show a dialog, the user is asked there. Otherwise the reply is `APPROVAL_REQUIRED` and names a terminal command. Give the user that command to run **themselves** in their own terminal, where it shows the plan and asks them to type its short hash. Never run it yourself and never type the hash for them: an approval you give isn't the user's. When they say they approved, call `start` again.
10. **`architect_run`**, action `status`, with the `runId`, until the run is `COMPLETED`, `AWAITING_REVIEW`, `FAILED` or `CANCELLED`. While downloads run, the run stays `PREPARING` and `acquisitions` shows each file's state (`planned`, `downloading`, `verifying`, `placed`, `failed`, `cancelled`); a file is placed only after its sha256 matched the pinned one, and an existing file is never replaced. `WAITING_FOR_RESOURCE` means the memory is in use, for example by an Ollama model the approval didn't list: tell the user what the run waits for; don't unload anything yourself. Report the three verdicts separately: execution, acceptance and the user's.
11. **`architect_run`**, action `evaluate`: asks the user for their verdict in a dialog where the client supports it. If the user told you their verdict in chat, pass it as `reportedVerdict`; it's stored as your report, and the user can record their own with `comfyui-mcp architect review <runId>`.
12. **`architect_run`**, action `finalize`: writes `run.json`, `evaluation.json` and the dependency lock next to the exported files; the lock lists each downloaded file with its repository, commit and the sha256 measured before placement.

`OUTCOME_UNKNOWN` means a submission's answer was lost: the render may be running. Never prepare and start the same plan again to retry. Keep calling `status`; it reconciles with ComfyUI, and only the user decides to cancel. `cancel` stops this run's own job and downloads and nothing else.

## What you may and may not supply

You may choose a recipe ID, fill a recipe's slots with values and pick from the model files the snapshot lists.

You may not invent node names, model file names, download URLs, memory figures or evaluation results. If a needed model isn't listed, say so: the candidate's blockers already name it. Don't pick a file with a similar name.

Downloads come only from the sources the recipes pin: a Hugging Face repository at a fixed commit, a `.safetensors` file with its sha256 and size. You never supply a URL, a repository or a file to download, and you can't add one. A missing file without a pinned source leaves the candidate blocked; tell the user, who can install the file themselves.

## Reading results

- Every check has a verdict of `pass`, `fail`, `unknown` or `not_applicable`. **`unknown` is not `pass`.** A check that's both hard and unknown blocks the candidate; tell the user what couldn't be verified and why.
- A candidate is `feasible`, `acquirable`, `diagnostic` or `blocked`. `acquirable` means the only missing pieces are model files with a pinned source the download policy accepts; its `acquisition` lists them with their sizes and the total. Its checks still fail until the files are placed. Present blocked ones with their reasons grouped as the plan reports them: missing dependencies, unsupported operation, insufficient evidence, resource limits and policy conflicts.
- A task whose `constraints.modelDownloads` is `forbidden` gets no acquirable candidates, and `budgets.maxDownloadBytes` lowers the 40 GB that one approval may download.
- Resource estimates are `unknown` in this version, because nothing has been measured yet. Don't estimate memory or time yourself.
- Never relax a requirement on the user's behalf: no smaller output, no other model, no dropped constraint without asking.

## Presenting candidates

For each candidate give the recipe, the models it binds, for an acquirable one the files it would download and their total size, its evidence tier (`certified`, `curated` or `proposed`; `proposed` means an agent wrote the recipe and no maintainer has reviewed it yet), what it would need that isn't installed, and its blockers. Recommend one, say why in terms of the recorded facts, and let the user choose.
