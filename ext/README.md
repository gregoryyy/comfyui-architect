# Comfy Architect

Planning: ChatGPT: Product Architect/ComfyUI Workflow Architecture

[Comfy Architect](./comfy-architect-system-spec.md) is designed to turn a natural-language task into an executable ComfyUI workflow, taking account of quality targets, installed models, available templates, and compute and memory limits. Rather than simply generating graph JSON, it retrieves suitable workflow patterns, selects compatible components, compares feasible alternatives, and explains their quality, speed, and resource trade-offs. Missing models or dependencies can be proposed for download, subject to user approval.

The implementation extends a fork of **`artokun/comfyui-mcp`**, reusing its provider integrations, workflow tooling, model management, and execution infrastructure. Comfy Architect adds structured task specifications, a capability knowledge base, constraint-aware planning, and a bounded execution-and-evaluation loop. The same core serves external MCP clients and the ComfyUI sidebar, using local Ollama models or configured Claude, Codex, and API providers. Deterministic checks govern graph compatibility and permitted actions; test renders and user feedback establish whether the resulting workflow actually meets the intended outcome.


