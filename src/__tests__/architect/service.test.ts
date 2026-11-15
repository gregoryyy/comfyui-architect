import { describe, expect, it } from "vitest";
import { architectEnabled } from "../../services/architect/config.js";
import { EnvironmentSnapshot, type InstalledModels, ResultEnvelope } from "../../services/architect/schemas.js";
import { ArchitectService, nodeSchemaDigest } from "../../services/architect/service.js";
import type { UpstreamFacade } from "../../services/architect/upstream.js";
import type { ComfyUINodeDef, ObjectInfo, SystemStats } from "../../comfyui/types.js";

const STATS: SystemStats = {
  system: {
    os: "darwin",
    python_version: "3.12.7",
    embedded_python: false,
    comfyui_version: "0.4.0",
    ram_total: 48 * 2 ** 30,
    ram_free: 20 * 2 ** 30,
  },
  devices: [
    {
      name: "mps",
      type: "mps",
      index: 0,
      vram_total: 48 * 2 ** 30,
      vram_free: 20 * 2 ** 30,
      torch_vram_total: 0,
      torch_vram_free: 0,
    },
  ],
};

function nodeDef(name: string): ComfyUINodeDef {
  return {
    input: {},
    output: [],
    output_is_list: [],
    output_name: [],
    name,
    display_name: name,
    description: "",
    category: "test",
    output_node: false,
  };
}

const OBJECT_INFO: ObjectInfo = Object.fromEntries(
  ["KSampler", "CheckpointLoaderSimple", "SaveImage"].map((n) => [n, nodeDef(n)]),
);

const MODELS: InstalledModels = {
  folders: {
    checkpoints: ["sd_xl_base_1.0.safetensors", "v1-5-pruned-emaonly.safetensors"],
    loras: [],
    vae: ["sdxl_vae.safetensors"],
  },
  unanswered: [],
  absent: ["clip", "unet"],
};

function facade(overrides: Partial<UpstreamFacade> = {}): UpstreamFacade {
  return {
    comfyuiBaseUrl: () => "http://127.0.0.1:8188",
    systemStats: async () => STATS,
    objectInfo: async () => OBJECT_INFO,
    isPaidNode: () => false,
    installedModels: async () => MODELS,
    ...overrides,
  };
}

function service(up: UpstreamFacade): ArchitectService {
  return new ArchitectService({
    upstream: up,
    now: () => new Date("2026-11-15T14:00:00.000Z"),
    newId: () => "op-test",
  });
}

const refused = async (): Promise<never> => {
  throw new Error("connect ECONNREFUSED 127.0.0.1:8188");
};

describe("architectEnabled", () => {
  it("is off when the variable is absent or not an on value", () => {
    expect(architectEnabled({})).toBe(false);
    for (const v of ["", "0", "false", "off", "no", "maybe"]) {
      expect(architectEnabled({ COMFYUI_ARCHITECT: v }), v).toBe(false);
    }
  });

  it("is on for 1, true, yes and on, in any case and with surrounding spaces", () => {
    for (const v of ["1", "true", "TRUE", " yes ", "On"]) {
      expect(architectEnabled({ COMFYUI_ARCHITECT: v }), v).toBe(true);
    }
  });
});

describe("ArchitectService.inspectEnvironment", () => {
  it("maps system stats and node classes into a schema-valid snapshot", async () => {
    const snap = await service(facade()).inspectEnvironment();
    expect(EnvironmentSnapshot.safeParse(snap).success).toBe(true);
    expect(snap).toMatchObject({
      capturedAt: "2026-11-15T14:00:00.000Z",
      target: { baseUrl: "http://127.0.0.1:8188" },
      comfyuiVersion: "0.4.0",
      os: "darwin",
      nodeClassCount: 3,
      probeErrors: [],
    });
    expect(snap.devices).toEqual([{ name: "mps", type: "mps", memoryTotal: 48 * 2 ** 30, memoryFree: 20 * 2 ** 30 }]);
    expect(snap.installedModels).toEqual(MODELS);
  });

  it("digests node class names independently of their order", () => {
    expect(nodeSchemaDigest(["b", "a", "c"])).toBe(nodeSchemaDigest(["c", "b", "a"]));
    expect(nodeSchemaDigest(["a"])).not.toBe(nodeSchemaDigest(["a", "b"]));
  });

  // #796: a probe that fails must leave its fields absent and say so. Reporting zero
  // devices or zero node classes would tell the planner a negative was observed.
  it("records a failed probe as unknown, not as empty", async () => {
    const snap = await service(facade({ systemStats: refused })).inspectEnvironment();
    expect(snap.probeErrors).toEqual([{ probe: "system_stats", message: "connect ECONNREFUSED 127.0.0.1:8188" }]);
    expect(snap.devices).toBeUndefined();
    expect(snap.ramTotal).toBeUndefined();
    expect(snap.comfyuiVersion).toBeUndefined();
    expect(snap.nodeClassCount).toBe(3);
  });

  it("never reports zero node classes when object_info fails", async () => {
    const snap = await service(facade({ objectInfo: refused })).inspectEnvironment();
    expect(snap.nodeClassCount).toBeUndefined();
    expect(snap.nodeSchemaDigest).toBeUndefined();
    expect(snap.probeErrors.map((e) => e.probe)).toEqual(["object_info"]);
  });

  it("leaves installedModels absent when the models probe fails, never an empty listing", async () => {
    const snap = await service(facade({ installedModels: refused })).inspectEnvironment();
    expect(snap.installedModels).toBeUndefined();
    expect(snap.probeErrors).toEqual([{ probe: "models", message: "connect ECONNREFUSED 127.0.0.1:8188" }]);
    expect(snap.nodeClassCount).toBe(3);
    expect(snap.devices).toHaveLength(1);
  });
});

