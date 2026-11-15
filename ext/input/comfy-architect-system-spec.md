# Comfy Architect
## System specification for an `artokun/comfyui-mcp` fork

**Version:** 1.0  
**Date:** 15 November 2026  
**Status:** Proposed implementation specification; not an implemented or runtime-tested system.  
**Primary upstream:** `artokun/comfyui-mcp`  
**Inspected baseline:** package version `0.52.206`, commit `707474d24d0d251ba04a1bebdf86620cef2eaa8b`. The retrieved commit is dated 4 November 2026. [S1][S2]

## 1. Product definition

Comfy Architect turns a user's intended result, quality requirements, available workflows and models, and hardware constraints into an executable, editable, tested ComfyUI workflow.

It is an extension of the fork's existing control plane, not a replacement for it. The fork retains upstream MCP connectivity, provider backends, workflow tooling, model management, execution, and live-canvas integration. New code adds a structured planning and evaluation layer.

The core interaction is:

> Describe the result → inspect the environment → propose feasible alternatives → approve changes → build and test → inspect results → refine or export.

The output is not merely workflow JSON. It is a **workflow package** containing the interpreted task, selected graph, dependencies, provenance, resource assumptions, validation results, measured runs, and remaining uncertainties.

### 1.1 Design decisions

| Decision | Specification |
|---|---|
| Product architecture | Extend the existing TypeScript/Node.js application as a modular monolith. |
| Primary integration | Existing MCP server and agent backends; external Claude Code/Codex clients and the existing ComfyUI sidebar. |
| New intelligence | Task specification, capability catalog, template-based candidate planning, constraint checks, resource scheduling, evaluation, and evidence-based ranking. |
| Graph construction | Prefer validated templates and typed graph edits; reuse upstream composition/conversion tooling. Do not introduce a second low-level workflow language. |
| Knowledge storage | SQLite plus versioned JSON/YAML records. No mandatory graph database, vector service, or ontology reasoner. |
| Execution control | Deterministic job state machine and policy checks; an LLM proposes actions but cannot grant permissions. |
| First supported domain | Image generation, image editing, inpainting, reference-guided generation, and upscaling through a bounded certified recipe set. |
| Packaging | A real fork with its own package identity, pinned upstream baseline, and compatibility tests. |

`MUST`, `SHOULD`, and `MAY` express required, recommended, and optional behavior. Performance targets in this specification are proposed acceptance targets, not observed results.

## 2. Scope and users

### 2.1 Target users and jobs

The primary user has ComfyUI installed and can describe an image task but does not want to investigate model families, node dependencies, memory behavior, and graph wiring manually.

A second user is an experienced ComfyUI operator who wants to adapt a known workflow to a new task, machine, model, or quality/latency target without losing control of the graph.

The system MUST support these requests:

- Build a workflow from a natural-language task and target parameters.
- Adapt an existing workflow while preserving specified nodes, assets, or behavior.
- Find the best suitable workflow among local and configured external libraries.
- Explain why a candidate is feasible, blocked, or still unverified on the target machine.
- Test alternatives under an explicit budget and retain the evidence for future decisions.

### 2.2 Initial release boundaries

The Architect release supports a curated set of recipes, not arbitrary combinations of every ComfyUI node. Initial certification SHOULD cover 12–20 recipe variants across 2–3 model families selected after inspecting the developer's available models and hardware.

Upstream video/audio/other functionality remains available in normal mode, but is not advertised as Architect-certified until dedicated recipes, resource models, and evaluators exist.

Out of scope for the initial release: model training, autonomous custom-node code generation, unrestricted website crawling, multi-user SaaS, GPU-cluster scheduling, automatic paid cloud provisioning, universal visual-quality scoring, and formal proof of arbitrary Python node behavior.

## 3. Verified upstream baseline and reuse plan

Selected source files and the published tool descriptions were inspected. The upstream build and GPU behavior were not executed for this specification. Phase 0 must establish the runnable baseline before feature work.

The package already supplies the TypeScript/ESM application, MCP SDK, Zod, SQLite binding, YAML support, image utilities, and Vitest tooling. Retain these rather than creating a second backend stack. [S2]

### 3.1 Integration inventory

| Existing surface | How the fork uses it | New work |
|---|---|---|
| `src/tools/index.ts` and its tool catalog/filtering | Register Architect tools through the existing direct and compact paths. | Add one tool group without changing existing tool order or bypassing filters. |
| `src/orchestrator/agent-backend.ts` | Reuse provider identity, events, capabilities, interruption and session handling. | Architect-specific prompts, capability checks, and policy-aware routing. |
| `create_workflow` actions `create`, `modify`, `validate`, `node_info` | Compose, patch and inspect actual node definitions. | Semantic compatibility and task-constraint checks. |
| `visualize_workflow` actions `to_dsl`, `from_dsl` | Optional compact graph representation. | Round-trip regression tests; no mandatory new DSL. |
| Workflow conversion, querying and library services | Import and normalize saved graphs; retain original exports. | Searchable recipe metadata, graph fingerprints and import-status records. |
| `save_workflow` lock/verification functionality | Reuse the existing provenance-lock path. | Link its results to task, plan, run and evaluation records. |
| Local-model, download and pack tools | Inspect assets; discover and acquire approved dependencies. | Typed catalog entries, installation plans and policy gates. |
| System stats, queue, history and execution tools | Observe the target and submit/monitor workflows. | Resource reservations, durable run state and bounded retries. |
| Existing generation tracker | Preserve upstream tracking and settings suggestions. | Separate per-run evaluation evidence, rather than treating reuse counts as quality. |
| Plugin skills and packs | Seed task recipes and model-family knowledge. | Versioned machine-readable metadata with source provenance. |

Sources for the registration, provider, authoring, conversion and library seams are the inspected files [S3]–[S7]. The broader execution, model, lock, pack and tracking surfaces are documented upstream. [S8]

### 3.2 The sidebar is a separate repository

`artokun/comfyui-mcp-panel` contains the ComfyUI frontend extension. Forking `comfyui-mcp` alone does not include that frontend. The panel can connect to a manually started orchestrator, and its documented default launcher invokes the upstream package. [S9]

Therefore:

1. The first usable version MUST work through MCP and the unchanged panel's existing chat/choice controls.
2. The fork MUST identify itself and its build at connection time. A connection to stock upstream must not appear to be an Architect-enabled connection.
3. Development installation MUST start the fork explicitly and disable the panel's upstream autospawn using its documented `COMFYUI_MCP_NO_AUTOSPAWN=1` mode.
4. Rich candidate cards and an Architect drawer MAY be added through a small companion panel fork or upstream contribution. They are not a prerequisite for the core planner.
5. The core and panel MUST negotiate capabilities; an old panel can fall back to text and existing choice controls.

Do not copy the panel into the core repository or introduce a standalone React application for the MVP. Preserve the existing frontend stack in any companion change.

## 4. User experience

### 4.1 First-run setup

Setup detects the connected ComfyUI target, the actual loaded node classes, configured model paths, workflow directories, reasoning backends, and available resource telemetry.

The user chooses a reasoning profile, permitted network destinations, download policy, custom-node installation policy, and an execution budget. Directory access is explicitly scoped. Secrets remain in existing provider credential stores or secret references, never in task documents.

The setup result is a timestamped environment snapshot, not a claim that every discovered file is executable or compatible.

### 4.2 Happy path

**Request.** The user describes the task and supplies input images or a workflow. The system turns this into an editable TaskSpec. It asks only for missing information that changes feasibility, permissions, or the acceptance test; other choices become visible defaults.

**Proposal.** Present up to three non-dominated candidates, normally “use installed assets,” “best quality within limits,” and “fastest feasible.” Each shows required downloads, installation changes, resource estimate and confidence, likely trade-offs, and unverified requirements.

**Approval.** Selecting a candidate does not implicitly authorize installation or remote data transfer. Show the concrete action plan and request the necessary approvals together.

**Build and test.** Compile the selected recipe, validate it, acquire approved dependencies, refresh the environment, and run a budgeted smoke test. Do not replace the user's current canvas without permission.

