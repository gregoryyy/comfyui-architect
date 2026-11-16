// The facade's own classification and decoding (TODO 3.5, 3.7): which failed POST /prompt
// proves the prompt wasn't queued, and what a full decode of an output image says; and the
// download functions over upstream's job registry (TODO 4.5.1).

import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionError, WorkflowExecutionError } from "../../utils/errors.js";

const enqueue = vi.hoisted(() => ({ impl: async (): Promise<{ prompt_id: string }> => ({ prompt_id: "" }), resets: 0 }));

vi.mock("../../comfyui/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../comfyui/client.js")>();
  return {
    ...actual,
    enqueuePrompt: () => enqueue.impl(),
    resetObjectInfoCache: () => {
      enqueue.resets += 1;
    },
  };
});

// Upstream's downloader, recorded: the facade's contract is which arguments it passes and
// how it maps the job records back (TODO 4.5.1).
const dl = vi.hoisted(() => ({
  resolveCalls: [] as unknown[][],
  startCalls: [] as unknown[][],
  manager: false,
  job: undefined as Record<string, unknown> | undefined,
  unresolved: undefined as string | undefined,
  progress: null as Record<string, unknown> | null,
  progressIds: [] as string[],
  cancel: {} as Record<string, unknown>,
  identityCalls: [] as unknown[][],
  fetchCalls: [] as unknown[][],
}));

vi.mock("../../services/model-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/model-resolver.js")>();
  return {
    ...actual,
    resolveDownloadTarget: async (...args: unknown[]) => {
      dl.resolveCalls.push(args);
      const [, sub, file] = args as [string, string, string];
      return { targetDir: `/models/${sub}`, filename: file, targetPath: `/models/${sub}/${file}` };
    },
    shouldDispatchDownloadToManager: async () => dl.manager,
    localDownloadCacheIdentity: (url: string, auth?: unknown) => {
      dl.identityCalls.push([url, auth]);
      return { cachePath: "/home/u/.comfyui-mcp/cache/abc.safetensors", partialPath: "/home/u/.comfyui-mcp/cache/.abc.safetensors.partial" };
    },
  };
});

vi.mock("../../services/download-proxy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/download-proxy.js")>();
  return {
    ...actual,
    downloadFetch: async (url: string, init?: RequestInit) => {
      dl.fetchCalls.push([url, init]);
      return new Response(null, { status: 200 });
    },
  };
});

vi.mock("../../services/download-jobs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/download-jobs.js")>();
  return {
    ...actual,
    startDownloadJob: async (...args: unknown[]) => {
      dl.startCalls.push(args);
      return { job: { id: "job-abc" } };
    },
    getDownloadJob: () => dl.job,
    describeUnresolvedDownload: () => dl.unresolved,
    cancelDownloadJob: () => dl.cancel,
  };
});

vi.mock("../../services/download-progress.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/download-progress.js")>();
  return {
    ...actual,
    readDownloadProgress: (id: string) => {
      dl.progressIds.push(id);
      return dl.progress;
    },
  };
});

const warm = vi.hoisted(() => ({ calls: [] as unknown[][], result: true }));

vi.mock("../../services/ollama-vram.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/ollama-vram.js")>();
  return {
    ...actual,
    warmOllama: async (...args: unknown[]) => {
      warm.calls.push(args);
      return warm.result;
    },
  };
});

const { ImageDecoderUnavailableError, createUpstreamFacade, isComfyRefusal } = await import(
  "../../services/architect/upstream.js"
);

const PROMPT_ID = "11111111-2222-4333-8444-555555555555";

/** What upstream's `buildEnqueueError` builds from a JSON error body with this status. */
function enqueueError(status: number): WorkflowExecutionError {
  return new WorkflowExecutionError(`ComfyUI rejected the workflow (${status}): bad`, {
    status,
    error: { message: "bad" },
    node_errors: {},
  });
}

describe("isComfyRefusal", () => {
  it("is ComfyUI's validation answer only: a WorkflowExecutionError with HTTP 400", () => {
    expect(isComfyRefusal(enqueueError(400))).toBe(true);
  });

  it("isn't a gateway's JSON error on a 5xx, nor an error without a status or of another class", () => {
    expect(isComfyRefusal(enqueueError(502))).toBe(false);
    expect(isComfyRefusal(enqueueError(504))).toBe(false);
    expect(isComfyRefusal(new WorkflowExecutionError("no details"))).toBe(false);
    expect(isComfyRefusal(new WorkflowExecutionError("odd details", { status: "400" }))).toBe(false);
    expect(isComfyRefusal(new ConnectionError("ComfyUI /prompt returned 400"))).toBe(false);
    expect(isComfyRefusal(new Error("socket hang up"))).toBe(false);
  });
});

