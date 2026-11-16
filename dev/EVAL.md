# Evaluation

How ComfyUI Architect's claims are tested: questions, baselines, fixtures, procedure, measures, success and stop criteria, limitations. The acceptance suite and the comparison with stock upstream are defined in [SPEC](design/SPEC.md) §19; this file states the claims they test, fixes what SPEC leaves open, and separates proposed targets from observed results. [TODO](TODO.md) schedules the work, [DONE](DONE.md) records results. Status: 2026-11-15 14:43.

No evaluation has run yet. Every number below is a proposed target.

## Claims under test

| # | Claim ([IDEA](IDEA.md)) | Tested by |
| --- | --- | --- |
| C1 | Planning from curated recipes produces executable workflows more often than an agent working on upstream alone | E1 (AT-04), E3 |
| C2 | Hard constraints and unknowns are never silently passed | E1 (AT-01, AT-02, AT-08) |
| C3 | No effect happens without a valid grant, on any route | E1 (AT-05), E2 |
| C4 | Execution doesn't duplicate, lose or disturb unrelated work | E1 (AT-06, AT-07) |
| C5 | Reasoning and rendering share memory safely on one machine | E1 (AT-10) |
| C6 | The fork costs upstream users nothing when Architect is off | E1 (AT-12) |
| C7 | Users need fewer manual interventions and less setup time for the same quality | E3 |

## Evaluations

### E1 Reference acceptance suite (SPEC §19.2)

- **Fixtures:** 30 reviewed task fixtures, 20 feasible across the certified recipes and 10 deliberate incompatibility, policy or missing-evidence cases. At least one Apple unified-memory profile and one dedicated-GPU profile in the resource fixtures. Fixtures describe tasks in kind-neutral contracts; the first set is image-only.
- **Procedure:** unit and contract tests with mocks in CI; integration runs opt-in on the reference target (GAPS Q5), with the hardware, model and runtime matrix recorded.
- **Measures:** AT-01 to AT-12 as SPEC defines them. AT-04 reports first-attempt success and bounded-repair success separately.
- **Success:** every AT passes; AT-04 reaches 90% of the 20 feasible fixtures *(proposed target)*.
- **Stop:** a failing AT-05, AT-06 or AT-07 blocks the phase gate regardless of the others.

### E2 Security negative tests

- **Fixtures:** forged, replayed, expired and wrong-plan grants; injection text in workflow notes, model cards, node docs and images; path traversal and symlinks in imports ([SEC](SEC.md#verification)).
- **Success:** every attempt is refused with the right stable error; no effect, no policy change.

### E3 Comparison with stock upstream (SPEC §19.3)

- **Question:** does Architect reduce avoidable setup and compatibility work without lowering task success or quality?
- **Baseline:** the pinned upstream version ([input/BASE](input/BASE.md)) with the same tasks, model assets, hardware and reasoning provider.
- **Measures:** task-completion rate, first-attempt execution success, manual interventions, setup and run time (each phase timed separately: proposal, downloads, queue, generation, evaluation), unexpected downloads, resource failures.
- **Quality:** blinded human comparison of outputs; structural validity alone never counts as quality.
- **Success:** fewer interventions and failures at equal or better task success *(proposed; numeric targets are set once the baseline has run)*.
- **Stop:** if Architect lowers task success or quality on the suite, the planning layer is revised before any further features.

### E4 Planner model qualification (SPEC §12.3)

- **Question:** which local models produce valid structured proposals reliably enough to plan?
- **Candidates:** upstream's default `artokun/gemma4-comfyui-mcp:e4b` first (GAPS Q9), then the other installed Ollama models.
- **Procedure:** upstream's LLM Arena for tool use, then Architect's own tasks for schema adherence, tool selection, planning quality and latency.
- **Measures:** schema-valid proposals per attempt (at most two repair attempts), correct tool choice, plan acceptance by the validator, latency per proposal.
- **Success:** a model qualifies when its proposals pass validation without repair on most fixture tasks *(proposed; the threshold is set with the first measurements)*. Parameter count isn't a criterion.

## Test matrix

The matrix the acceptance suite runs on (GAPS Q28; TODO 6.6). Claims about real devices hold for this machine only.

| Profile | Device | Runtime | Used for |
| --- | --- | --- | --- |
| Reference Mac (real) | Apple M5 Pro, 48 GB unified memory, one MPS device; macOS 27.2 | ComfyUI Desktop 0.44.0 (standalone, PyTorch 2.12.1, Python 3.13, frontend 1.58.5, templates 0.11.103), core nodes only; Ollama 0.40.16 with `glm-ocr:bf16`; the fork's server on Node 22 or newer | Live renders of the 20 feasible fixtures, live planning of the conflicts without an environment change, AT-04, AT-09 |
| Apple unified memory (fixture) | The reference Mac's device snapshot as recorded | Node schemas of ComfyUI Desktop 0.44.0 (`object-info-desktop-0.44.0.json`) and the recorded model lists | CI: AT-01, AT-02, AT-10 (one pool, nothing counted twice) |
| Dedicated GPU (fixture) | A CUDA device with its own VRAM next to system RAM, as data only | The same node schemas | CI: AT-10 (two pools); no claim about such a device |

No paid or cloud machine is part of the matrix (RunPod and similar stay out). The models are the shipped recipes' pinned files as placed on the reference target after milestone 5 (23.6 GB downloaded, [DONE](DONE.md)).

## Limitations

- **One reference machine** (Apple M5 Pro, 48 GB) until another is available; real-device claims are made for tested hardware only.
- **Fixtures aren't certification:** resource profiles in fixtures don't establish feasibility on a real device.
- **Subjective quality** needs human raters; vision-model judgements are advisory unless the user accepts them for a criterion (SPEC §13.2).
- **Images only** until ROAD phase 6; other kinds get their own suites built the same way.