**Review.** Show output, checks, measured latency, resource observations, and unresolved quality requirements. Offer a bounded refinement or the final render.

**Delivery.** Open the workflow in a new tab when possible and export the workflow package. Report “execution passed,” “acceptance passed,” and “user accepted” separately.

### 4.3 Candidate presentation contract

| Field | Required behavior |
|---|---|
| Why selected | Explain the link between the request, recipe and model capabilities. |
| Feasibility | `supported`, `requires_probe`, or `blocked`; never convert unknown into supported. |
| Dependencies | Exact assets already present, missing files, node packs and restart requirements. |
| Quality | Task-specific evidence or qualitative expectation, clearly distinguished. |
| Resources | Estimated range and measurement basis; separate host RAM, device memory and unified memory. |
| Cost/privacy | Reasoning provider, image/data destinations, downloads and paid render nodes. |
| Changes | Semantic graph diff and protected elements retained. |

An impossible request returns specific blockers and proposed relaxations. The system MUST NOT silently reduce resolution, omit a preservation requirement, switch provider, or install another model.

## 5. Architecture and execution ownership

### 5.1 Logical components

| Layer | Responsibility | Implementation location |
|---|---|---|
| Clients | Conversation, selection, approvals, canvas and output display | Existing MCP clients and panel |
| Agent session | Interpret intent, request evidence, propose recipes/patches, explain results | Existing upstream provider backends |
| Architect tools | Small, typed interface to planning and run services | New `src/tools/architect.ts` |
| Architect domain | Task/plan state, retrieval, constraints, compilation, ranking, evaluation | New `src/services/architect/` |
| Upstream facade | Stable internal wrapper over inherited services | New `src/services/architect/upstream.ts` |
| Existing infrastructure | ComfyUI communication, downloads, model/node management, graph tooling | Existing upstream modules |
| Persistence | Catalog, plans, approvals, operations, runs and evidence | New `architect.db` and artifact directories |

All new core modules run inside the existing Node.js application. Do not make an HTTP/MCP round trip to the same process merely to call inherited functionality. Invoke the underlying service through the facade; refactor logic out of tool handlers only where necessary, preserving behavior with tests.

### 5.2 One agent loop, not nested agents

The current external agent or panel backend is the reasoning owner. It calls Architect tools, receives compact context, and submits structured proposals. The core validates and executes accepted proposals deterministically.

`architect_plan` MUST NOT secretly launch a second Claude/Codex/Ollama agent when an agent is already using it. This avoids duplicate reasoning cost, recursive tools, inconsistent approvals and local-memory contention.

A future unattended runner can drive the same state machine through an explicit backend session. It is not a separate planning implementation.

### 5.3 Main processing sequence

1. Capture TaskSpec and environment snapshot.
2. Retrieve recipe candidates and compatibility evidence.
3. Ask the active agent for a bounded candidate proposal when semantic interpretation is needed.
4. Resolve models, node implementations and parameters.
5. Evaluate constraints and rank feasible candidates.
6. Freeze a selected plan revision and collect required approvals.
7. Install/stage approved dependencies, refresh inventory and revalidate.
8. Reserve resources, compile, validate and submit a smoke run.
9. Collect artifacts, measurements and acceptance evidence.
10. Run an approved repair/refinement or proceed to final execution.
11. Export and retain the result.

Planning is side-effect-free apart from its own local records and permitted catalog reads. Installation, graph mutation and execution are separate operations.

## 6. Functional requirements

| ID | Requirement | Release |
|---|---|---|
| FR-01 | Convert natural language and attachments into a schema-valid TaskSpec with explicit assumptions. | MVP |
| FR-02 | Discover the live environment and distinguish installed, available, incompatible and unknown resources. | MVP |
| FR-03 | Retrieve recipes from local workflows, upstream packs and configured template sources. | MVP |
| FR-04 | Produce up to three distinct, explainable candidates; retain rejection reasons. | MVP |
| FR-05 | Enforce hard operational constraints before side effects; track output requirements separately. | MVP |
| FR-06 | Resolve exact model files, family-compatible components and node versions. | MVP |
| FR-07 | Generate both an executable graph and a usable UI export for certified recipes. | MVP |
| FR-08 | Require scoped approval for downloads, code installation, restarts, remote disclosure and paid execution. | MVP |
| FR-09 | Execute, monitor, cancel and reconcile owned jobs without disrupting unrelated work. | MVP |
| FR-10 | Run deterministic output checks and collect user acceptance; support optional vision evaluation. | MVP |
| FR-11 | Preserve task→recipe→graph→dependency→run→evaluation lineage. | MVP |
| FR-12 | Support Ollama, Claude Code and Codex through inherited integrations; configurable direct APIs. | MVP |
| FR-13 | Prevent concurrent local reasoning/rendering when the shared memory budget is insufficient. | MVP |
| FR-14 | Adapt an existing graph using protected nodes/regions and an explicit diff. | MVP |
| FR-15 | Learn resource estimates and ranking preferences from comparable observed runs. | v1.1 |
| FR-16 | Extract reusable subgraph motifs from arbitrary imported workflows. | Later |
| FR-17 | Add video/audio recipe families and modality-specific evaluators. | Later |

## 7. Domain contracts

Zod schemas are the runtime authority; infer TypeScript types from them. Every stored contract carries a `schemaVersion`, identifiers, timestamps and migration support. Unknown properties at mutation boundaries must be rejected or explicitly handled, not silently ignored.

### 7.1 Core records

| Record | Required content |
|---|---|
| `TaskSpec` | Intent; operation; inputs; outputs; operational constraints; acceptance requirements; preferences; budgets; policy reference. |
| `EnvironmentSnapshot` | Target identity; runtime versions; node-schema digest; installed assets; paths; telemetry; queue state; freshness and probe errors. |
| `Recipe` | Task/capabilities; original graph; typed slots; dependencies; supported variants; semantic contracts; parameter rules; evidence. |
| `ModelArtifact` | Logical model/family; exact source revision/file/hash when known; format; quantization; dependencies; license metadata; local location. |
| `PlanCandidate` | Task revision; recipe revision; bindings; transforms; parameter selection; graph fingerprint; constraint results; resource estimates; ranking explanation. |
| `ActionPlan` | Ordered effects; targets; fingerprints; requested grants; download/compute budgets; rollback/recovery limitations. |
| `ApprovalGrant` | Human/client issuer; action scope; plan revision/hash; target; limits; expiry; consumption state. |
| `RunRecord` | Candidate and execution hashes; prompt ID; state; seed; actual versions; outputs; timings; measurements; error/recovery history. |
| `EvaluationRecord` | Criterion; evaluator/version; input/output hashes; result; uncertainty; raw measurement; user verdict where applicable. |
| `EvidenceAssertion` | Subject/predicate/object or structured value; source; revision; observation date; applicability; confidence category; contradictions. |

### 7.2 Example TaskSpec

This is an illustrative contract, not a bundled model recommendation or measured hardware profile.

```yaml
schemaVersion: 1
id: task-product-background
revision: 1
createdAt: "2026-11-15T12:00:00+01:00"
updatedAt: "2026-11-15T12:00:00+01:00"
intent: Replace the background while preserving the product and its label.
operation: image_edit
inputs:
  - assetId: input-product
    role: source_image
  - assetId: input-protected-mask
    role: protected_region
output:
  width: 1024
  height: 1024
  count: 1
  format: png
constraints:
  renderLocation: local
  remoteReasoning: forbidden
  remoteImageDisclosure: forbidden
  newCustomNodes: approval_required
  modelDownloads: approval_required
  paidRenderNodes: forbidden
acceptance:
  - id: output-shape
    kind: dimensions
    required: true
    expected: [1024, 1024]
  - id: protected-pixels
    kind: protected_region_exact
    required: true
    sourceAssetId: input-product
    maskAssetId: input-protected-mask
    coordinateSpace: source_pixels
  - id: realism
    kind: user_review
    required: true
    rubric: Background is photorealistic and the product placement looks plausible.
preferences:
  quality: 0.5
  latency: 0.2
  dependency_reuse: 0.3
budgets:
  maxPreviewRuns: 3
  maxFinalRuns: 1
  maxRepairRounds: 2
  maxDownloadBytes: 12000000000
  maxWallTimeSeconds: 1800
  maxApiSpendUsd: 0
policyProfile: local-private
```

