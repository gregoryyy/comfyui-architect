// The built-in entries of the source registry (spec §8.5; GAPS Q32; ARCH 2026-11-16,
// sources; TODO 5.2).
//
// Three sources ship with Architect and are written at startup: `huggingface`, from which
// recipe-pinned files are downloaded (GAPS Q25); `comfyui-templates`, the template index the
// target ComfyUI serves; and `upstream-packs`, the packs upstream ships in the repository.
// This file only registers them. Listing and importing templates is the adapters' work
// (TODO 5.2, part B), which records each refresh's outcome with `recordSourceRefresh`.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceRegistryEntry } from "./schemas.js";
import type { ArchitectStore, SourceDefinition } from "./store.js";

/** The ids of the built-in sources. */
export const HUGGINGFACE_SOURCE_ID = "huggingface";
export const COMFYUI_TEMPLATES_SOURCE_ID = "comfyui-templates";
export const UPSTREAM_PACKS_SOURCE_ID = "upstream-packs";

/**
 * `packs/` at the package root, resolved as upstream's `list_packs` resolves it
 * (src/tools/skills-access.ts `packsDir`: the package root next to dist/): three levels up
 * from src/services/architect/ and from dist/services/architect/.
 */
export const UPSTREAM_PACKS_DIR = resolve(fileURLToPath(new URL("../../../packs/", import.meta.url)));

/** The template index of a ComfyUI at `baseUrl`. */
export function templateIndexUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/templates/index.json`;
}

/** The built-in source definitions for the configured target. */
export function builtInSources(baseUrl: string): SourceDefinition[] {
  return [
    {
      id: HUGGINGFACE_SOURCE_ID,
      adapter: "huggingface_pinned",
      root: "https://huggingface.co",
      allowedOps: ["download"],
      trust: "approved",
      refreshPolicy: { kind: "pinned" },
      builtIn: true,
    },
    {
      id: COMFYUI_TEMPLATES_SOURCE_ID,
      adapter: "comfyui_template_index",
      root: templateIndexUrl(baseUrl),
      allowedOps: ["list", "import"],
      trust: "vendor",
      refreshPolicy: { kind: "on_demand" },
      builtIn: true,
    },
    {
      id: UPSTREAM_PACKS_SOURCE_ID,
      adapter: "upstream_packs",
      root: UPSTREAM_PACKS_DIR,
      allowedOps: ["list", "import"],
      trust: "upstream",
      refreshPolicy: { kind: "on_demand" },
      builtIn: true,
    },
  ];
}

/**
 * Write the built-in sources, keeping each one's refresh state while its root stays the
 * same. The templates root follows the configured target, so a server pointed at another
 * ComfyUI starts that source over as unrefreshed. A definition the registry refuses (a
 * target URL that isn't http or https) is returned as an error, not dropped silently.
 */
export function ensureBuiltInSources(
  store: Pick<ArchitectStore, "ensureSource">,
  baseUrl: string,
): { sources: SourceRegistryEntry[]; errors: { id: string; message: string }[] } {
  const sources: SourceRegistryEntry[] = [];
  const errors: { id: string; message: string }[] = [];
  for (const def of builtInSources(baseUrl)) {
    try {
      sources.push(store.ensureSource(def));
    } catch (err) {
      errors.push({ id: def.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { sources, errors };
}

/** What `architect_inspect capabilities` shows of a source. */
export function sourceView(s: SourceRegistryEntry) {
  return {
    id: s.id,
    adapter: s.adapter,
    root: s.root,
    allowedOps: s.allowedOps,
    trust: s.trust,
    refreshPolicy: s.refreshPolicy.kind,
    state: s.state,
    ...(s.lastRefreshAt ? { lastRefreshAt: s.lastRefreshAt } : {}),
    ...(s.lastAttemptAt ? { lastAttemptAt: s.lastAttemptAt } : {}),
    ...(s.unavailableReason ? { unavailableReason: s.unavailableReason } : {}),
  };
}
