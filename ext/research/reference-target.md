# Reference target: environment record

The machine, ComfyUI installs, models and local LLMs that milestone 1 found on 2026-11-15, for GAPS Q5 (reference target) and Q9 (local planner), and as input to the choice of the first certified model families (TODO 1.2.1). Facts were read with `curl` against the running ComfyUI and Ollama, and from the file system. Status: 2026-11-15 15:10.

## Machine

- Apple M5 Pro, 48 GB unified memory (`sysctl`). ComfyUI reports one device, `mps`, with 48 GB: GPU memory and host RAM are one pool, so reasoning and rendering compete for it (SPEC §11.1).
- Node.js 26.13.0, npm 11.20.0 (CI uses Node 22).

## ComfyUI installs

| Install | Path | State on 2026-11-15 | Models |
| --- | --- | --- | --- |
| **Reference target** (GAPS Q5): source install with its own venv | `~/Documents/opt/flux/ComfyUI` | Not running (its pid file names a process that has exited). Nested layout: a second checkout at `ComfyUI/ComfyUI/ComfyUI/` holds `models/` and three custom nodes (`comfyui-bbox-autorescale`, `foreach`, `rescalecfgadvanced`); the top level has ComfyUI-Manager | 1.8 GB: one MiniMax H3 video LoRA |
| ComfyUI Desktop | `~/ComfyUI-Installs/ComfyUI (1)/ComfyUI` | **Running on port 8188**: ComfyUI 0.44.0, Python 3.13.12, 1,049 node classes, flags `--enable-manager --enable-assets` | Through `~/Library/Application Support/Comfy Desktop/instance-model-paths/*.yaml`: the shared folder below; input and output in `~/ComfyUI-Shared/` |

Upstream auto-selects the Desktop install. Work against the reference target needs `COMFYUI_PATH` pointing at it and that install running instead of, or next to, Desktop on another port.

## Models in the shared folder

`~/ComfyUI-Shared/models`, 124 GB, used by the Desktop install:

| Folder | Files |
| --- | --- |
| `diffusion_models` | LTX 2.5 22B distilled (int8), MiniMax H3 FL2VA and Ref2VA (int8), MiniMax Music 3 DiT (fp16) |
| `checkpoints` | YuE2 3B (int8), music |
| `vae` | LTX 2.5 video and audio VAEs, MiniMax H3 video and audio VAEs, and two more |
| `text_encoders` | Gemma 4 12B for LTX 2.5, Gemma 4 E2B, MiniMax Music 3 text encoder, Qwen3-VL 32B for MiniMax H3 (NVFP4) |
| `loras` | MiniMax H3 FL2V turbo 8-step |

**No image-only model family is installed** (no Flux, SDXL, SD 3.x, Qwen-Image or Z-Image checkpoint). The installed models are for video and audio.

## Local LLMs (Ollama)

Fifteen models are installed, among them `gemma4:31b-mlx`, `qwen3.8:27b-mlx`, `qwen3.6:35b`, `nemotron3:33b-mlx`, `flint:40b`, `mixtral:8x7b`, `glm-4.7-flash:q8_0`, `mimo-v2.6:9b`, `llama3.1:8b` and `llama3.2:3b`. Upstream's default planner `artokun/gemma4-comfyui-mcp:e4b` (GAPS Q9) is **not installed**; using it needs an `ollama pull`.

## Consequences

- **The first certified image families need downloads** on either install. Which 2–3 families to certify (SPEC §2.2) is an owner decision; the machine's 48 GB pool allows the common image families, and the int8 `convrot` builds in the shared folder show the user already runs quantized models.
- **The installed models fit video and audio,** the kinds ROAD phase 6 schedules after the MVP (GAPS Q10).
- **The reference install has to run** for integration tests (TODO 1.1.3); its nested layout should be checked before relying on it.
