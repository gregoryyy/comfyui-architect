// The one facade through which Architect code reaches upstream (spec §5.1, AGENTS).
//
// Architect never imports upstream tool handlers and never calls its own process over MCP
// or HTTP. It depends on this interface, and tests inject a fake. The interface grows only
// with what an Architect feature needs; each method is a thin pass-through, so a change in
// upstream surfaces here as a type error rather than as drift inside the domain code.
//
// Kept free of Architect-specific logic so it can be offered upstream as-is (GAPS Q8).

import { getObjectInfo, getSystemStats } from "../../comfyui/client.js";
import type { ObjectInfo, SystemStats } from "../../comfyui/types.js";
import { getComfyUIBaseUrl } from "../../config.js";

export interface UpstreamFacade {
  /** The base URL of the ComfyUI target upstream is configured for. */
  comfyuiBaseUrl(): string;
  /** ComfyUI's /system_stats. Throws when the target can't be read. */
  systemStats(): Promise<SystemStats>;
  /** ComfyUI's /object_info: every node class the target has loaded. Throws on failure. */
  objectInfo(): Promise<ObjectInfo>;
}

/** The facade over upstream's live services. */
export function createUpstreamFacade(): UpstreamFacade {
  return {
    comfyuiBaseUrl: () => getComfyUIBaseUrl(),
    systemStats: () => getSystemStats({ diagnosticContext: "environment" }),
    objectInfo: () => getObjectInfo(),
  };
}
