// The facade's reads for milestone 5 (TODO 5.3, 5.7.2): an input file through /view with
// upstream's bound, and an installed model file through upstream's resolver for existing files.

import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  fetch: [] as unknown[][],
  resolve: [] as unknown[][],
  fetchImpl: async (): Promise<{ base64: string; mimeType: string }> => ({ base64: Buffer.from("png bytes").toString("base64"), mimeType: "image/png" }),
  resolved: { path: "/m/vae/ae.safetensors", root: "/m", isFile: true, size: 335304388, mtimeMs: 1794141528000 },
}));

vi.mock("../../comfyui/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../comfyui/client.js")>();
  return {
    ...actual,
    fetchImage: (...args: unknown[]) => {
      calls.fetch.push(args);
      return calls.fetchImpl();
    },
  };
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
  it("reads /view?type=input with the subfolder split off and upstream's body bound", async () => {
    const out = await createUpstreamFacade().readInputFile("pets/2026/cat.png");
    expect(out.bytes.toString()).toBe("png bytes");
    expect(calls.fetch.at(-1)).toEqual(["cat.png", "input", "pets/2026", { maxBytes: MAX_INPUT_FILE_BYTES }]);
    expect(MAX_INPUT_FILE_BYTES).toBe(64 * 1024 * 1024);
  });

  it("passes a failed read on as an error, never as an empty file", async () => {
    calls.fetchImpl = async () => {
      throw new Error('ComfyUI /view returned 404 for "gone.png" (input)');
    };
    await expect(createUpstreamFacade().readInputFile("gone.png")).rejects.toThrow(/404/);
  });
});

describe("locateModelFile", () => {
  it("asks upstream's resolver for <folder>/<file> in read mode and returns path, size and mtime", async () => {
    await expect(createUpstreamFacade().locateModelFile("vae", "ae.safetensors")).resolves.toEqual({
      path: "/m/vae/ae.safetensors",
      sizeBytes: 335304388,
      mtimeMs: 1794141528000,
    });
    expect(calls.resolve.at(-1)).toEqual(["vae/ae.safetensors", { mode: "read" }]);
  });

  it("refuses a directory the resolver returns", async () => {
    calls.resolved = { ...calls.resolved, isFile: false };
    await expect(createUpstreamFacade().locateModelFile("vae", "sub")).rejects.toThrow(/not a file/);
  });
});