Exact pixel preservation requires a recipe that retains or deterministically recomposites the protected region in a defined coordinate/color space. A generative edit with a preservation prompt does not satisfy this requirement by itself. Conflicting resize, color-transform or geometry instructions must be resolved explicitly.

### 7.3 Constraint and result semantics

Operational constraints apply before or during execution: allowed destination, permitted node pack, file availability, output shape, spending and resource budgets.

Acceptance requirements apply to outputs: text preservation, similarity, protected pixels, style, realism or user approval. They cannot all be guaranteed during planning.

Each check returns `pass`, `fail`, `unknown`, or `not_applicable`, plus evidence and the enforcing component. A hard unknown blocks automatic action unless policy explicitly permits a bounded diagnostic probe. A hard output requirement with no reliable evaluator remains pending, not passed.

Quality labels and confidence scores are not probabilities unless calibrated against an identified dataset.

## 8. Capability catalog and knowledge model

### 8.1 Representation

Use normalized SQLite tables and typed JSON payloads. The catalog is logically a graph, but SQL joins and small in-memory traversals are sufficient initially.

Core entity types are `TaskType`, `Capability`, `Recipe`, `ModelFamily`, `ModelArtifact`, `NodeClass`, `NodePack`, `RuntimeProfile`, `HardwareProfile`, and `EvaluationCriterion`.

Core relationships are `solves`, `implements`, `requires`, `provides`, `compatible_with`, `incompatible_with`, `consumes`, `produces`, `tested_on`, and `derived_from`.

A relationship MUST include provenance and applicability. For example, a ControlNet/model-family relationship can depend on architecture, loader, precision and node-pack revision; it must not be flattened into an unconditional “compatible” flag.

Use an open-world interpretation: missing evidence means unknown. Conflicting claims remain visible. Do not resolve a conflict by overwriting an empirical failure with a newer model-card claim.

### 8.2 Evidence precedence

For installation facts, prefer a fresh observation from the selected target. For executable compatibility, prefer a successful or failed run under matching versions and settings. Use curated maintainer rules next, then published model/node documentation. LLM-extracted assertions remain provisional until reviewed or tested.

This precedence is contextual, not a universal numerical hierarchy. A successful 512-pixel run does not establish memory feasibility at 2048 pixels; a model-card license statement does not establish rights for every bundled dependency.

### 8.3 Ingestion sources

| Source | Ingestion behavior |
|---|---|
| Live ComfyUI | Snapshot node classes, input/output schemas, model selectors, runtime and hardware metadata. |
| Local model roots | Resolve the target's configured paths, inspect metadata, and cache hashes incrementally. Do not rehash all multi-gigabyte files on each request. |
| Local workflow roots | Read allowlisted JSON and embedded workflow metadata; preserve original files and import errors. |
| Upstream packs/skills | Index supplied recipes and documentation, attaching the fork baseline and content hashes. |
| Configured template libraries | Import through versioned adapters with source identifiers, revisions, attribution and license metadata. |
| Hugging Face | Search metadata and inspect exact repository files; download only a selected, approved manifest. |
| Run history | Record execution outcomes and comparable evaluation evidence, including failures. |

Hugging Face supports revision-specific file retrieval and download planning. The fork SHOULD reuse its inherited download path and add revision/file manifests, rather than downloading whole repositories indiscriminately. [S10]

### 8.4 Import normalization

Import proceeds through format detection, structural parsing, dependency extraction, semantic annotation, validation and indexing. Parsing a workflow MUST NOT execute its nodes or install its dependencies.

Retain three representations where available: the original UI graph, the normalized executable graph, and recipe metadata. Record a conversion report with unsupported constructs and losses. Unknown subgraphs, virtual nodes, dynamic ports or custom widget serializers must not be silently dropped.

For the MVP, maintain recipe annotations manually for the certified set. LLM-assisted annotation can propose changes, but it cannot self-certify a recipe.

### 8.5 Retrieval

Start with task/capability filters, installed-dependency overlap, SQLite FTS5 search, and semantic metadata. Optional local embeddings can rerank a bounded shortlist later; a vector database is not required.

Retrieval priority is: matching verified local recipe, verified bundled recipe, configured library recipe, then external discovery. “Prefer local” is a ranking preference unless the task forbids downloads.

A configured source registry MUST record adapter type, root/URL, allowed operations, trust status, refresh policy, and last successful refresh. An unreachable source is unavailable, not empty.

## 9. Planning and candidate selection

### 9.1 Inputs and outputs

The planner consumes TaskSpec, an environment snapshot, recipe candidates, compatibility assertions and the active policy. It returns candidates or an unsatisfied-constraints report.

Each candidate includes exact recipe/model bindings, explicit graph transformations, selected parameter values, dependency delta, estimated resource envelope, acceptance strategy and supporting evidence.

### 9.2 Bounded search algorithm

1. Filter recipes by required task capabilities and input/output contracts.
2. Enumerate compatible installed model bindings and a bounded set of permitted downloadable alternatives.
3. Apply curated transformations such as a supported precision variant, tiled decode, reference-conditioning branch, or upscale stage.
4. Reject candidates with proven hard-constraint violations. Retain unknowns only as diagnostic candidates when policy permits.
5. Estimate resource requirements and identify required installations or probes.
6. Remove dominated candidates and select up to three distinct trade-offs.
7. Ask the active agent to explain the selection from the recorded facts, not to invent missing scores.

Initial configurable limits: retrieve at most 20 recipes, expand at most 24 concrete candidates, and present at most 3. No unbounded graph search or multi-agent debate is required.

The agent may choose recipe IDs, fill typed slots, and propose allowlisted transformations. It MUST NOT invent installed node names, model filenames, download URLs, memory measurements or evaluation results.

### 9.3 Ranking

For candidates with comparable evidence, use a transparent utility function:

\[
U(w)=\sum_k a_k q_k(w)-b_t\,t(w)-b_d\,d(w)-b_r\,r(w)
\]

Here `q_k` are task-specific quality estimates, `t` is normalized runtime, `d` is dependency/download burden, and `r` is a risk penalty. Weights and normalizations are stored with the ranking result.

The MVP need not predict numerical quality. It MAY use ordered evidence tiers and qualitative trade-offs until enough comparable runs exist. Missing measurements remain missing; do not assign a fabricated quality score to make the formula computable.

Apply hard constraints before ranking. A high expected quality score cannot offset forbidden data transfer, unsupported hardware, or an incompatible model component.

### 9.4 Adaptation of an existing graph

The user can mark nodes, subgraphs, files, parameters and outputs as protected. Planning returns an edit proposal against a specific graph revision.

The proposal MUST identify changed nodes/connections/parameters and explain their purpose. Replacing the entire graph is a distinct action. Before applying a patch, check that the live graph still matches its base revision; otherwise request a rebase or user selection.

### 9.5 No feasible candidate

Return blockers grouped into missing dependencies, unsupported operation, insufficient evidence, resource limits and policy conflicts. Proposed relaxations must say exactly which requirement changes and why. Never apply a relaxation automatically.

## 10. Graph compilation and validation

### 10.1 Representation boundaries

The planning representation is a `PlanCandidate`, not a second graph language. It selects a recipe, binds components and lists typed edits. The executable representation remains upstream ComfyUI workflow types.

The inherited compact DSL is optional and experimental in the inspected source. Use it for context reduction or inspection only after round-trip tests; its parser is not a semantic guarantee. [S6]

### 10.2 Compilation pipeline

Resolve the recipe revision and model bindings, instantiate its graph, apply typed edits, resolve actual node schemas, validate, and emit immutable artifacts. Seed handling must be explicit; no hidden randomization during comparison runs.

The compiler MUST produce a mapping from requirements and recipe roles to node IDs. Preserve semantic role IDs across regeneration even when physical node IDs change.

### 10.3 Validation layers

