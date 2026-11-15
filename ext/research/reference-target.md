# Reference target: environment record

The machine, ComfyUI installs, models and local LLMs that milestone 1 found on 2026-11-15, for GAPS Q5 (reference target) and Q9 (local planner), and as input to the choice of the first certified model families (TODO 1.2.1). Facts were read with `curl` against the running ComfyUI and Ollama, and from the file system. Status: 2026-11-15 17:43.

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

## Models in the second root (correction, 2026-11-15 17:27)

The first survey missed that the active Desktop configuration (`~/Library/Application Support/Comfy Desktop/instance-model-paths/inst-1794196570373.yaml`, changed 2026-11-15 12:06) has a second root, `comfy.desktop_1`, at `~/Documents/model/comfyui/models` (150 GB). The Desktop ComfyUI on port 8188 lists its files (`GET /models/<folder>`, 2026-11-15 17:27):

| Folder | Files |
| --- | --- |
| `diffusion_models` | **Z-Image Turbo** (bf16, 11 GB), **FLUX.1-schnell** (fp8, 16 GB), Wan 2.2 t2v and i2v 14B high- and low-noise (fp8), two Wan 2.2 t2v 4-step LoRAs, MiniMax H3 FL2VA |
| `text_encoders` | Qwen 3 4B (Z-Image's encoder), UMT5-XXL fp8 (Wan's), Qwen3-VL 32B for MiniMax H3 |
| `vae` | `ae.safetensors` (Flux and Z-Image), Wan 2.1 VAE, MiniMax H3 video and audio VAEs; also a copy of `qwen_3_4b.safetensors`, a text encoder in the VAE folder |
| `loras` | Wan 2.2 i2v 4-step LoRAs, MiniMax H3 FL2V turbo |

So two image families are present: Z-Image Turbo is complete. FLUX.1-schnell is Comfy-Org's all-in-one checkpoint: its header holds the diffusion model, both text encoders (CLIP-L, T5-XXL) and the VAE, so nothing is missing, but it sits in `diffusion_models/`, where `CheckpointLoaderSimple` doesn't look (GAPS Q13). The reference install on port 8190 doesn't read this root.

Before the correction, this note said: **no image-only model family is installed** (no Flux, SDXL, SD 3.x, Qwen-Image or Z-Image checkpoint); the installed models are for video and audio. That held for the first root only.

## Local LLMs (Ollama)

Fifteen models are installed, among them `gemma4:31b-mlx`, `qwen3.8:27b-mlx`, `qwen3.6:35b`, `nemotron3:33b-mlx`, `flint:40b`, `mixtral:8x7b`, `glm-4.7-flash:q8_0`, `mimo-v2.6:9b`, `llama3.1:8b` and `llama3.2:3b`. Upstream's default planner `artokun/gemma4-comfyui-mcp:e4b` (GAPS Q9) is **not installed**; using it needs an `ollama pull`.

## Consequences

- **Image families (GAPS Q12, answered):** Z-Image Turbo runs on the Desktop install as installed; FLUX.1-schnell needs either the all-in-one file visible in `checkpoints/` or separate encoders (GAPS Q13). The reference install on 8190 needs `extra_model_paths.yaml` pointing at the second root to see either.
- **The installed models fit video and audio,** the kinds ROAD phase 6 schedules after the MVP (GAPS Q10).
- **The reference install has to run** for integration tests (TODO 1.1.3); its nested layout should be checked before relying on it.
