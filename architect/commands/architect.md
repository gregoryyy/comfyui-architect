---
description: Plan a ComfyUI workflow for a task with ComfyUI Architect, from installed models and curated recipes, and render it once the user approves; no downloads or installs
argument-hint: "What to make (e.g. 'a 1024x1024 product photo on a white background')"
---

# /architect: plan a workflow

The user wants a workflow planned for this task: $ARGUMENTS

1. If `architect_plan` isn't among your tools, Architect is off on this server (`COMFYUI_ARCHITECT` isn't set). Say so and offer the normal comfyui-mcp tools.
2. Call `architect_inspect` with action `environment` and report in one line what the target is and anything it couldn't read.
3. Turn the task into a TaskSpec: the intent in the user's words, the kind and operation, the output shape, and the constraints the user stated. Ask for what's missing; don't guess it. Call `architect_plan` with action `prepare`.
4. Call `architect_plan` with action `propose`, and present the candidates and blockers as the comfyui-architect skill describes.
5. When the user picks one, call `select`, then `export`, and give the paths of the exported files.

6. If the user wants the image made, follow the skill's render steps: `architect_run` prepare, then start. The user approves in a dialog or by running the terminal command themselves; you never approve for them.

Nothing in this command downloads, installs or changes the canvas, and nothing renders without the user's approval.
