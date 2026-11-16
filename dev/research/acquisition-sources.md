# Acquisition sources: downloads, templates and packs

What upstream already offers for downloading models, installing custom nodes and importing workflows, what ComfyUI's own template library holds, and what Hugging Face's API reports about a file. Serves GAPS Q24 to Q28 and TODO milestones 4 to 6 (ROAD phase 3). Gathered on 2026-11-16: upstream's code at the pinned baseline `707474d2` read through a code survey, the reference target (ComfyUI Desktop 0.44.0 on port 8188) queried over HTTP, and Hugging Face's public API queried for one file.

## Upstream's download path

- `download_model` takes a URL only (Hugging Face `resolve/<rev>/…`, any http(s) URL, `s3://`, Azure Blob). There is no input for repository, file and revision. CivitAI IDs are turned into a URL (`src/services/civitai-resolver.ts:366,454`).
- A Hugging Face revision is never resolved to a commit; the search code builds `resolve/main` URLs (`src/services/missing-models.ts:397`).
- The entry point a service can call is `startDownloadJob(url, targetSubfolder, filename?, auth?, onComplete?, dispatchToManagerOverride?, modelRoot?)` (`src/services/download-jobs.ts:412`), with `getDownloadJob`, `findDownloadJob`, `listDownloadJobs` and `cancelDownloadJob` (:1415, :1595, :1668, :2038). A job is `downloading`, `done`, `error` or `cancelled`, with `live_visible` once ComfyUI lists the file. Job records persist across sessions.
- The destination is resolved by `resolveDownloadTarget` (`src/services/model-resolver.ts:3314`): the live server's model root plus a relative subfolder. Absolute paths, `..` and `custom_nodes` are refused, the file name must be a bare name, and the writer refuses when the live root changed between resolving and writing (:4440).
- When upstream can't resolve the server's model root, or the target is remote, the download goes to ComfyUI-Manager's install-model instead (`shouldDispatchDownloadToManager`, :4274). Those jobs aren't verified and can't be cancelled.
- Integrity: no expected hash or size can be passed. The writer rejects HTML or JSON bodies and checks the written size against `Content-Length` or Hugging Face's `X-Linked-Size`. `X-Linked-Etag`, the file's sha256, is used only to validate a resume and never compared with a computed hash (`src/services/download-cache.ts:1848-1903`).
- Redirects are followed by hand, up to five hops; credentials are dropped on a cross-origin hop. There is no host allow list (`src/services/download-cache.ts:1866,1946`).
- Partial downloads resume from `~/.comfyui-mcp/cache` (`COMFYUI_DOWNLOAD_CACHE_DIR`).
- Tokens come from `HF_TOKEN` or `HUGGINGFACE_TOKEN` and `CIVITAI_API_TOKEN`, and are sent only to `huggingface.co` and `civitai.com` (`src/services/model-resolver.ts:3591`).
- `FileHasher.getHash` (`src/services/file-hasher.ts:35`) computes a local sha256, cached in SQLite.

## Hugging Face's API for one file

For `Comfy-Org/z_image_turbo`, `split_files/vae/ae.safetensors`:
- `/api/models/<repo>/revision/main` returns the commit (`6fc90a3b…`), the licence from the model card (`apache-2.0`) and whether the repository is gated (`false`).
- `/api/models/<repo>/tree/<rev>/<dir>` returns per file its size and `lfs.oid`, the sha256 (`afc8e282…`, 335,304,388 bytes).
- `resolve/main/…` answers 307 to the repository's new name (`Comfy-Org/Z-Image-Turbo`) before the file's storage host. A manifest therefore records the commit and the repository as resolved, and a renamed repository shows up as a redirect to check.

## Custom-node installs

`installCustomNode` (`src/services/node-management.ts:4316`) pins a git commit, branch or tag through `ref`, or a registry `version` (default `latest`), and installs through comfy-cli, ComfyUI-Manager or a git clone. Upstream asks no approval at tool level; its controls are the `readonly` preset, the panel's pin guard and ComfyUI-Manager's `security_level`.

## ComfyUI's template library

