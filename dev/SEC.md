# Security

Assets, threats with their consequences for the design, controls by phase, and how each control is verified. The policy and approval model is [SPEC](design/SPEC.md) §14; this file adds what the fork and the local deployment bring with them, and tracks the controls as work. Every PR states its security impact against it ([SDLC](SDLC.md#definition-of-done)). Status: 2026-11-16 07:50.

## Scope

The MVP runs on one user's workstation, against a local ComfyUI, with the reasoning agent either local (Ollama) or a cloud provider on the user's own subscription (SPEC §18.3). Multi-user deployments, untrusted tenants and hosted services are out of scope (SPEC §2.2); they need their own review before they're built.

## Assets

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| The user's machine | ComfyUI, its Python environment, custom nodes, the Node.js process | Custom nodes and Python packages run code with the user's rights |
| Input and output media | ComfyUI's input and output folders, `ARCHITECT_DATA_DIR` | Private images, video and audio; may show people |
| Prompts and task specs | `architect.db`, agent sessions | May describe private or commercial work |
| Provider credentials | Upstream's credential stores, provider CLIs | Subscription sessions and API keys; spend and account access |
| Approval grants | `architect.db` | The only authority for downloads, installs, remote disclosure and paid nodes |
| Model files | ComfyUI's model folders | Large; formats like pickle can execute code when loaded |
| The repository | `gregoryyy/comfyui-architect`, public | Anything committed is public for good |

## Threats and their consequences

| # | Threat | Consequence for the design |
| --- | --- | --- |
| T1 | **The agent grants itself permission**, by claiming the user approved or by calling an effect directly | Grants come only from authenticated user interaction and bind to a plan hash; no model-callable tool creates or widens one (SPEC §14.2). Effects are admitted in the services, on every route (SPEC §14.3) |
| T2 | **Prompt injection through content**: workflow notes, model cards, node docs, retrieved pages, text in images | Such content is data: quoted into prompts, never followed, never able to change policy or start a tool (SPEC §14.4) |
| T3 | **Malicious or careless custom nodes and packages** | Installation is a separate, explicit approval; versions are pinned and environment snapshots kept. A venv is not a sandbox, and the docs say so (SPEC §14.4) |
| T4 | **Unsafe model files** (pickle checkpoints, unexpected sizes, wrong sources) | Downloads need an approved source, manifest, size bound and destination; hashes are recorded after retrieval; non-executable formats are preferred where supported |
| T5 | **Unintended data egress**: prompts, metadata or images sent to a cloud provider or catalog | Reasoning location, rendering location, external search and image disclosure are separate settings; `local-private` forbids remote reasoning and image disclosure (SPEC §12.2) |
| T6 | **Unwanted spending**: paid API nodes, a switch from subscription to API billing | Paid nodes need an explicit budget and approval; provider fallbacks never switch billing silently (SPEC §12.1) |
| T7 | **Destroying the user's work**: clearing the queue, interrupting someone else's job, replacing the canvas, deleting files | Architect never clears the whole queue, interrupts only its own jobs, opens results in a new tab, and has no delete capability (SPEC §14.5) |
| T8 | **An exposed control endpoint**: the MCP HTTP transport, the panel bridge, a tunnel | Loopback by default; upstream refuses a non-loopback bind without a token (`src/transport/http.ts`); tunnels are never enabled automatically |
| T9 | **Path traversal and symlink escape** in staged files, imports and exports | Paths are resolved against allowlisted roots, symlinks checked, URI schemes restricted (SPEC §14.4) |
| T10 | **Secrets or private data in the public repository** | No credentials, tokens or private media in commits, fixtures or logs; commits use the noreply address. Pushed commits stay reachable through the fork network even after deletion |
| T11 | **The host agent bypasses MCP** with its own shell or file tools | Outside what the fork can enforce. Stated plainly in the docs; a strict setup restricts the host agent's own permissions (SPEC §14.3) |
| T12 | **Duplicate or lost executions** after a dropped connection | Idempotency keys and `OUTCOME_UNKNOWN`; never resubmit blindly (SPEC §15.4) |

## Controls by phase

Phases are [ROAD](ROAD.md)'s.

| Phase | Controls | Threats |
| --- | --- | --- |
| 0 Fork and seams | Feature flag off by default; upstream behaviour unchanged when off; the facade as the only path into upstream; no secrets in the repository; Actions with the publishing workflows disabled | T10, T8 |
| 1 Planning slice | Read-only tools only: no downloads, installs, executions or canvas changes; untrusted-content handling in the catalog import; path checks on workflow roots | T2, T9 |
| 2 Managed execution | Grants bound to action-plan hashes, issued only by a client dialog (form elicitation) or the terminal command `comfyui-mcp architect approve`, which needs a TTY and the typed short hash; no run starts on the panel route, whose agents approve their own shell commands and whose Codex agent accepts every elicitation, unless the operator sets `ARCHITECT_PANEL_RUNS=terminal`, and even then no dialog is shown there (GAPS Q22); only loopback targets with ComfyUI 0.3.57 or newer, which interrupts by prompt id; effect admission on every route, rebuilding the plan against a fresh snapshot; managed mode (`COMFYUI_ARCHITECT=managed`) withholds upstream's effectful tools; Ollama models are unloaded for a render only when `ARCHITECT_MANAGE_RESIDENCY=1` and the approved action plan names them, and are loaded back after it (GAPS Q23); owned-job cancellation; idempotency and `OUTCOME_UNKNOWN`; privacy profiles enforced before any provider call (with the first remote provider) | T1, T5, T6, T7, T12 |
| 3 Acquisition | Model files only from sources a recipe pins (Hugging Face repository, commit, path, sha256, size), never from a URL the agent names; `.safetensors` only; at most 40 GB per approval and 50 GB left free (GAPS Q25); the download is an `acquire_models` effect in the approved action plan; every redirect hop checked against Hugging Face's hosts over `https`, refused with `HF_ENDPOINT` set elsewhere; staged under a name ComfyUI doesn't list, hash and size checked, then linked into place without overwriting; the ComfyUI-Manager route and remote targets refused; the candidate revalidated on a fresh snapshot after placement; no custom-node installs in this phase (GAPS Q26); template text is data, and an import blanks literal text; input images only from the target's input folder, hashed into the plan; model files identified from their header only; further renders only as attempts under the root's grant, each created by the controller in one store transaction that checks the bound hash, the predecessor's state, the stage, final and repair limits, the deadline from the root's start and an allowlisted one-step growth, and revalidated (inputs and a fresh snapshot) before submission; a cancel recorded on the root stops the chain; ComfyUI error text matched against fixed patterns, bounded, never followed; OCR images only to a loopback Ollama, without following redirects, and an OCR verdict counts only when the approval names its criterion's text and rules; protected regions checked against the inputs' bound sha256 | T1, T2, T4, T5, T7, T9, T12 |
| 4 Panel UX | Approval prompts that show the concrete effect; grants issued only from the panel's authenticated interaction, never from text the model produced | T1 |
| 5 Optimization | Local learning data inspectable and deletable; telemetry sharing off by default | T5 |

## Verification

| Control | Verified by |
| --- | --- |
| No unapproved effect on any route | Acceptance test AT-05 across direct tools, compact `call_tool` and panel actions ([EVAL](EVAL.md)) |
| Grants can't be forged or replayed | Negative tests (`execution.test.ts`, `run-routes.test.ts`, `execution-store.test.ts`): no tool parameter carries an approval; a wrong or missing typed hash; a grant for another action plan or target; an expired, declined or consumed grant; a changed environment between grant and start; a terminal without a TTY; a concurrent second consumption from another connection |
| Managed mode withholds upstream's effects | `config.test.ts` checks through upstream's own filter that rendering, install, queue and panel tools are withheld and the Architect tools aren't |
| Only approved Ollama models are unloaded | `execution.test.ts`: the unload list is in the approval and the hash, an edited list doesn't parse, a later residency change doesn't widen it; `resources.test.ts`: off means no unload request, a model the user didn't approve blocks instead, the approved ones are loaded back |
| Only pinned, verified files are placed | `acquisition-run.test.ts` and `acquisition.test.ts`: a hash or size mismatch leaves nothing in the model folder; a redirect to another host, to `http` or past five hops is refused; an existing destination is never overwritten; a path escape or a symbolic link in place of the staged file is refused; staging lands next to the destination even when the folder lives under an extra model root; the Manager route is refused; a restart never places a staged file without verifying it; an edited acquisition effect doesn't parse or isn't admitted |
| Input images are only the target's listed files | `input-images.test.ts`: a name with `..`, an absolute path, a backslash, a control character or a drive letter is refused; a name the loader doesn't list fails; the effect binds each input's sha256 and size, and a changed or vanished input invalidates the grant at start and before a delayed submission; reads go only to the loopback target |
| Model headers, never weights | `families.test.ts`: the header length is bounded, the path comes from upstream's resolver for a listed file, a file of another family fails, and a variant a rule can't separate stays unknown for a non-default file |
| Templates are data | `templates.test.ts`: reads only from registered sources, an instruction in a note, title or string widget doesn't change the draft, literal text is blanked for a maintainer, candidate sources never become pins, and an unknown node fails the import |
| No download without a grant on Architect's routes | `run-routes.test.ts`: an `acquire_models` plan is refused without a grant on the direct, compact `call_tool` and panel routes, and nothing is downloaded before the grant; `acquisition-run.test.ts`: the controller refuses a stored plan whose hash the consumed grant doesn't bind. With `COMFYUI_ARCHITECT=1` upstream's own `download_model` stays available; managed mode withholds it |
| Free disk on every disk a download writes | `acquisition-run.test.ts`: the reserve is checked on the model root and on upstream's download cache when it's another device, counting other runs' open downloads |
| Attempts stay inside the grant | `attempts.test.ts`: an exhausted stage, final or repair budget, a transformation outside the effect, a predecessor in OUTCOME_UNKNOWN, a passed deadline, a repeated graph, a changed action plan, a duplicate creation, `retry.unchanged` after a submission claim, a cancel with the root evaluating, completed or failed, and an input changed between attempts each create or submit nothing; a plan made before milestone 6 keeps its hash |
| Evaluator verdicts don't overreach | `protected-region.test.ts`: a changed input, an ICC profile or 16 bits are `unknown`, another size fails; `ocr-glm.test.ts`: a non-loopback host sends nothing, a redirect isn't followed, a missing, ambiguous or timed-out model is `unknown`; `visual-evaluation.test.ts`: advisory records don't count, the approval names an accepted criterion's text, match rule and tolerance |
| ComfyUI error text is data | `repair.test.ts`: classification over bounded text by fixed patterns; an instruction in the text changes no class and no step |
| Untrusted content stays data | Injection fixtures in workflow notes, model cards and node docs; the planner's output must not change |
| No egress under `local-private` | AT-09: no outbound provider or catalog request in the test run |
| No duplicate renders | AT-06: a dropped response after submission ends in `OUTCOME_UNKNOWN`, not a second submission |
| Unrelated work untouched | AT-07: cancellation and recovery tests with foreign queued jobs and an open canvas |
| Loopback by default | Upstream's transport tests, kept passing; a test that Architect adds no listener of its own |
| No secrets in the repository | Review of every PR; GitHub's push protection on the public repository |

## Known issues

- **Host agents** (Claude Code, Codex) have their own tools that the fork can't restrict (T11).
- **Approvals and a same-account agent** (milestone 3). On the panel route no run starts unless the operator sets `ARCHITECT_PANEL_RUNS=terminal`, which accepts that the panel's agent, whose shell approves its own commands, could answer the terminal command itself (GAPS Q22). An agent with a shell on the user's account can run the terminal approve command with a pseudo-terminal and type the hash, and in Claude Code an `Elicitation` hook in the user's settings can accept a dialog without showing it. The approval channels raise the bar; they are not a boundary against such an agent. The strict setup restricts the host as well (SPEC §14.3): a Bash deny rule for `comfyui-mcp architect`, `allowManagedHooksOnly` in managed settings, and the sandbox ([research/approval-channel.md](research/approval-channel.md)). Each grant records its channel and issuer.
- **Redirects are checked once** (milestone 4). Architect follows the redirect chain itself, through upstream's proxy decision, before upstream downloads, and upstream follows it again without a host check. A chain that changes between the two passes isn't caught by the host check; the sha256 check before placement still rejects any other content ([ARCH](ARCH.md#decision-log)).
- **Upstream sends the Hugging Face token** with every download from `huggingface.co` when one is configured, public repositories included; Architect's own preflight sends it only after a 401. Upstream drops it on cross-origin hops.
- **Another process of the same user** can still change files in the staging folder; placement compares the hashed and the linked inode, which narrows that to what a same-account process can do anyway (T11).
- **An input image can change after submission** (milestone 5). ComfyUI reads it when its loader runs; Architect checks it before submission and again after the run, and records a change, but can't stop it.
- **Family rules can't tell every variant apart** (milestone 5): Z-Image Turbo from Base, FLUX.2 Klein 4B distilled from base, the FLUX autoencoder from SD3's VAE. Only the recipe's default file passes on such a rule.
- **A verified file is still third-party content.** The hash proves the file is the one the recipe pinned, not that it's harmless; `.safetensors` holds no code, which narrows but doesn't close that (SPEC §14.4, T4).
- **A loopback Ollama may forward elsewhere** (milestone 6). OCR sends the output image only to a loopback host and doesn't follow redirects, but can't tell whether that port is forwarded to another machine (an `ssh -L` tunnel, say); the operator who sets one up owns that disclosure (T5).
- **Custom nodes** can do anything their Python process can; only an OS or container boundary contains them (T3).
- **Offline mode** is enforced in the application only; a real no-egress guarantee needs OS-level network controls (SPEC §12.2).
