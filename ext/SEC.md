# Security

Assets, threats with their consequences for the design, controls by phase, and how each control is verified. The policy and approval model is [SPEC](design/SPEC.md) §14; this file adds what the fork and the local deployment bring with them, and tracks the controls as work. Every PR states its security impact against it ([SDLC](SDLC.md#definition-of-done)). Status: 2026-11-15 14:43.

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
| 2 Managed execution | Grants bound to action-plan hashes; effect admission on every route; owned-job cancellation; idempotency and `OUTCOME_UNKNOWN`; privacy profiles enforced before any provider call | T1, T5, T6, T7, T12 |
| 3 Acquisition | Download manifests with source, size, destination and hash; custom-node installs as a separate approval with pinned versions and snapshots | T3, T4 |
| 4 Panel UX | Approval prompts that show the concrete effect; grants issued only from the panel's authenticated interaction, never from text the model produced | T1 |
| 5 Optimization | Local learning data inspectable and deletable; telemetry sharing off by default | T5 |

## Verification

| Control | Verified by |
| --- | --- |
| No unapproved effect on any route | Acceptance test AT-05 across direct tools, compact `call_tool` and panel actions ([EVAL](EVAL.md)) |
| Grants can't be forged or replayed | Negative tests: a model-supplied grant, a grant for another plan hash, an expired or consumed grant |
| Untrusted content stays data | Injection fixtures in workflow notes, model cards and node docs; the planner's output must not change |
| No egress under `local-private` | AT-09: no outbound provider or catalog request in the test run |
| No duplicate renders | AT-06: a dropped response after submission ends in `OUTCOME_UNKNOWN`, not a second submission |
| Unrelated work untouched | AT-07: cancellation and recovery tests with foreign queued jobs and an open canvas |
| Loopback by default | Upstream's transport tests, kept passing; a test that Architect adds no listener of its own |
| No secrets in the repository | Review of every PR; GitHub's push protection on the public repository |

## Known issues

- **Host agents** (Claude Code, Codex) have their own tools that the fork can't restrict (T11).
- **Custom nodes** can do anything their Python process can; only an OS or container boundary contains them (T3).
- **Offline mode** is enforced in the application only; a real no-egress guarantee needs OS-level network controls (SPEC §12.2).
