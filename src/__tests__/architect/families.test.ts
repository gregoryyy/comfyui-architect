// Model families from safetensors headers (TODO 5.3; GAPS Q14): the shipped rules, the
// bounded header reader, the observation cache and the family check in validation.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FamilyObserver,
  HeaderReadError,
  MAX_HEADER_BYTES,
  classifyHeader,
  headerLength,
  loadFamilyRules,
  matchRule,
  parseHeaderJson,
  readSafetensorsHeader,
  rulesDigest,
  type TensorShapes,
} from "../../services/architect/families.js";
import { boundModelFiles } from "../../services/architect/planner.js";
import { FamilyRule, ModelObservation, Recipe } from "../../services/architect/schemas.js";
import { ArchitectStore } from "../../services/architect/store.js";
import { type FamilyEvidence, observationKey, validateGraph } from "../../services/architect/validate.js";
import { fixtureObjectInfo, fixtureRecipe, fixtureSnapshot, fixtureTask } from "./fixtures/load.js";

const T = "2026-11-16T09:00:00.000Z";
const { rules: SHIPPED, errors: LOAD_ERRORS, dirFound } = loadFamilyRules();
const rule = (id: string) => {
  const r = SHIPPED.find((x) => x.id === id);
  if (!r) throw new Error(`no shipped rule ${id}`);
  return r;
};

/** Tensor names and shapes as the observed headers have them (see each rule's provenance). */
function shapes(entries: Record<string, number[]>): TensorShapes {
  return new Map(Object.entries(entries));
}

const prefixed = (prefix: string, t: Record<string, number[]>) => Object.fromEntries(Object.entries(t).map(([k, v]) => [`${prefix}${k}`, v]));

const HEADERS = {
  zImage: {
    "cap_embedder.0.weight": [2560],
    "cap_embedder.1.weight": [3840, 2560],
    "x_embedder.weight": [3840, 64],
    "noise_refiner.0.attention.qkv.weight": [11520, 3840],
    "context_refiner.0.attention.qkv.weight": [11520, 3840],
    "layers.29.attention.qkv.weight": [11520, 3840],
    "final_layer.linear.weight": [64, 3840],
  },
  fluxDiffusion: {
    "double_blocks.18.img_attn.qkv.weight": [9216, 3072],
    "single_blocks.37.linear1.weight": [21504, 3072],
    "img_in.weight": [3072, 64],
    "txt_in.weight": [3072, 4096],
    "vector_in.in_layer.weight": [3072, 768],
    "final_layer.linear.weight": [64, 3072],
  },
  t5: {
    "shared.weight": [32128, 4096],
    "encoder.block.0.layer.0.SelfAttention.q.weight": [4096, 4096],
    "encoder.block.0.layer.0.SelfAttention.relative_attention_bias.weight": [32, 64],
    "encoder.block.23.layer.0.SelfAttention.q.weight": [4096, 4096],
  },
  clipL: {
    "text_model.embeddings.token_embedding.weight": [49408, 768],
    "text_model.embeddings.position_embedding.weight": [77, 768],
    "text_model.encoder.layers.11.self_attn.q_proj.weight": [768, 768],
  },
  qwen: {
    "model.embed_tokens.weight": [151936, 2560],
    "model.layers.35.self_attn.q_norm.weight": [128],
    "model.norm.weight": [2560],
  },
  fluxAe: {
    "encoder.conv_in.weight": [128, 3, 3, 3],
    "encoder.conv_out.weight": [32, 512, 3, 3],
    "decoder.conv_in.weight": [512, 16, 3, 3],
    "decoder.conv_out.weight": [3, 128, 3, 3],
  },
  esrgan: {
    "conv_first.weight": [64, 3, 3, 3],
    "body.22.rdb3.conv5.weight": [64, 32, 3, 3],
    "conv_up1.weight": [64, 64, 3, 3],
    "conv_up2.weight": [64, 64, 3, 3],
    "conv_hr.weight": [64, 64, 3, 3],
    "conv_last.weight": [3, 64, 3, 3],
  },
  // The files below aren't installed on the reference target: their names and shapes are
  // from the headers each rule's provenance cites, read with HTTP Range requests.
  flux2Klein4b: {
    "double_blocks.4.img_attn.qkv.weight": [9216, 3072],
    "single_blocks.19.linear1.weight": [27648, 3072],
    "double_stream_modulation_img.lin.weight": [18432, 3072],
    "single_stream_modulation.lin.weight": [9216, 3072],
    "img_in.weight": [3072, 128],
    "txt_in.weight": [3072, 7680],
    "time_in.in_layer.weight": [3072, 256],
    "final_layer.linear.weight": [128, 3072],
  },
  flux2Vae: {
    "bn.running_mean": [128],
    "bn.running_var": [128],
    "encoder.conv_in.weight": [128, 3, 3, 3],
    "encoder.conv_out.weight": [64, 512, 3, 3],
    "encoder.quant_conv.weight": [64, 64, 1, 1],
    "decoder.post_quant_conv.weight": [32, 32, 1, 1],
    "decoder.conv_in.weight": [512, 32, 3, 3],
    "decoder.conv_out.weight": [3, 128, 3, 3],
  },
  zImageControlnetUnion: {
    "control_all_x_embedder.2-1.weight": [3840, 64],
    "control_layers.0.before_proj.weight": [3840, 3840],
    "control_layers.5.after_proj.weight": [3840, 3840],
    "control_layers.5.attention.to_q.weight": [3840, 3840],
    "control_noise_refiner.1.attention.to_q.weight": [3840, 3840],
  },
  seedvr2_3b: {
    "vid_in.proj.weight": [2560, 132],
    "txt_in.weight": [2560, 5120],
    "emb_in.proj_in.weight": [2560, 256],
    "blocks.0.attn.proj_qkv.vid.weight": [7680, 2560],
    "blocks.31.attn.proj_qkv.all.weight": [7680, 2560],
    "vid_out.proj.weight": [64, 2560],
    positive_conditioning: [58, 5120],
  },
  seedvr2Vae: {
    "encoder.conv_in.weight": [128, 3, 3, 3, 3],
    "encoder.conv_out.weight": [32, 512, 3, 3, 3],
    "encoder.down_blocks.0.resnets.0.conv1.weight": [128, 128, 3, 3, 3],
    "decoder.conv_in.weight": [512, 16, 3, 3, 3],
    "decoder.up_blocks.0.upsamplers.0.upscale_conv.weight": [4096, 512, 1, 1, 1],
    "decoder.conv_out.weight": [3, 128, 3, 3, 3],
  },
} satisfies Record<string, Record<string, number[]>>;