describe("submitPrompt", () => {
  it("classifies ComfyUI's 400 as rejected", async () => {
    enqueue.impl = async () => {
      throw enqueueError(400);
    };
    expect(await createUpstreamFacade().submitPrompt({}, PROMPT_ID)).toMatchObject({ kind: "rejected" });
  });

  it("leaves a gateway's 504 with a JSON error body unknown: ComfyUI may have queued the prompt", async () => {
    enqueue.impl = async () => {
      throw enqueueError(504);
    };
    expect(await createUpstreamFacade().submitPrompt({}, PROMPT_ID)).toMatchObject({ kind: "unknown" });
  });

  it("passes an acceptance through", async () => {
    enqueue.impl = async () => ({ prompt_id: PROMPT_ID });
    expect(await createUpstreamFacade().submitPrompt({}, PROMPT_ID)).toEqual({ kind: "accepted", promptId: PROMPT_ID });
  });
});

describe("decodeImage", () => {
  afterEach(() => {
    delete process.env.COMFYUI_MCP_NO_SHARP;
  });

  const png = () => sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 0, g: 90, b: 200 } } }).png().toBuffer();

  it("returns the decoded size of a whole image", async () => {
    expect(await createUpstreamFacade().decodeImage(await png())).toEqual({ width: 640, height: 480 });
  });

  it("throws for a PNG whose header is whole but whose data is truncated", async () => {
    const whole = await png();
    await expect(createUpstreamFacade().decodeImage(whole.subarray(0, Math.floor(whole.length / 2)))).rejects.toThrow();
  });

  it("throws ImageDecoderUnavailableError, not a decode failure, when sharp is switched off", async () => {
    process.env.COMFYUI_MCP_NO_SHARP = "1";
    await expect(createUpstreamFacade().decodeImage(await png())).rejects.toBeInstanceOf(ImageDecoderUnavailableError);
  });
});

describe("loadOllama", () => {
  it("passes host, model and keep-alive to upstream's warm-up and returns its answer", async () => {
    warm.calls = [];
    warm.result = true;
    expect(await createUpstreamFacade().loadOllama("http://127.0.0.1:11434", "qwen3:32b", "600s")).toBe(true);
    expect(warm.calls).toEqual([["http://127.0.0.1:11434", "qwen3:32b", "600s"]]);
    warm.result = false;
    expect(await createUpstreamFacade().loadOllama("http://127.0.0.1:11434", "qwen3:32b", "-1m")).toBe(false);
  });
});

