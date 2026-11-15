import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENV_MAX_AGE_SECONDS,
  environmentFreshness,
  environmentMaxAgeSeconds,
  planningReadiness,
} from "../../services/architect/environment.js";
import { EnvironmentSnapshot, InstalledModels } from "../../services/architect/schemas.js";
import { installedModelsFromListing } from "../../services/architect/upstream.js";
import type { LocalModel, ModelListingCoverage } from "../../services/model-resolver.js";

/** An entry as upstream's HTTP path writes it: `path` is `<type>/<name>`. */
function http(type: string, name: string): LocalModel {
  return { name, path: `${type}/${name}`, size: 0, modified: "", type };
}

/** An entry as upstream's filesystem fallback writes it: an absolute path. */
function disk(type: string, name: string): LocalModel {
  return { name, path: `/opt/ComfyUI/models/${type}/${name}`, size: 1024, modified: "2026-11-01T00:00:00.000Z", type };
}

function coverage(over: Partial<ModelListingCoverage> = {}): ModelListingCoverage {
  return { answered: [], unanswered: [], absent: [], usedFilesystem: false, ...over };
}

describe("installedModelsFromListing", () => {
  it("maps answered folders to sorted, de-duplicated names and keeps an answered-empty folder", () => {
    const out = installedModelsFromListing({
      models: [
        http("checkpoints", "z.safetensors"),
        http("checkpoints", "a.safetensors"),
        http("checkpoints", "a.safetensors"),
        http("vae", "sdxl_vae.safetensors"),
      ],
      coverage: coverage({ answered: ["checkpoints", "loras", "vae"] }),
    });
    expect(InstalledModels.safeParse(out).success).toBe(true);
    expect(out.folders).toEqual({
      checkpoints: ["a.safetensors", "z.safetensors"],
      loras: [],
      vae: ["sdxl_vae.safetensors"],
    });
    expect(out.unanswered).toEqual([]);
    expect(out.absent).toEqual([]);
  });

  it("keeps unanswered and absent folders out of folders, with their reasons", () => {
    const out = installedModelsFromListing({
      models: [http("checkpoints", "a.safetensors")],
      coverage: coverage({
        answered: ["checkpoints"],
        unanswered: [{ dir: "loras", reason: "HTTP 503" }],
        absent: ["unet", "clip"],
      }),
    });
    expect(out.folders).toEqual({ checkpoints: ["a.safetensors"] });
    expect(out.unanswered).toEqual([{ folder: "loras", reason: "HTTP 503" }]);
    expect(out.absent).toEqual(["clip", "unet"]);
    expect("loras" in out.folders).toBe(false);
  });

  // #796: the filesystem fallback scans this host's disk. Its files are not ComfyUI's
  // answer, so they must neither fill an unanswered folder nor contradict an empty answer.
  it("ignores filesystem-fallback entries", () => {
    const out = installedModelsFromListing({
      models: [disk("checkpoints", "local.safetensors"), disk("loras", "local-lora.safetensors")],
      coverage: coverage({
        answered: ["checkpoints"],
        unanswered: [{ dir: "loras", reason: "HTTP 500" }],
        usedFilesystem: true,
      }),
    });
    expect(out.folders).toEqual({ checkpoints: [] });
    expect(out.unanswered).toEqual([{ folder: "loras", reason: "HTTP 500" }]);
  });

  it("keeps HTTP entries when the listing also used the filesystem", () => {
    const out = installedModelsFromListing({
      models: [http("checkpoints", "served.safetensors"), disk("checkpoints", "local.safetensors")],
      coverage: coverage({ answered: ["checkpoints"], usedFilesystem: true }),
    });
    expect(out.folders).toEqual({ checkpoints: ["served.safetensors"] });
  });

  it("drops entries for a folder that didn't answer", () => {
    const out = installedModelsFromListing({
      models: [http("checkpoints", "a.safetensors"), http("loras", "stray.safetensors")],
      coverage: coverage({ answered: ["checkpoints"], unanswered: [{ dir: "loras", reason: "timeout" }] }),
    });
    expect(out.folders).toEqual({ checkpoints: ["a.safetensors"] });
  });

  it("lets the least certain list win when upstream names a folder twice", () => {
    const out = installedModelsFromListing({
      models: [http("vae", "v.safetensors")],
      coverage: coverage({
        answered: ["vae", "loras", "checkpoints"],
        unanswered: [{ dir: "vae", reason: "HTTP 502" }],
        absent: ["loras"],
      }),
    });
    expect(out.folders).toEqual({ checkpoints: [] });
    expect(out.unanswered).toEqual([{ folder: "vae", reason: "HTTP 502" }]);
    expect(out.absent).toEqual(["loras"]);
  });

  // Upstream's object_info fallback files `unet` entries under `diffusion_models`, so an
  // empty `unet` beside a full `diffusion_models` may be a fold, not an empty folder.
  it("moves an empty legacy folder to unanswered when its current folder has files", () => {
    const out = installedModelsFromListing({
      models: [http("diffusion_models", "flux1-dev.safetensors")],
      coverage: coverage({ answered: ["diffusion_models", "unet", "clip", "text_encoders"] }),
    });
    expect(out.folders).toEqual({ diffusion_models: ["flux1-dev.safetensors"], clip: [], text_encoders: [] });
    expect(out.unanswered.map((u) => u.folder)).toEqual(["unet"]);
    expect(out.unanswered[0]?.reason).toContain("diffusion_models");
  });

  it("keeps a legacy folder that listed its own files", () => {
    const out = installedModelsFromListing({
      models: [http("diffusion_models", "a.safetensors"), http("unet", "b.safetensors")],
      coverage: coverage({ answered: ["diffusion_models", "unet"] }),
    });
    expect(out.folders).toEqual({ diffusion_models: ["a.safetensors"], unet: ["b.safetensors"] });
    expect(out.unanswered).toEqual([]);
  });

  // Upstream de-duplicates a GGUF view's entries against its backing folders, which it
  // lists first, so the view can be missing a .gguf file it served.
  it("moves a GGUF view to unanswered when a backing folder lists a .gguf file", () => {
    const out = installedModelsFromListing({
      models: [http("diffusion_models", "flux-Q4.gguf"), http("unet_gguf", "other-Q8.gguf")],
      coverage: coverage({ answered: ["diffusion_models", "unet_gguf", "clip_gguf"] }),
    });
    expect(out.folders).toEqual({ diffusion_models: ["flux-Q4.gguf"], clip_gguf: [] });
    expect(out.unanswered.map((u) => u.folder)).toEqual(["unet_gguf"]);
  });

  it("keeps a GGUF view when its backing folders hold no .gguf file", () => {
    const out = installedModelsFromListing({
      models: [http("diffusion_models", "flux1-dev.safetensors"), http("unet_gguf", "flux-Q4.gguf")],
      coverage: coverage({ answered: ["diffusion_models", "unet_gguf"] }),
    });
    expect(out.folders.unet_gguf).toEqual(["flux-Q4.gguf"]);
    expect(out.unanswered).toEqual([]);
  });

  it("returns a listing that answered only with absent folders", () => {
    const out = installedModelsFromListing({ models: [], coverage: coverage({ absent: ["unet"] }) });
    expect(out).toEqual({ folders: {}, unanswered: [], absent: ["unet"] });
  });

  // #796: these listings verified nothing; an empty InstalledModels would read as "none".
  it("throws when no folder answered", () => {
    expect(() =>
      installedModelsFromListing({
        models: [],
        coverage: coverage({
          unanswered: [
            { dir: "checkpoints", reason: "connect ECONNREFUSED 127.0.0.1:8188" },
            { dir: "loras", reason: "connect ECONNREFUSED 127.0.0.1:8188" },
          ],
          noSourceAvailable: true,
        }),
      }),
    ).toThrow(/no model folder answered: connect ECONNREFUSED/);
    expect(() =>
      installedModelsFromListing({ models: [], coverage: coverage({ httpUnavailable: "cloud mode" }) }),
    ).toThrow(/cloud mode/);
  });

  it("throws on a listing upstream refused as stale", () => {
    expect(() =>
      installedModelsFromListing({
        models: [],
        coverage: coverage({
          noSourceAvailable: true,
          targetChanged: { startedBaseUrl: "http://a:8188", currentBaseUrl: "http://b:8188" },
        }),
      }),
    ).toThrow(/target changed from http:\/\/a:8188 to http:\/\/b:8188/);
    expect(() =>
      installedModelsFromListing({
        models: [],
        coverage: coverage({ noSourceAvailable: true, localPathRecovered: true }),
      }),
    ).toThrow(/local ComfyUI path/);
  });
});