describe("ArchitectService.inspectEnvironmentEnvelope", () => {
  it("returns ok with a summary when every probe answers", async () => {
    const env = await service(facade()).inspectEnvironmentEnvelope();
    expect(ResultEnvelope.safeParse(env).success).toBe(true);
    expect(env.status).toBe("ok");
    expect(env.operationId).toBe("op-test");
    expect(env.summary).toContain("3 node classes");
    expect(env.summary).toContain("3 model file(s) in 3 answered folder(s)");
    expect(env.warnings).toEqual([]);
    expect(env.error).toBeUndefined();
  });

  it("returns partial when only the models probe fails, with the field absent and a warning", async () => {
    const env = await service(facade({ installedModels: refused })).inspectEnvironmentEnvelope();
    expect(env.status).toBe("partial");
    expect(env.error).toBeUndefined();
    expect(env.warnings).toEqual(["models: connect ECONNREFUSED 127.0.0.1:8188"]);
    expect(env.summary).toContain("models could not be read");
    expect(env.summary).not.toContain("model file(s)");
    const snap = EnvironmentSnapshot.parse(env.data.environment);
    expect(snap.installedModels).toBeUndefined();
  });

  it("returns partial with a warning per unanswered folder, even when every probe answered", async () => {
    const models: InstalledModels = {
      folders: { checkpoints: ["a.safetensors"] },
      unanswered: [
        { folder: "loras", reason: "HTTP 500" },
        { folder: "vae", reason: "ComfyUI returned HTML instead of JSON" },
      ],
      absent: [],
    };
    const env = await service(facade({ installedModels: async () => models })).inspectEnvironmentEnvelope();
    expect(env.status).toBe("partial");
    expect(env.error).toBeUndefined();
    expect(env.warnings).toEqual(["models/loras: HTTP 500", "models/vae: ComfyUI returned HTML instead of JSON"]);
    expect(env.summary).toContain("2 model folder(s) did not answer");
    expect(env.summary).toContain("unknown, not empty");
  });

  // Absent folders are a definite answer (#1015): they must not degrade a complete listing.
  it("stays ok when folders are absent but none is unanswered", async () => {
    const env = await service(facade()).inspectEnvironmentEnvelope();
    expect(MODELS.absent.length).toBeGreaterThan(0);
    expect(env.status).toBe("ok");
  });

  it("returns partial with warnings when one probe fails", async () => {
    const env = await service(facade({ objectInfo: refused })).inspectEnvironmentEnvelope();
    expect(env.status).toBe("partial");
    expect(env.warnings).toEqual(["object_info: connect ECONNREFUSED 127.0.0.1:8188"]);
    expect(env.summary).toContain("unknown, not empty");
  });

  it("stays partial, not error, while any one probe answers", async () => {
    const env = await service(facade({ systemStats: refused, objectInfo: refused })).inspectEnvironmentEnvelope();
    expect(env.status).toBe("partial");
    expect(env.error).toBeUndefined();
    expect(env.summary).toContain("system_stats, object_info could not be read");
    expect(env.summary).toContain("model file(s)");
  });

  it("returns error with a stable, retryable code when the target can't be read at all", async () => {
    const env = await service(
      facade({ systemStats: refused, objectInfo: refused, installedModels: refused }),
    ).inspectEnvironmentEnvelope();
    expect(env.status).toBe("error");
    expect(env.warnings).toHaveLength(3);
    expect(EnvironmentSnapshot.parse(env.data.environment).installedModels).toBeUndefined();
    expect(env.error).toMatchObject({ code: "STALE_ENVIRONMENT", retryable: true });
    expect(env.summary).toContain("No snapshot");
    expect(env.summary).not.toContain("Partial");
  });
});