| Layer | Checks |
|---|---|
| Contract | Required TaskSpec fields, budgets, policy and supported recipe transformations. |
| Structure | Known node classes, required inputs, valid connections/output indices, reachable output nodes and unsupported cycles/constructs. |
| Native types | Port compatibility using the connected installation's schemas; conservative handling of wildcard and dynamic types. |
| Semantic types | Model family, encoder/VAE pairing, conditioning format, latent layout, precision, loader and hardware support. |
| Dependencies | Exact files, node-pack revisions, restart needs and unresolved assets. |
| Policy | Data destinations, code trust, filesystem scope, paid nodes and approval requirements. |
| Runtime | Actual submission validation and bounded execution evidence. |

ComfyUI's documented `POST /prompt` validates and queues a workflow. It is not a general side-effect-free validation endpoint. Use inherited validation for preflight, and label submission as execution authorization. [S11]

### 10.4 API and UI graphs

The API graph is the execution authority. A UI graph also contains layout, widgets and frontend constructs. They are not universally interchangeable.

For certified recipes, require that loading the emitted UI graph and exporting its executable form preserves the intended execution graph, modulo documented nonsemantic fields. Prefer the original UI template and supported frontend serialization where possible.

For unsupported imports, preserve the original graph and report conversion limitations. Do not claim lossless UI round-tripping merely because API JSON passes validation.

### 10.5 Reproducibility

Each executable candidate receives a canonical graph hash and a lock reference for model hashes, node-pack revisions and runtime versions. Record the actual environment again at execution time.

The system promises reproducible configuration and traceability, not bit-identical pixels across different hardware, kernels or dependency versions.

## 11. Resource planning and scheduling

### 11.1 Resource topology

Resources belong to a target and a physical memory pool. Distinguish dedicated GPU memory, host RAM and unified memory. Do not add an Apple unified-memory “VRAM” figure to host RAM as though they were independent capacities.

Treat local reasoning, rendering and vision evaluation as separate resource consumers. Supporting an Ollama model of up to 40B parameters does not mean it can remain resident beside the chosen image model.

Record hardware backend, device identity, runtime versions, current residency, free memory, process ownership, queue state and telemetry freshness. Remote Ollama and remote ComfyUI endpoints must not be assumed to share resources.

### 11.2 Memory estimates

A useful stage-based estimate is:

\[
M_{peak}(w)=\max_s\left(M_{weights,s}+M_{activations,s}+M_{workspace,s}+M_{runtime,s}\right)
\]

This is an accounting model, not a universal closed-form predictor. Estimate from matching measurements first, then validated recipe profiles, then conservative component estimates. Include resolution, batch size, precision, attention implementation, conditioning branches and offload behavior.

Store an interval, its basis and uncertainty. Current memory readings and model file sizes alone do not prove feasibility. When comparing estimated additional allocation to free memory, avoid counting already-resident weights twice.

### 11.3 Shared-memory scheduling

The default schedule on a constrained local machine is:

1. Complete planning and persist the selected plan.
2. Pause further reasoning turns that would contend for the same resource pool.
3. Release only agent-owned model residency that the user has authorized the system to manage.
4. Confirm release or mark it unverified; refresh resource telemetry.
5. Acquire a resource lease and execute the render.
6. Release/unload render models when appropriate.
7. Resume reasoning or load a permitted evaluator.

Ollama provides model residency controls, including unloading and `keep_alive`; use them through an adapter and verify the observed result. [S12] Do not unload a shared model while another client is actively using it, and do not kill unrelated processes.

A deterministic controller monitors the render while the local reasoning model is unloaded. It must not require an LLM to remain resident to receive progress or complete the job.

### 11.4 Reservations and uncertainty

Use transactional leases keyed by physical resource pool, with owner, heartbeat, expiry and recovery. Resource leases coordinate Architect instances; they cannot prevent unrelated applications from consuming memory.

Recheck memory and queue state immediately before execution. When ownership, availability or a critical hardware capability is unknown, either block or offer an explicitly bounded probe.

A low-resolution smoke render is not proof of target-resolution memory feasibility. A final-resolution probe or comparable evidence is required to strengthen that claim. Memory predictions remain estimates; the controller must handle allocation failure safely rather than promise that out-of-memory errors are impossible.

### 11.5 Failure responses

On allocation failure, record the exact configuration, release owned resources and propose a supported alternative. Tiled decode or offloading can be applied only when the recipe permits it. Lowering resolution, changing model family or dropping conditioning changes the plan and may require renewed acceptance/approval.

Maintain separate setup, download, queue-wait, reasoning, generation and evaluation timings. Do not report cached execution as fresh inference performance.

## 12. Reasoning providers

### 12.1 Provider policy

Reuse the upstream `AgentBackend` abstraction and provider implementations. Its existing capability flags cover important differences such as vision, session behavior and interruption; Architect adds task-specific readiness checks rather than assuming provider parity. [S4]

| Route | Required behavior |
|---|---|
| Local Ollama | Use installed/configured models; support models up to 40B parameters where the actual memory profile permits. Probe tool use, structured proposals and vision separately. |
| Claude Code subscription | Use the user's existing supported Claude Code integration and session; no shared subscription proxy. |
| Codex subscription | Use the inherited Codex integration and user-authenticated app-server/CLI path. |
| OpenAI API | Explicit opt-in with API credentials, spend limits and permitted data classes. |
| Anthropic API | Explicit opt-in with API credentials, spend limits and permitted data classes. |

Subscription operation is a required deployment mode for this user-controlled fork. It is not treated as unlimited capacity or a general API entitlement. Preserve rate-limit and authentication errors; never silently switch to paid API usage.

Codex documents app-server as an integration interface and distinguishes subscription authentication from API-key billing. Keep these as separate configured modes and use supported authentication paths. [S13][S14] A later hosted or commercial service requires a separate deployment/authentication review; this specification does not turn a local user's session into a shared service credential.

### 12.2 Privacy dimensions

Configure reasoning location, rendering location, external search and image disclosure independently. “Local rendering” does not imply “nothing leaves the machine” when a cloud reasoning model sees prompts, file metadata or images.

`local-private` forbids remote reasoning and image disclosure. `local-render-cloud-reasoning` permits approved text metadata but does not automatically permit input/output images. `cloud-enabled` still requires explicit destination and cost permissions.

Offline mode must disable external catalog refreshes, downloads and cloud providers. Strong no-egress guarantees require runtime/OS network controls, particularly for third-party custom nodes; application-level configuration alone is not sufficient.

### 12.3 Structured proposals and model capability testing

Pass only the relevant recipe/schema subset, using IDs and references instead of whole catalogs. Apply token/context limits. Validate every proposal, allow at most two schema-repair attempts, and return a clear failure rather than continuing with malformed data.

Select local models by measured schema adherence, tool selection, planning quality and latency on the project's test tasks. Parameter count alone is not a qualification test. Do not hardcode a supposedly best model name into the architecture.

Provider fallbacks require an explicit ordered allowlist. A switch that changes privacy, billing, authentication or input modalities requires approval. A failed vision-capability check leaves visual criteria unverified or routes them to the user.

## 13. Execution, evaluation and bounded improvement

### 13.1 Validation stages

| Stage | Purpose | What it does not establish |
|---|---|---|
| Static preflight | Find structural, dependency, semantic and policy problems. | Successful execution or image quality. |
| Cheap smoke render | Establish that the chosen path executes under the tested settings. | Target-resolution feasibility or final quality. |
| Representative render | Test target-relevant settings and acceptance criteria. | General success across all prompts, seeds or machines. |
| Final execution | Produce the requested deliverable under the accepted plan. | User satisfaction until reviewed. |

Record preview-specific changes in a separate graph revision. Never label a low-step or low-resolution preview as the final graph's benchmark.

### 13.2 Evaluators

The MVP MUST include artifact existence/readability, dimensions/count/format, run completion and user-review criteria. It SHOULD include deterministic protected-region comparison when a recipe makes that guarantee.

Optional evaluators include OCR-based text checks, region similarity, perceptual similarity, reference consistency and rubric-based vision-model assessment. They are plugins with versioned contracts, not universal measures of quality.

