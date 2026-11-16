// The facade's reads for milestone 5 (TODO 5.3, 5.7.2): an input file through /view with
// upstream's bound, and an installed model file through upstream's resolver for existing files.

import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  fetch: [] as unknown[][],
  fetchImage: 0,
  resolve: [] as unknown[][],
  fetchImpl: async (): Promise<Response> => new Response(Buffer.from("png bytes"), { status: 200 }),
  baseUrl: "http://127.0.0.1:8188",
  cloud: false,
  resolved: { path: "/m/vae/ae.safetensors", root: "/m", isFile: true, size: 335304388, mtimeMs: 1794141528000 },
}));

vi.mock("../../comfyui/fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../comfyui/fetch.js")>();
  return {
    ...actual,
    comfyuiFetch: (...args: unknown[]) => {
      calls.fetch.push(args);
      return calls.fetchImpl();
    },
  };
});

vi.mock("../../comfyui/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../comfyui/client.js")>();
  return {
    ...actual,
    // Upstream's /view reader, with its cloud and panel routes, is never used for inputs.
    fetchImage: async () => {
      calls.fetchImage += 1;
      throw new Error("fetchImage must not be called for an input file");
    },
  };
});

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return { ...actual, getComfyUIBaseUrl: () => calls.baseUrl, isCloudMode: () => calls.cloud };
});

vi.mock("../../services/model-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/model-resolver.js")>();
  return {
    ...actual,
    resolveExistingModelFile: async (...args: unknown[]) => {
      calls.resolve.push(args);
      const r = calls.resolved;
      return { path: r.path, root: r.root, info: { isFile: () => r.isFile, size: r.size, mtimeMs: r.mtimeMs } };
    },
  };
});

const { MAX_INPUT_FILE_BYTES, createUpstreamFacade } = await import("../../services/architect/upstream.js");

describe("readInputFile", () => {
  it("reads /view?type=input directly from the loopback target, with the subfolder split off", async () => {
    const out = await createUpstreamFacade().readInputFile("pets/2026/cat.png");
    expect(out.bytes.toString()).toBe("png bytes");
    expect(calls.fetch.at(-1)).toEqual(["http://127.0.0.1:8188/view?filename=cat.png&type=input&subfolder=pets%2F2026", { redirect: "manual" }]);
    expect(calls.fetchImage).toBe(0);
    expect(MAX_INPUT_FILE_BYTES).toBe(64 * 1024 * 1024);
  });

  it("passes a failed read or a redirect on as an error, never as an empty file", async () => {
    calls.fetchImpl = async () => new Response("", { status: 404 });
    await expect(createUpstreamFacade().readInputFile("gone.png")).rejects.toThrow(/404/);
    calls.fetchImpl = async () => new Response("", { status: 302, headers: { location: "http://elsewhere.example/x.png" } });
    await expect(createUpstreamFacade().readInputFile("moved.png")).rejects.toThrow(/302/);
  });

  it("refuses a body over the bound, by its length header and as it streams", async () => {
    calls.fetchImpl = async () => new Response("x", { status: 200, headers: { "content-length": String(MAX_INPUT_FILE_BYTES + 1) } });
    await expect(createUpstreamFacade().readInputFile("big.png")).rejects.toThrow(/over the/);
    const chunk = new Uint8Array(16 * 1024 * 1024);
    calls.fetchImpl = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            for (let i = 0; i < 5; i++) c.enqueue(chunk);
            c.close();
          },
        }),
        { status: 200 },
      );
    await expect(createUpstreamFacade().readInputFile("stream.png")).rejects.toThrow(/over the/);
  });

  it("refuses a target that isn't loopback, and cloud mode, without a request", async () => {
    const before = calls.fetch.length;
    calls.baseUrl = "http://192.168.1.20:8188";
    await expect(createUpstreamFacade().readInputFile("cat.png")).rejects.toThrow(/loopback/);
    calls.baseUrl = "http://127.0.0.1:8188";
    calls.cloud = true;
    await expect(createUpstreamFacade().readInputFile("cat.png")).rejects.toThrow(/cloud mode/);
    calls.cloud = false;
    expect(calls.fetch.length).toBe(before);
  });
});

describe("locateModelFile", () => {
  it("asks upstream's resolver for <folder>/<file> in read mode and returns path, size, mtime and root", async () => {
    await expect(createUpstreamFacade().locateModelFile("vae", "ae.safetensors")).resolves.toEqual({
      path: "/m/vae/ae.safetensors",
      sizeBytes: 335304388,
      mtimeMs: 1794141528000,
      root: "/m",
    });
    expect(calls.resolve.at(-1)).toEqual(["vae/ae.safetensors", { mode: "read" }]);
  });

  it("refuses a directory the resolver returns", async () => {
    calls.resolved = { ...calls.resolved, isFile: false };
    await expect(createUpstreamFacade().locateModelFile("vae", "sub")).rejects.toThrow(/not a file/);
  });
});