describe("the shipped family rules", () => {
  it("load without errors, one per family the shipped recipes bind", () => {
    expect(dirFound).toBe(true);
    expect(LOAD_ERRORS).toEqual([]);
    expect(SHIPPED.map((r) => r.id).sort()).toEqual([
      "clip-l",
      "flux-ae",
      "flux1-schnell",
      "flux2-klein-4b",
      "flux2-vae",
      "qwen-3-4b",
      "realesrgan-x4",
      "seedvr2-3b",
      "seedvr2-vae",
      "t5-xxl",
      "z-image-controlnet-union",
      "z-image-turbo",
    ]);
    for (const r of SHIPPED) expect(r.provenance.length).toBeGreaterThan(0);
  });

  it("cover every modelFamily a shipped recipe names, by id or alias, for the slot's folder", async () => {
    const { loadRecipeDir, SHIPPED_RECIPES_DIR } = await import("../../services/architect/catalog.js");
    const { ruleForFamily } = await import("../../services/architect/validate.js");
    for (const { recipe } of loadRecipeDir(SHIPPED_RECIPES_DIR).recipes) {
      for (const s of recipe.slots.filter((x) => x.valueType === "model_file" && x.modelFamily)) {
        expect(ruleForFamily(SHIPPED, s.modelFamily ?? "", s.modelFolder ?? ""), `${recipe.id}.${s.id} (${s.modelFamily})`).toBeDefined();
      }
    }
  });

  it.each([
    ["zImage", "z-image-turbo"],
    ["fluxDiffusion", "flux1-schnell"],
    ["t5", "t5-xxl"],
    ["clipL", "clip-l"],
    ["qwen", "qwen-3-4b"],
    ["fluxAe", "flux-ae"],
    ["esrgan", "realesrgan-x4"],
    ["flux2Klein4b", "flux2-klein-4b"],
    ["flux2Vae", "flux2-vae"],
    ["zImageControlnetUnion", "z-image-controlnet-union"],
    ["seedvr2_3b", "seedvr2-3b"],
    ["seedvr2Vae", "seedvr2-vae"],
  ] as const)("the %s header matches %s and no other rule", (name, id) => {
    expect(classifyHeader(SHIPPED, shapes(HEADERS[name]))).toMatchObject({ outcome: "matched", family: id, matches: [id] });
  });

  it("matches FLUX.1-schnell inside Comfy-Org's all-in-one checkpoint, prefixes and all", () => {
    const ckpt = shapes({
      ...prefixed("model.diffusion_model.", HEADERS.fluxDiffusion),
      ...prefixed("text_encoders.t5xxl.transformer.", HEADERS.t5),
      ...prefixed("text_encoders.clip_l.transformer.", HEADERS.clipL),
      ...prefixed("vae.", HEADERS.fluxAe),
    });
    expect(classifyHeader(SHIPPED, ckpt)).toMatchObject({ outcome: "matched", family: "flux1-schnell" });
  });

  it("keeps Z-Image and FLUX apart, and FLUX.1-dev out of schnell", () => {
    expect(matchRule(rule("z-image-turbo"), shapes(HEADERS.fluxDiffusion)).matches).toBe(false);
    expect(matchRule(rule("flux1-schnell"), shapes(HEADERS.zImage)).matches).toBe(false);
    const dev = shapes({ ...HEADERS.fluxDiffusion, "guidance_in.in_layer.weight": [3072, 256] });
    expect(matchRule(rule("flux1-schnell"), dev)).toMatchObject({ matches: false, reason: expect.stringContaining("guidance_in") });
  });

  it("keeps T5, UMT5, Qwen and Gemma encoders apart", () => {
    const umt5 = shapes({
      ...HEADERS.t5,
      "shared.weight": [256384, 4096],
      "encoder.block.1.layer.0.SelfAttention.relative_attention_bias.weight": [32, 64],
    });
    const gemma = shapes({ "model.embed_tokens.weight": [262144, 1536], "model.layers.0.self_attn.q_proj.weight": [2048, 1536] });
    const qwenVl32b = shapes({ ...HEADERS.qwen, "model.embed_tokens.weight": [151936, 5120], "visual.blocks.0.attn.qkv.weight": [3456, 1152] });
    expect(matchRule(rule("t5-xxl"), shapes(HEADERS.qwen)).matches).toBe(false);
    expect(matchRule(rule("qwen-3-4b"), shapes(HEADERS.t5)).matches).toBe(false);
    for (const h of [umt5, gemma, qwenVl32b]) expect(classifyHeader(SHIPPED, h).outcome).toBe("no_match");
  });

  it("keeps the FLUX autoencoder apart from a 4-channel SD VAE, and x4plus from x2plus", () => {
    const sdVae = shapes({ ...HEADERS.fluxAe, "decoder.conv_in.weight": [512, 4, 3, 3], "quant_conv.weight": [8, 8, 1, 1] });
    expect(matchRule(rule("flux-ae"), sdVae).matches).toBe(false);
    const x2 = shapes({ ...HEADERS.esrgan, "conv_first.weight": [64, 12, 3, 3] });
    expect(matchRule(rule("realesrgan-x4"), x2).matches).toBe(false);
  });

  it("keeps the rules of the files not yet installed off the installed families' files", () => {
    // The installed files' headers (each older rule's provenance): with the new rules
    // loaded, each still matches its own rule only, and no new rule matches any of them.
    const added = ["flux2-klein-4b", "flux2-vae", "z-image-controlnet-union", "seedvr2-3b", "seedvr2-vae"];
    const ckpt = shapes({
      ...prefixed("model.diffusion_model.", HEADERS.fluxDiffusion),
      ...prefixed("text_encoders.t5xxl.transformer.", HEADERS.t5),
      ...prefixed("text_encoders.clip_l.transformer.", HEADERS.clipL),
      ...prefixed("vae.", HEADERS.fluxAe),
    });
    for (const h of [HEADERS.zImage, HEADERS.fluxDiffusion, HEADERS.t5, HEADERS.clipL, HEADERS.qwen, HEADERS.fluxAe, HEADERS.esrgan]) {
      for (const id of added) expect(matchRule(rule(id), shapes(h)).matches, id).toBe(false);
    }
    for (const id of added) expect(matchRule(rule(id), ckpt).matches, `${id} on the all-in-one checkpoint`).toBe(false);
  });

  it("keeps FLUX.2 Klein apart from FLUX.1 and Klein 9B, and the FLUX.2 VAE from FLUX.1's and SeedVR2's", () => {
    expect(matchRule(rule("flux2-klein-4b"), shapes(HEADERS.fluxDiffusion)).matches).toBe(false);
    expect(matchRule(rule("flux1-schnell"), shapes(HEADERS.flux2Klein4b)).matches).toBe(false);
    const klein9b = shapes({ ...HEADERS.flux2Klein4b, "img_in.weight": [4096, 128], "txt_in.weight": [4096, 12288], "double_blocks.7.img_attn.qkv.weight": [12288, 4096] });
    expect(matchRule(rule("flux2-klein-4b"), klein9b).matches).toBe(false);
    expect(matchRule(rule("flux-ae"), shapes(HEADERS.flux2Vae)).matches).toBe(false);
    expect(matchRule(rule("flux2-vae"), shapes(HEADERS.fluxAe)).matches).toBe(false);
    expect(matchRule(rule("flux-ae"), shapes(HEADERS.seedvr2Vae)).matches).toBe(false);
    expect(matchRule(rule("flux2-vae"), shapes(HEADERS.seedvr2Vae)).matches).toBe(false);
    expect(matchRule(rule("seedvr2-vae"), shapes(HEADERS.flux2Vae)).matches).toBe(false);
  });

  it("keeps the ControlNet patch apart from the Z-Image model, and SeedVR2 3B from 7B", () => {
    expect(matchRule(rule("z-image-turbo"), shapes(HEADERS.zImageControlnetUnion)).matches).toBe(false);
    expect(matchRule(rule("z-image-controlnet-union"), shapes(HEADERS.zImage)).matches).toBe(false);
    // A later release with 15 control layers (0 to 14) isn't the pinned layout.
    const union2 = shapes({ ...HEADERS.zImageControlnetUnion, "control_layers.6.attention.to_q.weight": [3840, 3840], "control_layers.14.attention.to_q.weight": [3840, 3840] });
    expect(classifyHeader(SHIPPED, union2).outcome).toBe("no_match");
    const seedvr7b = shapes({ ...HEADERS.seedvr2_3b, "vid_in.proj.weight": [3072, 132], "blocks.35.attn.proj_qkv.all.weight": [9216, 3072] });
    expect(matchRule(rule("seedvr2-3b"), seedvr7b).matches).toBe(false);
  });

  it("refuses a rule file with an alias another rule already claims", () => {
    const dir = mkdtempSync(join(tmpdir(), "architect-families-"));
    try {
      writeFileSync(join(dir, "a.json"), JSON.stringify(rule("flux-ae")));
      writeFileSync(join(dir, "b.json"), JSON.stringify({ ...rule("qwen-3-4b"), aliases: ["flux1-vae"] }));
      writeFileSync(join(dir, "c.json"), "{ not json");
      const loaded = loadFamilyRules(dir);
      expect(loaded.rules.map((r) => r.id)).toEqual(["flux-ae"]);
      expect(loaded.errors.map((e) => e.message).join(" ")).toMatch(/flux1-vae is already used.*not valid JSON|not valid JSON.*flux1-vae is already used/s);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(loadFamilyRules(join(tmpdir(), "architect-no-such-dir")).dirFound).toBe(false);
  });
});

describe("the safetensors header reader", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function file(header: unknown, extra = 16, lengthOverride?: bigint): string {
    const dir = mkdtempSync(join(tmpdir(), "architect-header-"));
    dirs.push(dir);
    const body = Buffer.from(JSON.stringify(header));
    const prefix = Buffer.alloc(8);
    prefix.writeBigUInt64LE(lengthOverride ?? BigInt(body.length));
    const path = join(dir, "m.safetensors");
    writeFileSync(path, Buffer.concat([prefix, body, Buffer.alloc(extra)]));
    return path;
  }
  const entry = (shape: number[]) => ({ dtype: "BF16", shape, data_offsets: [0, 0] });

  it("reads tensor names and shapes and skips the metadata", async () => {
    const t = await readSafetensorsHeader(file({ __metadata__: { format: "pt" }, "x_embedder.weight": entry([3840, 64]) }));
    expect([...t.entries()]).toEqual([["x_embedder.weight", [3840, 64]]]);
  });

  it("refuses a header over the bound, past the end of the file, not JSON, or without tensors", async () => {
    const big = Buffer.alloc(8);
    big.writeBigUInt64LE(BigInt(MAX_HEADER_BYTES) + 1n);
    expect(() => headerLength(big)).toThrow(HeaderReadError);
    expect(() => headerLength(Buffer.alloc(4))).toThrow(/shorter/);
    await expect(readSafetensorsHeader(file({ a: entry([1]) }, 0, 10_000n))).rejects.toThrow(/past the end/);
    expect(() => parseHeaderJson(Buffer.from("{nope"))).toThrow(/isn't JSON/);
    expect(() => parseHeaderJson(Buffer.from(JSON.stringify({ __metadata__: {} })))).toThrow(/no tensors/);
    expect(() => parseHeaderJson(Buffer.from(JSON.stringify({ a: { shape: [1] } })))).toThrow(/no dtype/);
  });
});

// ---------------------------------------------------------------------------------------
// The observation cache

const stores: ArchitectStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function observerSetup(opts: { rules?: FamilyRule[]; budgetMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "architect-observe-"));
  dirs.push(dir);
  const store = ArchitectStore.open(dir);
  stores.push(store);
  let clock = Date.parse(T);
  const files = new Map<string, { size: number; mtimeMs: number; header: TensorShapes | Error }>([
    ["/models/diffusion_models/z.safetensors", { size: 100, mtimeMs: 1, header: shapes(HEADERS.zImage) }],
    ["/models/diffusion_models/flux.safetensors", { size: 200, mtimeMs: 1, header: shapes(HEADERS.fluxDiffusion) }],
  ]);
  const calls = { locate: 0, read: 0 };
  const observer = new FamilyObserver({
    store,
    rules: opts.rules ?? SHIPPED,
    now: () => new Date(clock),
    locateBudgetMs: opts.budgetMs,
    locate: async (folder, file) => {
      calls.locate += 1;
      clock += 5_000; // each locate costs seconds on the reference machine
      const path = `/models/${folder}/${file}`;
      const f = files.get(path);
      if (!f) throw new Error(`Model file not found: ${folder}/${file}`);
      return { path, sizeBytes: f.size, mtimeMs: f.mtimeMs };
    },
    statFile: async (path) => {
      const f = files.get(path);
      if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { size: f.size, mtimeMs: f.mtimeMs, isFile: () => true };
    },
    readHeader: async (path) => {
      calls.read += 1;
      const h = files.get(path)?.header;
      if (h === undefined) throw new Error("ENOENT");
      if (h instanceof Error) throw h;
      return h;
    },
  });
  return { store, observer, files, calls, advance: (ms: number) => (clock += ms) };
}

