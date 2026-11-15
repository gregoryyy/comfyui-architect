// Loaders for the Architect test fixtures: recipes with certification `fixture`, an
// /object_info excerpt shaped like ComfyUI's, a task and a snapshot (TODO 2.4.3).

import { readFileSync } from "node:fs";
import type { ObjectInfo } from "../../../comfyui/types.js";
import { EnvironmentSnapshot, Recipe, TaskSpec, type TaskSpecInput } from "../../../services/architect/schemas.js";

const T = "2026-11-15T12:00:00.000Z";

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));
}

/** A fixture recipe, validated by the `Recipe` schema. */
export function fixtureRecipe(name: "t2i-basic" | "upscale-model"): Recipe {
  return Recipe.parse(readJson(`${name}.recipe.json`));
}

/** A fresh copy of the /object_info fixture, safe to edit per test. */
export function fixtureObjectInfo(): ObjectInfo {
  const parsed: ObjectInfo = JSON.parse(readFileSync(new URL("./object-info.json", import.meta.url), "utf8"));
  return parsed;
}

/** A stored task; `media` and `constraints` can be overridden. */
export function fixtureTask(overrides: Partial<TaskSpecInput> = {}): TaskSpec {
  return TaskSpec.parse({
    schemaVersion: 1,
    id: "task-fixture1",
    revision: 1,
    createdAt: T,
    updatedAt: T,
    intent: "A red bicycle against a white wall.",
    media: { kind: "image", operation: "text_to_image", output: { width: 1024, height: 768 } },
    ...overrides,
  });
}

/** A snapshot of a loopback target whose model listing answered for some folders. */
export function fixtureSnapshot(overrides: Partial<EnvironmentSnapshot> = {}): EnvironmentSnapshot {
  return EnvironmentSnapshot.parse({
    schemaVersion: 1,
    id: "env-fixture1",
    capturedAt: T,
    target: { baseUrl: "http://127.0.0.1:8188" },
    installedModels: {
      folders: {
        checkpoints: ["sd_xl_base_1.0.safetensors", "other/not-in-combo.safetensors"],
        upscale_models: ["4x-UltraSharp.pth"],
        vae: [],
      },
      unanswered: [{ folder: "loras", reason: "HTTP 500 from /models/loras" }],
      absent: ["diffusers"],
    },
    probeErrors: [],
    ...overrides,
  });
}
