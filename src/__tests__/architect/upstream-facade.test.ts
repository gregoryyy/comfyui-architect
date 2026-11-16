// The facade's own classification and decoding (TODO 3.5, 3.7): which failed POST /prompt
// proves the prompt wasn't queued, and what a full decode of an output image says.

import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionError, WorkflowExecutionError } from "../../utils/errors.js";

const enqueue = vi.hoisted(() => ({ impl: async (): Promise<{ prompt_id: string }> => ({ prompt_id: "" }) }));

vi.mock("../../comfyui/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../comfyui/client.js")>();
  return { ...actual, enqueuePrompt: () => enqueue.impl() };
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