describe("FamilyObserver", () => {
  it("observes a file once, then reuses the observation while size and mtime match", async () => {
    const s = observerSetup();
    const first = await s.observer.observe("diffusion_models", "z.safetensors");
    expect(first).toMatchObject({ outcome: "matched", family: "z-image-turbo", sizeBytes: 100 });
    expect(s.store.getModelObservation("diffusion_models", "z.safetensors")).toEqual(first);
    const again = await s.observer.observe("diffusion_models", "z.safetensors");
    expect(again).toEqual(first);
    expect(s.calls).toEqual({ locate: 1, read: 1 });
  });

  it("reads again when the file changed or the rules changed", async () => {
    const s = observerSetup();
    await s.observer.observe("diffusion_models", "z.safetensors");
    s.files.set("/models/diffusion_models/z.safetensors", { size: 100, mtimeMs: 2, header: shapes(HEADERS.fluxDiffusion) });
    expect(await s.observer.observe("diffusion_models", "z.safetensors")).toMatchObject({ outcome: "matched", family: "flux1-schnell" });
    expect(s.calls.read).toBe(2);
    // A new rule set: the stored observation was matched against other rules.
    const other = new FamilyObserver({
      store: s.store,
      rules: SHIPPED.filter((r) => r.id !== "flux1-schnell"),
      now: () => new Date(T),
      locate: async () => ({ path: "/models/diffusion_models/z.safetensors", sizeBytes: 100, mtimeMs: 2 }),
      statFile: async () => ({ size: 100, mtimeMs: 2, isFile: () => true }),
      readHeader: async () => shapes(HEADERS.fluxDiffusion),
    });
    const re = await other.observe("diffusion_models", "z.safetensors");
    expect(re).toMatchObject({ outcome: "no_match", rulesDigest: rulesDigest(SHIPPED.filter((r) => r.id !== "flux1-schnell")) });
  });

  it("doesn't cache a file it couldn't locate or read, and says why", async () => {
    const s = observerSetup();
    expect(await s.observer.observe("diffusion_models", "missing.safetensors")).toMatchObject({ reason: expect.stringContaining("couldn't locate") });
    expect(s.store.getModelObservation("diffusion_models", "missing.safetensors")).toBeUndefined();
    s.files.set("/models/diffusion_models/z.safetensors", { size: 100, mtimeMs: 1, header: new Error("EIO") });
    expect(await s.observer.observe("diffusion_models", "z.safetensors")).toMatchObject({ reason: expect.stringContaining("EIO") });
    expect(s.store.getModelObservation("diffusion_models", "z.safetensors")).toBeUndefined();
  });

  it("caches a malformed header and a non-safetensors file as unreadable, never as a family", async () => {
    const s = observerSetup();
    s.files.set("/models/diffusion_models/z.safetensors", { size: 100, mtimeMs: 1, header: new HeaderReadError("the header isn't JSON") });
    s.files.set("/models/diffusion_models/old.ckpt", { size: 5, mtimeMs: 1, header: shapes({}) });
    expect(await s.observer.observe("diffusion_models", "z.safetensors")).toMatchObject({ outcome: "unreadable", matches: [] });
    expect(await s.observer.observe("diffusion_models", "old.ckpt")).toMatchObject({ outcome: "unreadable", reason: expect.stringContaining("not a .safetensors") });
    expect(s.calls.read).toBe(1);
  });

  it("stops locating when the call's budget runs out; cached files are still served", async () => {
    const s = observerSetup({ budgetMs: 4_000 });
    await s.observer.observe("diffusion_models", "z.safetensors");
    s.advance(60_000);
    const out = await s.observer.observeAll([
      { folder: "diffusion_models", file: "z.safetensors" },
      { folder: "diffusion_models", file: "flux.safetensors" },
      { folder: "diffusion_models", file: "other.safetensors" },
    ]);
    expect([...out.evidence.observations.keys()]).toEqual(["diffusion_models/z.safetensors", "diffusion_models/flux.safetensors"]);
    expect(out.unobserved).toEqual([{ folder: "diffusion_models", file: "other.safetensors", reason: expect.stringContaining("ran out") }]);
  });

  it("refuses a stored observation that claims a family without a single match", () => {
    const base = { schemaVersion: 1, folder: "vae", file: "ae.safetensors", sizeBytes: 1, mtimeMs: 1, path: "/m/vae/ae.safetensors", rulesDigest: "a".repeat(64), reason: "r", observedAt: T };
    expect(ModelObservation.safeParse({ ...base, outcome: "matched", family: "flux-ae", matches: ["flux-ae"] }).success).toBe(true);
    expect(ModelObservation.safeParse({ ...base, outcome: "matched", matches: ["flux-ae"] }).success).toBe(false);
    expect(ModelObservation.safeParse({ ...base, outcome: "no_match", family: "flux-ae", matches: [] }).success).toBe(false);
    expect(ModelObservation.safeParse({ ...base, outcome: "ambiguous", matches: ["flux-ae"] }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// The family check in validation (GAPS Q14)

/** The fixture t2i recipe with its checkpoint slot annotated for a shipped family. */
function familyRecipe(family: string, folder = "checkpoints"): Recipe {
  const r = fixtureRecipe("t2i-basic");
  return Recipe.parse({ ...r, slots: r.slots.map((s) => (s.id === "checkpoint" ? { ...s, modelFamily: family, modelFolder: folder } : s)) });
}

function observation(file: string, outcome: ModelObservation["outcome"], matches: string[], folder = "checkpoints"): ModelObservation {
  return ModelObservation.parse({
    schemaVersion: 1,
    folder,
    file,
    sizeBytes: 1,
    mtimeMs: 1,
    path: `/m/${folder}/${file}`,
    rulesDigest: rulesDigest(SHIPPED),
    outcome,
    ...(outcome === "matched" ? { family: matches[0] } : {}),
    matches,
    reason: outcome === "unreadable" ? "the header isn't JSON" : "test",
    observedAt: T,
  });
}

function familyCheck(recipe: Recipe, bindings: Record<string, string>, obs?: ModelObservation) {
  const families: FamilyEvidence | undefined = obs ? { rules: SHIPPED, observations: new Map([[observationKey(obs.folder, obs.file), obs]]) } : undefined;
  const { report } = validateGraph({ recipe, task: fixtureTask(), bindings, objectInfo: fixtureObjectInfo(), snapshot: fixtureSnapshot(), ...(families ? { families } : {}) });
  const c = report.checks.find((x) => x.id === "semantic_types.model_family.checkpoint");
  if (!c) throw new Error("no family check");
  return { check: c, report };
}

describe("validation's family check", () => {
  const DEFAULT = "sd_xl_base_1.0.safetensors";
  const OTHER = "other/not-in-combo.safetensors";

  it("without an observation stays as before: soft for the default, hard for another file", () => {
    expect(familyCheck(familyRecipe("flux1-schnell"), {}).check).toMatchObject({ verdict: "unknown", hard: false });
    expect(familyCheck(familyRecipe("flux1-schnell"), { checkpoint: OTHER }).check).toMatchObject({ verdict: "unknown", hard: true });
  });

  it("passes when the header matches the slot's family, for the default and for another file", () => {
    expect(familyCheck(familyRecipe("flux1-schnell"), {}, observation(DEFAULT, "matched", ["flux1-schnell"])).check).toMatchObject({ verdict: "pass", hard: true });
    expect(familyCheck(familyRecipe("flux1-schnell"), { checkpoint: OTHER }, observation(OTHER, "matched", ["flux1-schnell"])).check.verdict).toBe("pass");
  });

  it("passes through an alias the recipe uses", () => {
    const r = familyRecipe("z-image-vae", "vae");
    const obs = observation("ae.safetensors", "matched", ["flux-ae"], "vae");
    expect(familyCheck(r, { checkpoint: "ae.safetensors" }, obs).check.verdict).toBe("pass");
  });

  it("fails, hard, naming the family the header matches instead, even for the recipe's default", () => {
    const { check, report } = familyCheck(familyRecipe("flux1-schnell"), {}, observation(DEFAULT, "matched", ["z-image-turbo"]));
    expect(check).toMatchObject({ verdict: "fail", hard: true });
    expect(check.message).toContain("z-image-turbo");
    expect(report.overall).toBe("fail");
  });

  it("fails a file of a known family in a slot whose family has no rule", () => {
    const { check } = familyCheck(familyRecipe("sdxl"), {}, observation(DEFAULT, "matched", ["qwen-3-4b"]));
    expect(check).toMatchObject({ verdict: "fail", hard: true });
  });

  it("stays unknown under Q14 for an unreadable header, no match, or no rule", () => {
    const r = familyRecipe("flux1-schnell");
    expect(familyCheck(r, {}, observation(DEFAULT, "unreadable", [])).check).toMatchObject({ verdict: "unknown", hard: false });
    expect(familyCheck(r, { checkpoint: OTHER }, observation(OTHER, "unreadable", [])).check).toMatchObject({ verdict: "unknown", hard: true });
    expect(familyCheck(r, { checkpoint: OTHER }, observation(OTHER, "no_match", [])).check).toMatchObject({ verdict: "unknown", hard: true });
    expect(familyCheck(familyRecipe("sdxl"), {}, observation(DEFAULT, "no_match", [])).check).toMatchObject({ verdict: "unknown", hard: false });
    const ambiguous = familyCheck(r, {}, observation(DEFAULT, "ambiguous", ["flux1-schnell", "z-image-turbo"])).check;
    expect(ambiguous).toMatchObject({ verdict: "unknown", hard: true });
  });
});

describe("which files planning observes", () => {
  it("names the installed files the candidates would bind, and not the uninstalled ones", () => {
    const recipe = familyRecipe("flux1-schnell");
    const files = boundModelFiles({ task: fixtureTask(), snapshot: fixtureSnapshot(), recipes: [recipe] });
    expect(files).toEqual([{ folder: "checkpoints", file: "sd_xl_base_1.0.safetensors" }]);
    const missing = Recipe.parse({ ...recipe, slots: recipe.slots.map((s) => (s.id === "checkpoint" ? { ...s, default: "absent.safetensors" } : s)) });
    expect(boundModelFiles({ task: fixtureTask(), snapshot: fixtureSnapshot(), recipes: [missing] })).toEqual([]);
  });
});