describe("the download functions (TODO 4.5.1)", () => {
  const job = (over: Record<string, unknown> = {}) => ({
    id: "job-abc",
    trayId: "tray-1",
    url: "https://huggingface.co/x",
    target_subfolder: "upscale_models",
    status: "downloading",
    started_at: 1,
    ...over,
  });

  it("resolves a destination with upstream's resolver; root is the folder's parent", async () => {
    dl.resolveCalls = [];
    expect(await createUpstreamFacade().resolveModelDestination("upscale_models", "x.safetensors")).toEqual({
      root: "/models",
      path: "/models/upscale_models/x.safetensors",
    });
    expect(dl.resolveCalls).toEqual([["https://huggingface.co/", "upscale_models", "x.safetensors"]]);
  });

  it("reports upstream's Manager route as it decides it", async () => {
    dl.manager = true;
    expect(await createUpstreamFacade().downloadRoutesToManager()).toBe(true);
    dl.manager = false;
    expect(await createUpstreamFacade().downloadRoutesToManager()).toBe(false);
  });

  it("starts a job never through the Manager and with no auth override", async () => {
    dl.startCalls = [];
    const r = await createUpstreamFacade().startDownload({ url: "https://huggingface.co/a/b/resolve/c/x.safetensors", subfolder: "upscale_models", filename: "x.safetensors.architect-run-1" });
    expect(r).toEqual({ jobId: "job-abc" });
    expect(dl.startCalls).toEqual([
      ["https://huggingface.co/a/b/resolve/c/x.safetensors", "upscale_models", "x.safetensors.architect-run-1", undefined, undefined, false, undefined],
    ]);
  });

  it("maps a job's state, path, error and progress; progress is read by the id upstream writes it under", async () => {
    const facade = createUpstreamFacade();
    dl.progressIds = [];
    dl.job = job({ progressId: "prog-1" });
    dl.progress = { downloaded: 10, total: 100 };
    expect(await facade.downloadStatus("job-abc")).toEqual({ status: "downloading", bytes: 10, totalBytes: 100 });
    expect(dl.progressIds).toEqual(["prog-1"]);
    dl.progress = { downloaded: 5, total: 0 };
    dl.job = job({ status: "done", path: "/models/x.safetensors" });
    expect(await facade.downloadStatus("job-abc")).toEqual({ status: "done", path: "/models/x.safetensors", bytes: 5 });
    dl.progress = null;
    dl.job = job({ status: "error", error: "HTTP 503" });
    expect(await facade.downloadStatus("job-abc")).toEqual({ status: "error", error: "HTTP 503" });
    dl.job = job({ status: "cancelled" });
    expect(await facade.downloadStatus("job-abc")).toEqual({ status: "cancelled" });
  });

  it("reads a job whose writer is proven gone, or one dispatched to the Manager, as an error", async () => {
    const facade = createUpstreamFacade();
    dl.progress = null;
    dl.job = job({ writerProvenGone: true, staleInflight: true });
    expect(await facade.downloadStatus("job-abc")).toMatchObject({ status: "error" });
    dl.job = job({ viaManager: true, status: "done" });
    expect(await facade.downloadStatus("job-abc")).toMatchObject({ status: "error" });
    // A stale record whose writer isn't proven gone may still be writing: downloading.
    dl.job = job({ staleInflight: true });
    expect(await facade.downloadStatus("job-abc")).toMatchObject({ status: "downloading" });
  });

  it("tells a job that is gone from one upstream won't pick (#796)", async () => {
    const facade = createUpstreamFacade();
    dl.job = undefined;
    dl.unresolved = undefined;
    expect(await facade.downloadStatus("job-abc")).toEqual({ status: "missing" });
    dl.unresolved = "two live downloads share this id";
    expect(await facade.downloadStatus("job-abc")).toEqual({ status: "unknown", error: "two live downloads share this id" });
  });

  it("cancels only what upstream aborted, and says when it couldn't", async () => {
    const facade = createUpstreamFacade();
    dl.cancel = { found: true, owned: true, aborted: true };
    expect(await facade.cancelDownload("job-abc")).toMatchObject({ cancelled: true });
    dl.cancel = { found: true, owned: true, aborted: false, status: "done" };
    expect(await facade.cancelDownload("job-abc")).toMatchObject({ cancelled: true });
    dl.cancel = { found: true, owned: false, aborted: false, status: "downloading", reclaimDenied: "owner-alive" };
    expect(await facade.cancelDownload("job-abc")).toMatchObject({ cancelled: false, message: expect.stringContaining("another process") });
    dl.cancel = { found: false, owned: false, aborted: false };
    expect(await facade.cancelDownload("job-abc")).toMatchObject({ cancelled: false });
  });

  it("forgets upstream's cached node schemas", () => {
    enqueue.resets = 0;
    createUpstreamFacade().forgetNodeSchemas();
    expect(enqueue.resets).toBe(1);
  });
});

describe("the download cache, network route and token (TODO 4.5.1)", () => {
  it("names the cache entry upstream's writer derives for the URL, with no auth override, and its sidecar", () => {
    dl.identityCalls = [];
    expect(createUpstreamFacade().downloadCacheEntry("https://huggingface.co/a/b/resolve/c/x.safetensors")).toEqual({
      dir: "/home/u/.comfyui-mcp/cache",
      cachePath: "/home/u/.comfyui-mcp/cache/abc.safetensors",
      partialPath: "/home/u/.comfyui-mcp/cache/.abc.safetensors.partial",
      contentTypeSidecar: "/home/u/.comfyui-mcp/cache/.abc.safetensors.ct",
    });
    expect(dl.identityCalls).toEqual([["https://huggingface.co/a/b/resolve/c/x.safetensors", undefined]]);
  });

  it("sends a preflight through upstream's download fetch, the one with its proxy decision", async () => {
    dl.fetchCalls = [];
    const init = { method: "HEAD", redirect: "manual" as const };
    expect((await createUpstreamFacade().downloadFetch("https://huggingface.co/x", init)).status).toBe(200);
    expect(dl.fetchCalls).toEqual([["https://huggingface.co/x", init]]);
  });

  it("reads upstream's Hugging Face token, and none when it's unset or blank", () => {
    const saved = { hf: process.env.HF_TOKEN, hug: process.env.HUGGINGFACE_TOKEN };
    try {
      delete process.env.HUGGINGFACE_TOKEN;
      process.env.HF_TOKEN = " hf_abc ";
      expect(createUpstreamFacade().huggingfaceToken()).toBe("hf_abc");
      process.env.HF_TOKEN = "  ";
      expect(createUpstreamFacade().huggingfaceToken()).toBeUndefined();
    } finally {
      if (saved.hf === undefined) delete process.env.HF_TOKEN;
      else process.env.HF_TOKEN = saved.hf;
      if (saved.hug === undefined) delete process.env.HUGGINGFACE_TOKEN;
      else process.env.HUGGINGFACE_TOKEN = saved.hug;
    }
  });
});