describe("environmentMaxAgeSeconds", () => {
  it("defaults to 300 seconds", () => {
    expect(DEFAULT_ENV_MAX_AGE_SECONDS).toBe(300);
    expect(environmentMaxAgeSeconds({})).toBe(300);
  });

  it("reads a positive whole number of seconds", () => {
    expect(environmentMaxAgeSeconds({ ARCHITECT_ENV_MAX_AGE_SECONDS: "60" })).toBe(60);
    expect(environmentMaxAgeSeconds({ ARCHITECT_ENV_MAX_AGE_SECONDS: " 900 " })).toBe(900);
  });

  it("falls back to the default for anything else", () => {
    for (const v of ["", "0", "-5", "1.5", "abc", "1e3", "Infinity", "99999999999999999999"]) {
      expect(environmentMaxAgeSeconds({ ARCHITECT_ENV_MAX_AGE_SECONDS: v }), v).toBe(300);
    }
  });
});

const CAPTURED = "2026-11-15T14:00:00.000Z";
const at = (seconds: number): Date => new Date(Date.parse(CAPTURED) + seconds * 1000);

describe("environmentFreshness", () => {
  it("is fresh up to and including the maximum age, stale after it", () => {
    const snap = { capturedAt: CAPTURED };
    expect(environmentFreshness(snap, at(0), 300)).toEqual({ fresh: true, ageSeconds: 0, maxAgeSeconds: 300 });
    expect(environmentFreshness(snap, at(300), 300)).toEqual({ fresh: true, ageSeconds: 300, maxAgeSeconds: 300 });
    expect(environmentFreshness(snap, at(300.001), 300).fresh).toBe(false);
    expect(environmentFreshness(snap, at(301), 300)).toEqual({ fresh: false, ageSeconds: 301, maxAgeSeconds: 300 });
  });

  it("is not fresh when the snapshot is dated after now", () => {
    const f = environmentFreshness({ capturedAt: CAPTURED }, at(-1), 300);
    expect(f).toEqual({ fresh: false, ageSeconds: -1, maxAgeSeconds: 300 });
  });

  it("is not fresh when the capture time can't be read", () => {
    expect(environmentFreshness({ capturedAt: "not a time" }, at(0), 300).fresh).toBe(false);
  });

  it("uses the default for an invalid maximum age", () => {
    for (const bad of [0, -1, Number.NaN, 1.5]) {
      expect(environmentFreshness({ capturedAt: CAPTURED }, at(301), bad).maxAgeSeconds, String(bad)).toBe(300);
    }
  });

  it("reads the maximum age from the environment when none is passed", () => {
    expect(environmentFreshness({ capturedAt: CAPTURED }, at(0)).maxAgeSeconds).toBe(environmentMaxAgeSeconds());
  });
});

