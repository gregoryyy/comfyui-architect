# Roadmap

Phases with a goal and a measured gate each, and ideas that aren't scheduled. The phases are the spec's (§20); a phase becomes TODO milestones when it starts. Status: 2026-11-15 18:49.

## 0. Reproducible fork and seam audit (done except the first CI run)

**Goal:** a fork that builds, identifies itself and behaves like upstream until Architect is switched on, with the seams for the Architect layer in place. TODO milestone 1.

**Gate:** the fork launches from an installed package and identifies itself correctly; it works with an external MCP client and the stock panel; with Architect disabled, upstream's suite passes and the tool surface equals the baseline's. Baseline failures are recorded, not attributed to the fork.

## 1. One end-to-end planning slice (done)

**Goal:** describe an image task, compare candidates built from installed assets, and get an editable graph with explicit constraints and provenance. Read-only: no downloads, no execution. TODO milestone 2.

**Gate:** three curated recipes compile and validate; a task fixture produces up to three candidates with recorded rejection reasons; malformed proposals never pass validation (AT-01); deliberate conflicts are blocked with the right reason (AT-02).

## 2. Managed execution and evidence (first usable MVP) (next)

**Goal:** an approved candidate executes locally, survives reconnect and restart, records its outcome, and can't bypass its effect restrictions. Action plans, trusted approval capture, resource leases, the durable run controller, artifact checks and user review.

**Gate:** no unapproved effect succeeds on any route (AT-05); lost submissions never cause duplicate renders (AT-06); cancellation and recovery never touch unrelated jobs or canvases (AT-07); every run has full lineage and separate verdicts (AT-08); reasoning and rendering are serialized when memory requires it (AT-10).

## 3. Broader recipes and dependency acquisition

**Goal:** the certified recipe set (12–20 variants, 2–3 families), configured template sources, Hugging Face manifests, staged and approved dependencies, semantic compatibility rules, bounded repair, protected-region evaluation and optional visual evaluators.

**Gate:** the reference acceptance suite passes on a documented test matrix (spec §19.2, AT-01 to AT-12, with AT-04's 90% as the proposed target); unsupported cases are reported as such.

## 4. Dedicated Architect UX

**Goal:** the whole workflow inside ComfyUI: task editing, candidate cards, approvals, progress, evidence and graph diffs, through a small companion change to the panel (GAPS Q7). The stock panel and external clients keep working.

**Gate:** the end-to-end workflow runs in the panel without hiding graph changes; launch configuration selects the fork; an old panel falls back to text and choice controls.

## 5. Empirical optimization

**Goal:** comparable-run retrieval, calibrated resource estimates, benchmark management, optional learned ranking.

**Gate:** measured improvement over stock upstream on the agreed task suite, with the same provider, assets and hardware, and blinded comparison for subjective quality (spec §19.3). A larger feature surface alone doesn't pass.

## 6. Every kind of workflow

**Goal:** the product's full scope (owner, 2026-11-15): video, audio, 3D and pipelines that combine them, each kind with its own recipes, resource models and evaluators (FR-17). The kinds come one at a time, in the order GAPS Q10 decides. Phases 3–5 may already overlap with the first one.

**Gate, per kind:** its certified recipes pass a kind-specific acceptance suite built like spec §19.2; its resource model is checked against measured runs on the test matrix; its evaluators state what they can and can't verify. Adding the kind doesn't change the core contracts.

## Unscheduled ideas

- **The package rename** to `@gregoryyy/comfyui-architect` and the command `comfyui-architect`, through one identity module, as its own milestone before the first publish, together with command shorthands, the publishing preparation and the README's install section (the new README.md came first, GAPS Q11); until then package, command and server name stay `comfyui-mcp` (GAPS Q11, TODO 1.3.1–1.3.3).
- **Motif extraction** from arbitrary imported workflows (FR-16).
- **Upstream extension points** for tool registration, per-action policy and agent pausing; if upstream accepts them, ComfyUI Architect becomes an add-on package instead of a fork (GAPS Q8).
- **An unattended runner** that drives the same state machine through an explicit backend session (spec §5.2).
- **A hosted or shared deployment**, which needs its own authentication and deployment review; a local user's subscription session is never a shared credential (spec §12.1).