The reference target serves its template index at `/templates/index.json`: 12 categories, 216 templates under Image and 48 under Image Tools, 142 of them open-source local templates (the rest are API nodes). Each entry has `name`, `title`, `tags`, `models`, `size` (bytes of model files), `minComfyUIVersion` and more. The workflow comes from `/templates/<name>.json`, in UI format, with the graph usually inside a subgraph; its loader nodes carry `properties.models` with `name`, `url` and `directory`. The URLs point at `resolve/main` and carry no hash.

Image templates by operation, with the families relevant here (sizes are the index's `size`, the model files a template needs):

| Operation | Templates (family, size) |
| --- | --- |
| Text to image | `image_z_image_turbo` (Z-Image Turbo, 20.8 GB), `image_z_image_turbo_int8` (12.1 GB), `flux_schnell` (FLUX.1-schnell, 17.2 GB), `image_qwen_image` (Qwen-Image, 31.8 GB), `image_flux2_klein_text_to_image` (FLUX.2 Klein, 17.1 GB), `sdxl_simple_example` (SDXL, 13.0 GB) |
| Image edit, reference images | `image_qwen_image_edit_2511_int8` (Qwen-Image-Edit 2511, 31.0 GB), `flux_kontext_dev_basic` (FLUX.1 Kontext dev, 17.6 GB), `image_flux2_klein_image_edit_4b_distilled` (FLUX.2 Klein 4B, 12.5 GB) |
| Inpainting, outpainting | `flux_fill_inpaint_example`, `flux_fill_outpaint_example` (FLUX.1 Fill dev, 34.1 GB and 10.4 GB), `image_qwen_image_instantx_inpainting_controlnet` (36.0 GB) |
| Control | `image_z_image_turbo_fun_union_controlnet` (Z-Image Turbo, 23.8 GB) |
| Upscale | `utility_z_image_turbo_2k_upscaler.app` (Z-Image Turbo, 20.7 GB), `utility_seedvr2_3b_int8_upscale_image` (SeedVR2 3B, 4.0 GB) |

The templates checked (Z-Image Turbo, FLUX.1 Kontext, Qwen-Image-Edit 2511 int8, SeedVR2 3B) use core node classes only. Upstream reads core templates only by a known name (`src/tools/template-schema.ts:476`) and never reads the index.

## Upstream's packs

57 packs under `packs/`, 32 of them image: Z-Image (14, base and turbo, with text to image, image to image, inpaint and control), Anima, ERNIE and Krea 2 (4 each), Ideogram and Qwen (3 each). There are no Flux, SDXL or upscaler packs; upscale models ship inside 19 manifests (`4x-ClearRealityV1`, `4x_foolhardy_Remacri`, `RealESRGAN_x4plus_anime_6B`). A manifest lists `custom_nodes` as unpinned GitHub URLs and `models` as URLs without hash or size; about 475 URLs use `resolve/main`, and about 305 point at a third-party mirror (`Aitrepreneur/FLX`).

## The reference target

206 GB free on the volume that holds the model roots (2026-11-16); the second model root holds 150 GB. No upscale model is installed. Ollama has `glm-ocr:bf16` (2.7 GB) and no other model reported as a vision model.

## Consequences

- Upstream's downloader can carry the bytes, but a manifest the spec accepts (§8.3, §14.4: pinned revision, approved source, destination, size bound, hash recorded) has to be built by Architect: the commit from the revision endpoint, size and sha256 from the tree endpoint, a URL on the commit, and a hash check after the download against the manifest's sha256.
- Redirects cross hosts (the repository's new name, then the storage host), and upstream doesn't check them. Either Architect checks each hop before it hands upstream a URL, or `download-cache.ts` gets an optional redirect check, a seam in an upstream file to record in ARCH.
- Upstream's Manager route can't be verified or cancelled, so Architect refuses an acquisition that would take it.
- Template and pack URLs on `main` and on third-party mirrors aren't manifests. They name a candidate source; the manifest pins it.
- The certified set can probably stay on core nodes: the four templates checked, which cover text to image, edit, reference images and upscale, need no custom node. Inpainting and control templates weren't checked.
- A visual evaluator needs a vision model the target doesn't have yet; `glm-ocr` could back an OCR check.