```typescript
// Proposed domain contract; concrete schemas are generated with Zod.
interface EvaluationResult {
  criterionId: string;
  evaluatorId: string;
  evaluatorVersion: string;
  verdict: "pass" | "fail" | "unknown" | "not_applicable";
  measurement?: { value: number; unit: string };
  evidenceAssetIds: string[];
  explanation: string;
}
```

Thresholds, masks, crops, color-space assumptions and reference images are part of the criterion. OCR uncertainty cannot prove that text was preserved; semantic similarity cannot prove pixel identity. Vision-model opinions remain advisory unless the user explicitly accepts that evaluator for the criterion.

### 13.3 Comparison protocol

Compare candidates on the same task, source assets, output settings and evaluation rubric. Use repeated seeds where the budget permits. A shared numeric seed across different model architectures does not constitute identical randomness.

Record cold/warm residency, caching, hardware/runtime versions and load time. Keep benchmark inputs separate from prompt/recipe tuning inputs where feasible. Show sample counts and dispersion; do not rank two models confidently on one favorable image.

### 13.4 Repair policy

Classify errors into schema/wiring, missing dependency, unsupported backend/precision, memory, transport, policy, and quality failures.

A repair is a new plan revision with a visible diff. Automatic repair is limited to the already-approved action scope and certified transformations. No automatic custom-code editing, dependency upgrades, model-family substitution, privacy relaxation or paid fallback.

Default limits are two repair rounds, three preview executions and one final execution. A repaired preview consumes both the relevant preview budget and a repair round. All executions also count toward the total deadline and spending limits. The execution deadline starts when the approved operation starts and includes preparation, downloads, queueing, retries and evaluation; planning before approval is excluded. Extending the deadline or allowing another final execution requires an amended grant.

Stop on exhausted budget, repeated identical failure, unresolved approval, no meaningful improvement, or an acceptance pass followed by user selection. Return the best available candidate with its actual status; never fabricate success to complete the loop.

### 13.5 Learning from runs

The initial learning mechanism is retrieval and aggregation of comparable evidence, not model fine-tuning. Store successful and failed configurations, user choices and explicit preference reasons.

Resource prediction can later use nearest-neighbor profiles or a small regression model over model family, precision, dimensions, batch size, node features and hardware. Fit only when there is enough coverage and report extrapolation.

Do not treat popular settings as proven quality, or aggregate incompatible evaluation rubrics into a global score. Users can inspect and delete their local learning data. Sharing telemetry is off by default.

## 14. Policy, approvals and trust boundaries

### 14.1 Approval classes

| Action | Default policy |
|---|---|
| Inspect approved local resources; build a plan | Allowed. |
| Search configured external metadata | Allowed only when the network profile permits it. |
| Download model artifacts | Require approved source, manifest, destination and maximum size. |
| Install/update custom nodes or packages | Separate explicit approval; executable code changes. |
| Restart/stop ComfyUI | Explicit approval after checking unrelated work and unsaved graphs. |
| Load/replace the active canvas | Explicit user selection; preserve an undo/snapshot boundary. |
| Run a local workflow | Covered by an approved candidate and bounded run budget. |
| Send prompt/metadata/images to a remote provider | Explicit data-class and destination permission. |
| Execute paid API nodes | Explicit budget and provider approval. |
| Delete models/workflows or alter unrelated files | Disabled in Architect mode. |

### 14.2 Grants are not model assertions

An approval grant binds a specific action-plan hash, target, asset revisions, allowed destinations, resource/spend limits and expiry. The system derives it from authenticated user interaction in the panel, a trusted terminal command, or supported client approval/elicitation—not from an LLM's claim that the user approved.

There is no model-callable `approve_everything` tool. Model tool calls may reference an existing grant but cannot create or broaden it. For MCP clients without a trusted approval channel, provide a local terminal approval command that displays the stored action plan and requires confirmation against its hash. Do not put that command in the agent's allowed shell surface.

Any material change invalidates the affected grant: different files, code revision, privacy destination, paid service or increased budget. Refresh and revalidate immediately before an effect to prevent stale-plan execution.

### 14.3 Enforcement points

Enforce policy inside Architect services and the effectful upstream facade, not only in skill text. Apply the same checks to direct tools, compact `call_tool`, panel actions and any native provider-tool route enabled in Architect mode.

The existing registration boundary already handles direct/compact tool filtering. Extend its mechanism rather than introducing an alternate unfiltered registry. [S3]

Architect mode SHOULD expose only the planning tools and approved inspection tools to the agent. Disable general shell execution, arbitrary filesystem writes, install tools and direct render submission where the host supports this restriction.

An external Claude Code/Codex process may possess additional host tools outside this MCP server. The fork cannot police actions performed through those unrelated tools. State the boundary explicitly; a strict managed deployment requires the host agent's permissions/sandbox and ComfyUI access to be constrained as well.

### 14.4 Untrusted content and executable dependencies

Workflow descriptions, model cards, retrieved pages, node documentation and instructions visible in images are untrusted data. Instructions embedded in them cannot change policy, issue approvals or initiate tools.

Downloaded artifacts must have approved sources, safe destinations, expected size bounds and content hashes recorded after retrieval. Prefer non-executable weight formats where supported, but do not describe format choice as complete protection against malicious content.

Custom-node installation executes third-party code and may change Python dependencies. Stage proposed changes, record environment snapshots, pin versions and require explicit review. A Python virtual environment isolates dependencies; it is not a security sandbox. Strong isolation requires appropriate OS/container controls.

Network requests require allowed destinations and redirect validation. Reject traversal, symlink escapes, unsupported URI schemes and arbitrary local-network discovery. An authenticated remote ComfyUI target is configured explicitly, not inferred from model-generated URLs.

### 14.5 Operational safety

Never clear the entire queue to cancel one Architect job. Verify ownership before interrupting a currently running prompt. Global interrupt/restart requires a dedicated target or confirmation that no unrelated job is affected.

Bind local control endpoints to loopback by default; authenticate any nonlocal endpoint and enforce origin checks. Do not enable tunnels automatically. Preserve existing secret-redaction and safe-process-execution practices.

## 15. Persistence and state management

### 15.1 Storage layout

Resolve a platform-appropriate application data directory as `ARCHITECT_DATA_DIR`. The following layout is proposed:

```text
ARCHITECT_DATA_DIR/
  architect.db
  artifacts/
    <task-id>/<plan-revision>/
      task.json
      plan.json
      workflow.api.json
      workflow.ui.json
      dependencies.lock.json
      validation.json
      runs/<run-id>/run.json
      runs/<run-id>/evaluation.json
  catalog-cache/
  backups/
```

Do not copy model weights into this tree. Store references to their configured locations. Large media stays in ComfyUI's configured output store unless explicitly exported.

Use the existing SQLite dependency, a separate `architect.db`, WAL mode, migrations and transactional updates. Preserve the upstream generation database rather than modifying its schema for Architect-specific requirements. Link records through prompt IDs, artifact hashes and any stable upstream IDs.

### 15.2 Tables

Initial tables: `tasks`, `task_revisions`, `environments`, `catalog_sources`, `catalog_entities`, `catalog_assertions`, `recipes`, `plans`, `plan_candidates`, `action_plans`, `approval_requests`, `approval_grants`, `operations`, `runs`, `run_events`, `evaluations`, `resource_leases`, and `schema_migrations`.

Use indexed relational columns for identities, status, target and timestamps; JSON payloads for versioned structured details. Avoid implementing a generic enterprise knowledge-graph platform as part of this project.

### 15.3 State machine

Planning states are `DRAFT`, `NEEDS_INPUT`, `PLANNING`, `PROPOSED`, `BLOCKED`, `SELECTED`, and `SUPERSEDED`.

Execution states are `AWAITING_APPROVAL`, `PREPARING`, `WAITING_FOR_RESOURCE`, `VALIDATING`, `QUEUED`, `RUNNING`, `EVALUATING`, `AWAITING_REVIEW`, `COMPLETED`, `FAILED`, `CANCELLED`, and `OUTCOME_UNKNOWN`.

Each transition has a guard, timestamp, initiating principal and reason. `COMPLETED` means the operation finished; its separate acceptance field states `passed`, `failed`, `pending`, or `waived_by_user`. An explicit waiver is not a machine verification pass.

