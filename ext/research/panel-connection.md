# Panel connection: how the stock panel finds and starts a server

How upstream's sidebar panel (`artokun/comfyui-mcp-panel`) connects to a comfyui-mcp server, for GAPS A5, A6 and A9 and TODO 1.2.4 and 1.10. Facts were read from the panel's source at commit `54603d56` (2026-10-24, version 0.15.184) and from the fork's server code at `707474d2`, on 2026-11-15. The section on observed behaviour comes from runs on 2026-11-15 with the panel linked into the reference install (ComfyUI 0.44.2 on port 8190); everything else is read from the code. Status: 2026-11-15 17:05.

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

## Observed with the panel installed

Runs on 2026-11-15: the panel (linked into `~/Documents/opt/flux/ComfyUI/custom_nodes/`), the reference ComfyUI on port 8190, and `node dist/index.js connect http://127.0.0.1:8190` from the fork and, for comparison, from a pristine `707474d2` build. Probe scripts spoke the panel's bridge protocol over WebSocket.

- **Status routes:** with no server, `/comfyui_mcp_panel/status` reports `running: false` and offers `npx -y comfyui-mcp@latest connect`. With the fork's server up, it reports `running: true`, but not every time: `/status`, `/connect` and `/backends` flip between "running" and "port held by another process" from one call to the next.
- **Why they flip:** the panel's probe gives the server 1.2 s to answer a `hello` (`__init__.py:622`). About half of all hellos get no answer within 5 s: 5 of 10 on the fork, 6 of 10 on `707474d2`, whether the tab id is new or repeated. Answered hellos take 4–43 ms. This is upstream's behaviour at the baseline, recorded in [BASE](../input/BASE.md#baseline-facts-for-the-fork); its cause wasn't investigated.
- **Two servers:** a second server finds 9199 taken, retries five times over about 6 s, logs "could not bind port 9199 after 5 attempts … The panel bridge is NOT listening" and keeps running without the panel. The first server is untouched (GAPS A5).
- **Identity on the panel route:** after a `hello`, the server sends `session_epoch`, `backends`, `workflow_target`, `download_progress`, `queue_status`, `runpod_status`, `comfyui_target`, `models`, `commands`, `say` and `ack`. None carries a server name or version; the `say` greeting reads "🟢 comfyui-mcp agent ready — opus on your Claude subscription. Ask away." So the stock panel can't tell the fork from upstream (spec §3.2, point 2). With the flag on, the fork now appends "ComfyUI Architect 0.1.0 (fork of comfyui-mcp 0.52.206 @707474d2): Architect tools on." to that greeting (TODO 1.12); with it off, the greeting is upstream's.
- **The panel agent's tools:** the orchestrator builds the environment of the agent's comfyui tool server from an allowlist (`buildComfyuiMcpEnv` in `src/services/panel-secrets.ts`), so before TODO 1.12 `COMFYUI_ARCHITECT` never reached it and the panel's agent had no `architect_*` tools. The fork now forwards it next to upstream's tool-policy variables. Checked by a unit test; a live agent turn wasn't run, since it spends the subscription.
- **The direct `call_tool` channel** the panel and the mobile client use refuses `architect_inspect` ("tool \"architect_inspect\" is not permitted"): it admits a fixed list of read-only tools (`src/orchestrator/call-tool-admission.ts`). Nothing changed there.
- **Cosmetic:** the terminal banner of `connect` still says "ComfyUI MCP", and the log line "Found ComfyUI on port 8188" comes from auto-detection before the given URL takes over.
- **Not tested:** the browser side (the Agent tab, its "Autostart MCP" setting and the Connect button); that needs someone at the browser.

## Consequences

- **The development setup:** start the fork's server first, then connect with the panel's "Autostart MCP" setting off. With the setting on, a live fork on 9199 is still found first, but if none runs, the launcher starts upstream's latest package from npm.
- **For the rename (GAPS Q11):** while the launcher's command names `comfyui-mcp@latest`, the panel can only ever launch upstream. Launching the fork from the panel needs the launcher's command changed in the fork, and a fork launcher next to upstream's would compete for the single `launcher.json`. This hasn't been checked.
- **Version floors:** the fork must not raise upstream's panel floors without a panel to match, or the stock panel gets refused.
- **Not determined:** whether two launchers can coexist.