const BASE_URL = "http://127.0.0.1:8188";

function snapshot(over: Partial<EnvironmentSnapshot> = {}): EnvironmentSnapshot {
  return EnvironmentSnapshot.parse({
    schemaVersion: 1,
    id: "env-test",
    capturedAt: CAPTURED,
    target: { baseUrl: BASE_URL },
    nodeClassCount: 3,
    nodeSchemaDigest: "abc",
    installedModels: { folders: { checkpoints: [] }, unanswered: [], absent: [] },
    probeErrors: [],
    ...over,
  });
}

describe("planningReadiness", () => {
  it("is usable for a fresh, complete snapshot of the expected target", () => {
    expect(planningReadiness(snapshot(), at(10), BASE_URL, 300)).toEqual({ usable: true, reasons: [] });
    expect(planningReadiness(snapshot(), at(10), `${BASE_URL}/`, 300).usable).toBe(true);
  });

  it("is not usable when stale", () => {
    const r = planningReadiness(snapshot(), at(301), BASE_URL, 300);
    expect(r.usable).toBe(false);
    expect(r.reasons).toEqual(["the snapshot is 301s old, over the 300s maximum"]);
  });

  it("is not usable when dated after now", () => {
    const r = planningReadiness(snapshot(), at(-5), BASE_URL, 300);
    expect(r.reasons).toEqual(["the snapshot is dated 5s after now; its age is unknown"]);
  });

  it("is not usable when object_info failed", () => {
    const snap = snapshot({
      nodeClassCount: undefined,
      nodeSchemaDigest: undefined,
      probeErrors: [{ probe: "object_info", message: "HTTP 500" }],
    });
    const r = planningReadiness(snap, at(10), BASE_URL, 300);
    expect(r.usable).toBe(false);
    expect(r.reasons).toEqual(["installed node classes are unknown: HTTP 500"]);
  });

  it("is not usable when the models probe failed", () => {
    const snap = snapshot({
      installedModels: undefined,
      probeErrors: [{ probe: "models", message: "no model folder answered: timeout" }],
    });
    const r = planningReadiness(snap, at(10), BASE_URL, 300);
    expect(r.usable).toBe(false);
    expect(r.reasons).toEqual(["installed models are unknown: no model folder answered: timeout"]);
  });

  // #796: a field missing without a recorded probe error is still unknown, not present.
  it("is not usable when node classes or models are missing without a probe error", () => {
    const snap = snapshot({ nodeClassCount: undefined, nodeSchemaDigest: undefined, installedModels: undefined });
    const r = planningReadiness(snap, at(10), BASE_URL, 300);
    expect(r.reasons).toEqual([
      "installed node classes are unknown: not in the snapshot",
      "installed models are unknown: not in the snapshot",
    ]);
  });

  it("is not usable for another target", () => {
    const r = planningReadiness(snapshot(), at(10), "http://192.168.1.20:8188", 300);
    expect(r.usable).toBe(false);
    expect(r.reasons).toEqual([`the snapshot describes ${BASE_URL}, not http://192.168.1.20:8188`]);
  });

  it("does not block on system_stats or on unanswered model folders", () => {
    const snap = snapshot({
      installedModels: { folders: {}, unanswered: [{ folder: "loras", reason: "HTTP 500" }], absent: [] },
      probeErrors: [{ probe: "system_stats", message: "HTTP 500" }],
    });
    expect(planningReadiness(snap, at(10), BASE_URL, 300)).toEqual({ usable: true, reasons: [] });
  });

  it("lists every reason at once", () => {
    const snap = snapshot({
      nodeClassCount: undefined,
      nodeSchemaDigest: undefined,
      installedModels: undefined,
      probeErrors: [
        { probe: "object_info", message: "refused" },
        { probe: "models", message: "refused" },
      ],
    });
    expect(planningReadiness(snap, at(600), "http://other:8188", 300).reasons).toHaveLength(4);
  });
});