Persist transition events before announcing progress. Resume from persisted state after process restart; the browser connection is not the job's source of truth.

### 15.4 Idempotency and uncertain submission

Mutating requests carry an idempotency key scoped to target, task and plan revision. The controller records the submission attempt before making the network call.

When the target supports a client-supplied prompt identifier, use it after capability detection. Otherwise use an operation correlation identifier and reconcile against queue/history. A lost HTTP response after submission is not evidence that submission failed.

If the controller cannot determine whether a run was accepted, enter `OUTCOME_UNKNOWN` and reconcile or ask the user. Do not blindly submit another render. The same principle applies to interrupted installations and downloads.

### 15.5 Retention and portability

Provide export/delete operations for tasks, run evidence and preferences. Redact secrets and machine-specific paths in shareable exports. Keep private asset references in a local manifest; copying source images requires explicit selection.

A portable package includes the graph, task/plan, recipe identifier/revision, dependency lock, environment requirements and evaluation report. It does not include licensed weights or credentials.

## 16. MCP and internal API contracts

### 16.1 Proposed tool surface

Use a small action-oriented tool family consistent with upstream conventions. Exact action presence requirements are validated in handlers. This is a proposed surface, not a claim that these tools exist upstream.

| Tool | Actions | Effects |
|---|---|---|
| `architect_inspect` | `environment`, `capabilities`, `dependencies` | Read-only observation; refresh only within allowed sources. |
| `architect_plan` | `prepare`, `propose`, `get`, `compare`, `revise`, `validate`, `select` | Persists planning records; no installation, rendering or canvas mutation. |
| `architect_run` | `prepare`, `start`, `status`, `cancel`, `evaluate`, `finalize` | Creates approval requests and performs only granted effects. |
| `architect_library` | `search`, `import`, `export`, `feedback` | Index/export local records; external acquisition remains separately gated. |

`architect_plan prepare` returns normalized task assumptions, environment ID, candidate recipe summaries and any missing fields. `propose` accepts typed bindings/transformations and returns validated candidates. `select` freezes a candidate revision but does not authorize its effects.

`architect_run prepare` returns an action plan and outstanding approval requests. `start` references that plan and existing grants. Long operations return an `operationId` immediately; progress uses existing event channels with status polling as a fallback.

`evaluate` may accept a signed/user-sourced verdict or request a configured evaluator. An LLM-submitted opinion is stored as that agent's opinion, not disguised as an independent automated measurement.

### 16.2 Result envelope

```json
{
  "schemaVersion": 1,
  "operationId": "op-example",
  "status": "awaiting_approval",
  "taskId": "task-example",
  "planRevision": 2,
  "summary": "One model download is required before the smoke render.",
  "data": {
    "actionPlanId": "actions-example",
    "approvalRequestIds": ["approval-example"]
  },
  "warnings": [],
  "artifacts": []
}
```

Return concise summaries plus identifiers. Large schemas, graphs and logs are retrieved on demand with limits. Do not push an entire model catalog through the agent context.

### 16.3 Internal service boundary

```typescript
// Illustrative interface; concrete return types live in domain schemas.
interface ArchitectService {
  inspect(request: InspectRequest): Promise<EnvironmentSnapshot>;
  prepare(request: PrepareRequest): Promise<PlanningContext>;
  propose(request: ProposalRequest): Promise<PlanningResult>;
  validate(planId: string): Promise<ValidationReport>;
  prepareRun(request: PrepareRunRequest): Promise<ActionPlan>;
  startRun(request: ApprovedRunRequest): Promise<OperationReceipt>;
  getOperation(operationId: string): Promise<OperationStatus>;
  cancel(request: CancelRequest): Promise<OperationStatus>;
  exportPackage(request: ExportRequest): Promise<ArtifactReference>;
}
```

Inject the upstream facade, catalog, store, clock, hash service, policy engine and resource coordinator. Unit tests must not require a running GPU or provider subscription.

### 16.4 Errors and events

Stable errors include `MISSING_INPUT`, `NO_FEASIBLE_CANDIDATE`, `UNVERIFIED_COMPATIBILITY`, `STALE_ENVIRONMENT`, `APPROVAL_REQUIRED`, `APPROVAL_INVALIDATED`, `DEPENDENCY_UNAVAILABLE`, `RESOURCE_BUSY`, `RESOURCE_ESTIMATE_UNKNOWN`, `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `BUDGET_EXCEEDED`, `GRAPH_CONFLICT`, and `OUTCOME_UNKNOWN`.

Each error specifies retryability, affected constraint/action and a safe next step. Preserve source error details in redacted diagnostics without conflating authentication errors, missing files and unreachable services.

Events include `task.updated`, `plan.proposed`, `approval.required`, `dependency.progress`, `run.state_changed`, `run.progress`, `evaluation.completed`, and `artifact.available`. Use stable IDs and monotonic sequence numbers to deduplicate reconnect deliveries.

## 17. Repository changes and dependency strategy

### 17.1 Proposed additions to the core fork

```text
src/
  services/
    architect/
      schemas.ts             # Zod domain contracts and inferred types
      service.ts             # Public application-service boundary
      upstream.ts            # Adapter to inherited service functions
      inventory.ts           # Environment snapshots and freshness
      catalog.ts             # Entities, assertions, recipes and retrieval
      planner.ts             # Candidate construction and ranking
      constraints.ts         # Operational and acceptance checks
      compiler.ts            # Recipe binding and typed graph edits
      policy.ts              # Grants, effect admission and data routing
      resources.ts           # Memory profiles, leases and residency
      controller.ts          # Durable operation/run state machine
      evaluation.ts          # Evaluator registry and evidence handling
      store.ts               # SQLite persistence and migrations
      export.ts              # Portable workflow package generation
  tools/
    architect.ts             # Thin MCP registration and response mapping
  __tests__/
    architect/               # Unit, contract and integration fixtures
architect/
  recipes/                   # Curated metadata referencing tested graphs
  rules/                     # Versioned compatibility/parameter rules
  fixtures/                  # Small task and environment fixtures
plugin/
  skills/comfy-architect/SKILL.md
  commands/architect.md
```

These are proposed paths, not existing upstream files. Split large modules by responsibility when needed, but do not start with a service per entity or per agent role.

### 17.2 Existing files expected to change

| Existing area | Expected change |
|---|---|
| `src/tools/index.ts` | Append the Architect tool group using the existing registration and filtering path. |
| `src/config.ts` / startup wiring | Add feature/configuration handling and fork identity; avoid spreading configuration reads through domain code. |
| `src/orchestrator/` | Add Architect-mode instructions, permission restrictions, resource-yield coordination and progress events. |
| Existing workflow/library tools or services | Extract reusable functions only where the new facade otherwise needs to parse tool output. Preserve existing public behavior. |
| `package.json` and package files list | Add fork identity and Architect assets; retain locked dependencies and existing scripts. |
| Tool vocabulary/surface tests and generated docs | Include new tools through the project's documented generation/check paths. |
| Plugin manifest/skills | Expose the Architect workflow without replacing normal upstream skills. |

Keep normal mode and Architect mode separate. Feature-disabled builds must preserve existing tool contracts and behaviors. Security fixes to shared code can apply globally, but intentional breaking changes need their own migration.

### 17.3 Libraries

Use the existing MCP SDK, Zod, SQLite, YAML, HTTP/WebSocket and test dependencies. [S2] Use Node's filesystem, crypto and process APIs through injectable adapters.

Do not add LangChain/LangGraph, a new web framework, a Python planner, Neo4j, a standalone vector database, or a general constraint solver for the initial release. Introduce a solver only after bounded candidate enumeration demonstrably fails to express required choices.

Optional heavyweight evaluators may run in a separate, explicitly installed environment later. They must not turn the base install into an ML-runtime distribution.

### 17.4 Fork maintenance

Record the exact upstream commit in `UPSTREAM_BASELINE.md` and build metadata. Maintain a clean upstream tracking branch and merge updates through a tested integration branch. Do not develop against an unpinned `latest` package.

Retain upstream license notices and attribution. Review licenses separately for added code, node packs, templates and model artifacts; the upstream package's license does not settle those other licenses.

Prefer small upstreamable infrastructure changes and concentrated Architect modules. Regenerate tool documentation from schemas where upstream expects it. Run the inherited test suite unchanged as part of every release candidate.

## 18. Configuration, packaging and deployment

### 18.1 Proposed configuration

This example defines the desired configuration semantics. It is not an existing upstream configuration file and must be implemented behind the fork's startup/configuration layer.

```yaml
architect:
  enabled: true
  mode: managed
  dataDir: auto
  target: default
  policyProfile: local-private
  providers:
    primary: local-planner
    fallbacks: []
    profiles:
      local-planner:
        backend: ollama
        model: ${LOCAL_PLANNER_MODEL}
        maxParameters: 40000000000
        allowedDataClasses: [task_text, local_metadata, images]
      codex-subscription:
        backend: codex
        authMode: subscription
        allowedDataClasses: [task_text, approved_metadata]
      claude-subscription:
        backend: claude
        authMode: subscription
        allowedDataClasses: [task_text, approved_metadata]
  catalog:
    localWorkflowRoots: []
    remoteSources: []
    networkRefresh: false
  planning:
    maxRetrievedRecipes: 20
    maxExpandedCandidates: 24
    maxPresentedCandidates: 3
    maxSchemaRepairAttempts: 2
  execution:
    maxConcurrentRunsPerResourcePool: 1
    maxPreviewRuns: 3
    maxFinalRuns: 1
    maxRepairRounds: 2
    maxWallTimeSeconds: 1800
    maxApiSpendUsd: 0
  resources:
    localReasoningRenderConcurrency: exclusive
    memorySafetyMarginFraction: 0.15
    manageSharedModelResidency: false
