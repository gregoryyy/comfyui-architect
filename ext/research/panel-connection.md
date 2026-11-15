# Panel connection: how the stock panel finds and starts a server

How upstream's sidebar panel (`artokun/comfyui-mcp-panel`) connects to a comfyui-mcp server, for GAPS A5, A6 and A9 and TODO 1.2.4 and 1.10. Facts were read from the panel's source at commit `54603d56` (2026-10-24, version 0.15.184) and from the fork's server code at `707474d2`, on 2026-11-15. Nothing was run: the panel isn't installed in either ComfyUI. Status: 2026-11-15 15:23.

## Ports

- The panel's Python side probes the bridge port `COMFYUI_MCP_BRIDGE_PORT`, default 9199, then the legacy port 9180 (`__init__.py:70-73`); the browser side dials the same two in that order (`web/js/lib/bridge-defaults.js:14-41`). The first peer that answers with a protocol frame wins (`__init__.py:787-815`).
- Each browser tab dials one URL. The "Bridge URL (advanced)" setting pins another one (`web/js/comfyui-mcp-panel.js:7414-7420`). No tab talks to two servers.
- A second server that finds the port taken retries, then runs with the panel unavailable (server `src/services/ui-bridge.ts:2348`, `:3126-3135`).

## Starting a server

- `COMFYUI_MCP_NO_AUTOSPAWN` is read nowhere in the panel's code. It survives in the panel's README and in its changelog from the 0.4 versions; upstream's server changelog says it "does not exist" (`CHANGELOG.md:4361`, #1062).
- The panel never starts a process itself (`__init__.py:20-28`). A companion launcher does: the panel reads `~/.comfyui-mcp/launcher.json` (protocol 1) and asks the launcher to ensure a server runs (`__init__.py:140-166`, `:361-366`).
- The launcher's command is fixed in the server code: `npx -y comfyui-mcp@latest connect` (`src/services/panel-launcher.ts:1190-1243`). It always fetches upstream's latest package from npm.
- The switch that matters is the browser setting `comfyui-mcp.autostartMcp`, default on (`comfyui-mcp-panel.js:6207`, `:7162-7169`). With it off, Connect only dials a server the user started. With it on, the panel still connects first to a live bridge it finds (`:44158-44178`).
- The panel has no setting for another server command or path.

## Versions

- The panel accepts the first protocol frame with no version comparison (`comfyui-mcp-panel.js:30459-30475`). It names the server only as `comfyui-mcp@latest`, unpinned.
- The gate runs the other way: the server reads the panel's `PANEL_VERSION` and refuses commands below capability floors (`BRIDGE_CAPABILITY_MIN_PANEL_VERSION`, server `src/services/ui-bridge.ts:468`, `:519`). The fork inherits upstream's floors.

## Consequences

- **The development setup:** start the fork's server first, then connect with the panel's "Autostart MCP" setting off. With the setting on, a live fork on 9199 is still found first, but if none runs, the launcher starts upstream's latest package from npm.
- **For the rename (GAPS Q11):** while the launcher's command names `comfyui-mcp@latest`, the panel can only ever launch upstream. Launching the fork from the panel needs the launcher's command changed in the fork, and a fork launcher next to upstream's would compete for the single `launcher.json`. This hasn't been checked.
- **Version floors:** the fork must not raise upstream's panel floors without a panel to match, or the stock panel gets refused.
- **Not determined:** whether two launchers can coexist, and how the server behaves after giving up on the bind.