```

Environment-variable expansion is restricted to documented configuration fields. Missing required variables cause a clear startup error. The 15% memory margin is an initial tunable policy default, not a validated universal safety threshold.

Defining a cloud profile does not enable it under `local-private`; effective permissions are the intersection of profile capabilities, policy, task constraints and user grants. API profiles additionally reference secrets and spending limits without storing credentials in this file.

### 18.2 Install and startup behavior

Use a distinct scoped package identity and preserve the upstream CLI behavior where practical. The exact published name is an implementation choice; installation instructions must point to the fork, not to upstream `@latest`.

For development: clone the fork, use its lockfile, build, and start its compiled CLI with the inherited connection configuration. Configure external MCP clients to launch that build. For the panel, disable upstream autospawn and connect to the manually started fork.

Startup MUST expose package identity, fork version, upstream commit, Architect schema version, active policy and available features. Never expose secrets in this handshake.

Package the recipe/rule assets explicitly and test an installed tarball, not only a source checkout. Core operation must not depend on the current working directory being the repository root.

### 18.3 Deployment support

MVP support is a user-controlled workstation with a local ComfyUI target. Retain inherited remote connectivity, but mark remote installation, telemetry and resource-control capabilities individually as supported or unavailable.

A remote target's filesystem paths are not local paths. Use the target adapter for staging and downloads, or return a clear unsupported operation. Do not assume the machine hosting the MCP server can inspect remote RAM, process ownership or model directories.

For a managed server, use explicit authentication, restricted filesystem roots, pinned dependencies and dedicated execution ownership. Multi-user isolation and arbitrary untrusted tenants are outside the initial release.

## 19. Test strategy and release acceptance

### 19.1 Test layers

| Layer | Required coverage |
|---|---|
| Unit | Schemas, constraints, scoring, compatibility rules, hash stability, resource accounting and state transitions. |
| Property/regression | Graph edit invariants, idempotency, protected-node preservation, unknown propagation and canonicalization. |
| Upstream contract | Tool names/actions, inherited service adapters, direct/compact registration and feature-disabled behavior. |
| Integration | Installed ComfyUI schemas, model discovery, compile/submit/history, stale-environment recovery and export/import. |
| Provider | Ollama, Claude Code and Codex readiness, proposal parsing, interruption, rate limiting and denied fallback. API paths tested with mocks plus optional authenticated smoke tests. |
| UI | New-tab loading, graph conflicts, undo behavior, approval presentation, reconnect and stock-panel fallback. |
| Security | Prompt injection, forged grants, replay, stale approval, path escape, unwanted egress, tool-route bypass and dependency changes. |
| GPU/manual | Resource residency scheduling, representative renders, OOM recovery and human quality review. |

Unit/contract CI must use fixtures and mocks with no model downloads, provider subscriptions or GPU requirement. Real integration suites are opt-in, explicitly budgeted, and publish the hardware/model/runtime matrix actually tested.

### 19.2 Reference acceptance suite

Create 30 reviewed task fixtures: 20 feasible tasks spanning the certified recipes and 10 deliberate incompatibility, policy or missing-evidence cases. Cover text-to-image, image editing, protected-region editing, reference conditioning and upscale/adaptation tasks.

Include at least one Apple unified-memory profile and one dedicated-GPU profile in resource-accounting fixtures. Real-device claims are made only for hardware actually tested; fixture coverage is not device certification.

| ID | Acceptance criterion | Related requirements |
|---|---|---|
| AT-01 | Every tool input and stored record is schema-validated; malformed proposals never reach execution. | FR-01, FR-05 |
| AT-02 | All deliberate hard-conflict fixtures are blocked with a correct reason; unknown is never silently treated as pass. | FR-02, FR-05 |
| AT-03 | Every certified recipe compiles and passes its graph-contract tests with its pinned dependency fixture. | FR-03, FR-06, FR-07 |
| AT-04 | At least 90% of the 20 feasible task fixtures produce an executable candidate within the bounded repair budget on the declared test matrix. | FR-04, FR-09 |
| AT-05 | No blocked or unapproved effect succeeds through direct tools, compact routing, panel actions or enabled native-tool paths. | FR-08 |
| AT-06 | Failed/lost submissions do not automatically produce duplicate renders; unresolved outcomes remain explicit. | FR-09 |
| AT-07 | No cancellation or recovery test clears unrelated queued jobs or silently overwrites an unrelated canvas. | FR-09, FR-14 |
| AT-08 | Every completed run has task/plan/graph/dependency/environment linkage and distinguishable execution/acceptance/user status. | FR-10, FR-11 |
| AT-09 | Local-private tests produce no outbound provider/catalog request; deployment-level no-egress is tested separately where enforced. | FR-08, FR-12 |
| AT-10 | Shared-memory scheduling serializes reasoning/rendering when required and never counts unified memory twice. | FR-13 |
| AT-11 | Exported UI workflows for the certified set preserve execution semantics when re-exported and run. | FR-07, FR-11 |
| AT-12 | Feature-disabled behavior passes the inherited regression suite; old clients retain their existing tool contracts. | All |

The proposed 90% target is a release criterion, not an observed result. Report first-attempt success and bounded-repair success separately.

### 19.3 Value validation against unmodified upstream

Use the same tasks, model assets, hardware and reasoning provider for the fork and stock upstream. Compare task-completion rate, first-attempt execution success, manual interventions, total setup/runtime, unexpected downloads, and resource failures.

Use blinded human comparison for subjective output quality. Do not claim quality improvement from better structural validity alone. The fork should reduce avoidable setup/compatibility work without materially lowering task success or image quality.

Measure time to first useful proposal separately from time to render. Set latency targets after the runnable baseline exists; provider inference and model downloads must not be hidden inside a misleading single number.

## 20. Implementation phases

### Phase 0 — Reproducible fork and seam audit

Pin the inspected upstream baseline or document a deliberate newer baseline. Build and run inherited checks. Record actual versions, tool surfaces and panel connection behavior. Create the fork identity, feature flag, facade skeleton and smoke fixture.

**Exit:** the fork launches from an installed package, identifies itself correctly, works with an external MCP client and the stock panel, and preserves upstream behavior with Architect disabled. Record any baseline failures rather than attributing them to the new layer.

### Phase 1 — One end-to-end planning slice

Implement TaskSpec, environment capture, the local catalog and three curated recipes. Add `architect_inspect` and planning actions. Build one task into a validated export without downloads or automatic execution.

**Exit:** a user can describe an image task, compare installed-asset candidates and obtain an editable graph with explicit constraints and provenance.

### Phase 2 — Managed execution and evidence

Implement action plans, trusted approval capture, resource leases, the durable run controller, artifact checks and user review. Reuse inherited submission, queue, history and model-residency operations.

**Exit:** an approved candidate executes locally, survives reconnect/restart, records its outcome and cannot bypass its effect restrictions. This phase is the first usable MVP; do not wait for a sophisticated ontology or learned optimizer.

### Phase 3 — Broader recipes and dependency acquisition

Expand to the certified recipe set. Add configured template-source adapters, Hugging Face manifests, dependency staging and approvals, semantic compatibility rules and bounded repair. Add exact protected-region evaluation and optional visual evaluators.

**Exit:** the release acceptance suite passes on a documented test matrix; unavailable or unsupported cases are reported honestly.

### Phase 4 — Dedicated Architect UX

Add a small companion panel change for task editing, candidate cards, approvals, progress, evidence and graph diffs. Retain stock-panel and external-client compatibility. Verify launch configuration selects the fork.

**Exit:** the entire workflow is usable inside ComfyUI without hiding graph changes or requiring a separate application.

### Phase 5 — Empirical optimization

Add comparable-run retrieval, calibrated resource estimation, benchmark management and optional learned ranking. Introduce automatic motif extraction or extra modalities only after the existing domain has sufficient evidence.

**Exit:** measured improvement over stock upstream on the agreed task suite, not merely a larger feature surface.

### 20.1 First implementation tasks

| Priority | Task | Deliverable |
|---|---|---|
| P0 | Establish baseline and package identity. | Baseline report, CI and connection smoke test. |
| P0 | Define versioned domain schemas and migration tests. | Zod contracts and fixture documents. |
| P0 | Build injected upstream facade. | Stable local interfaces with contract tests. |
| P0 | Add environment snapshot and recipe retrieval. | Read-only inspection and bounded catalog queries. |
| P0 | Implement template binding and layered validation. | Candidate package for three local recipes. |
| P0 | Implement grants and an effect-admission boundary. | Positive/negative approval tests across tool routes. |
| P0 | Implement owned-job execution and recovery. | Durable controller, idempotency and cancellation tests. |
| P0 | Add resource coordination and minimal evaluation. | Memory-aware local run with measured evidence. |
| P1 | Add approved acquisition and recipe coverage. | Certified recipe set and dependency manifests. |
| P1 | Add rich panel components. | Optional companion frontend change. |
| P2 | Add learned estimates and extended modalities. | Evidence-backed optimization, separately qualified. |

## 21. Risks and explicit limitations

| Risk | Treatment |
|---|---|
| Upstream evolves rapidly or documentation differs from code. | Pin source; adapter contract tests; reconcile every baseline change. |
| Sidebar and core are released separately. | Capability handshake, explicit launcher, paired compatibility tests and text fallback. |
| An apparently type-valid graph combines incompatible model families. | Semantic contracts and exact-version runtime evidence. |
| Hardware telemetry is incomplete or shared memory changes unexpectedly. | Conservative estimates, exclusive scheduling where needed, probes and failure recovery. |
| An external agent bypasses MCP through its own shell or network tools. | Restrict host permissions in managed mode and state the enforcement boundary. |
| Custom-node code performs hidden I/O or unsafe operations. | Approved dependencies and deployment isolation; graph inspection alone is not a sandbox. |
| A visual evaluator is wrong or rewards the wrong feature. | Task-specific rubrics, retained evidence, uncertainty and human acceptance. |
| Import conversion changes frontend-only semantics. | Preserve originals, certify a bounded subset and fail visibly on unknown constructs. |
| A model/provider is available but cannot reliably produce proposals. | Capability tests, schema validation, bounded repair and explicit fallback policy. |
| Downloaded models have ambiguous terms or source revisions. | Metadata/provenance and approval; do not label unknown rights as permitted. |
| Optimization is judged against an artificially weak baseline. | Same provider/assets/hardware and transparent benchmark inputs. |

The main delivery principle is: **retrieve and adapt known-good components; validate what can be checked; measure what can only be observed; ask the user to judge what remains subjective.**

## 22. Sources and inspection notes

Upstream facts are tied to the inspected baseline where possible. Sections describing new modules, contracts, policies, algorithms and acceptance targets are proposed design decisions, not upstream feature claims. Source inspection does not establish runtime correctness.

- **[S1] Upstream baseline commit.** `artokun/comfyui-mcp`, commit `707474d24d0d251ba04a1bebdf86620cef2eaa8b`; branch metadata retrieved on 15 November 2026. [Commit](https://github.com/artokun/comfyui-mcp/commit/707474d24d0d251ba04a1bebdf86620cef2eaa8b).
- **[S2] Package and dependencies.** Inspected `package.json`, version `0.52.206`. [Pinned source](https://github.com/artokun/comfyui-mcp/blob/707474d24d0d251ba04a1bebdf86620cef2eaa8b/package.json).
- **[S3] Tool registration and shared filtering.** Inspected `src/tools/index.ts`, including `TOOL_GROUPS`, direct registration and compact-surface filtering. [Pinned source](https://github.com/artokun/comfyui-mcp/blob/707474d24d0d251ba04a1bebdf86620cef2eaa8b/src/tools/index.ts).
- **[S4] Provider abstraction.** Inspected `src/orchestrator/agent-backend.ts`, including provider IDs, capability flags and normalized events. [Pinned source](https://github.com/artokun/comfyui-mcp/blob/707474d24d0d251ba04a1bebdf86620cef2eaa8b/src/orchestrator/agent-backend.ts).
- **[S5] Workflow authoring and validation entry points.** Inspected `src/tools/workflow-compose.ts`. [Pinned source](https://github.com/artokun/comfyui-mcp/blob/707474d24d0d251ba04a1bebdf86620cef2eaa8b/src/tools/workflow-compose.ts).
- **[S6] Conversion and experimental DSL.** Inspected `src/tools/workflow-visualize.ts`; it imports upstream conversion services and DSL actions. [Pinned source](https://github.com/artokun/comfyui-mcp/blob/707474d24d0d251ba04a1bebdf86620cef2eaa8b/src/tools/workflow-visualize.ts).
- **[S7] Workflow library integration.** Inspected `src/tools/workflow-library.ts` imports and source handling. [Pinned source](https://github.com/artokun/comfyui-mcp/blob/707474d24d0d251ba04a1bebdf86620cef2eaa8b/src/tools/workflow-library.ts).
- **[S8] Upstream feature/tool documentation.** README viewed on 15 November 2026. Tool counts and prose can differ across revisions; implementation must use the pinned code/schema. [Repository](https://github.com/artokun/comfyui-mcp).
- **[S9] Separate sidebar repository and connection behavior.** README viewed on 15 November 2026, including manual orchestrator connection, autospawn control and live-canvas operations. No panel source commit was independently pinned for this core specification. [Repository](https://github.com/artokun/comfyui-mcp-panel).
- **[S10] Hugging Face download documentation.** Revision-specific files, caching and dry-run download planning. [Official documentation](https://huggingface.co/docs/huggingface_hub/en/guides/download).
- **[S11] ComfyUI server API.** `/object_info`, `/system_stats`, workflow submission, queue/history and WebSocket routes. [Official documentation](https://docs.comfy.org/development/comfyui-server/comms_routes).
- **[S12] Ollama residency and local configuration.** Local FAQ, including `ollama ps`, unloading and `keep_alive` behavior. [Official documentation](https://docs.ollama.com/faq).
- **[S13] Codex app-server integration.** Official app-server protocol documentation, accessed 15 November 2026. [Official documentation](https://learn.chatgpt.com/docs/app-server).
- **[S14] Codex authentication modes.** Subscription sign-in versus API-key billing and credentials. [Official documentation](https://learn.chatgpt.com/docs/auth?surface=cli).

### Final implementation instruction

Start with the existing fork and deliver the smallest complete vertical slice through its actual services. Do not build a new general-purpose agent framework, graph editor, model downloader or provider layer before proving that the inherited component cannot meet the requirement.
