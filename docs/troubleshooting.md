# Troubleshooting

English | [繁體中文](troubleshooting.zh-TW.md)

Where to look:

- **`figloo-mcp doctor`**: run it in a terminal (`node apps/mcp/dist/index.js doctor`, or `node figloo-mcp-<version>.mjs doctor` with the release file). Before any agent session is involved, it checks Node.js, the config file and its pairing token, and who holds the port: nobody, a Figloo session (with its version and whether an extension is connected to it), an older Figloo that cannot hand over, or another program. It starts no server and takes the port from no one.
- **`get_status`**: ask the agent to call it. It reports the bridge, the extension connection, and each Figma tab's readiness with the reason, plus a `hint` with the next step. Each tab lists its `limitations`: what Figloo cannot do there, the tools that fail or do less, and what the user can do, as in the table below. When the server turned the extension away, it says why: which side to update, or that the pairing token does not match.
- **Toolbar icon and popup**: the tooltip and the popup show the same readiness and agent connection for the current tab. "Diagnostics" in the popup gives a report for a bug report, without file, page, or layer names.
- **Options page**: shows the connection state, the agent session Figloo serves, the last handover between sessions, and the last connection error.
- **Service worker console**: on `chrome://extensions` (or `arc://extensions`), click "service worker" on the Figloo card.
- **Server log**: the server writes one line per call to stderr, with counts, UI operations, and time, but no layer names. To read it, run the server by hand in a terminal, for example `node apps/mcp/dist/index.js`, while no agent session runs one.

Tab limitations in `get_status`:

| Code | What it means | What to do |
|---|---|---|
| `UI_MINIMIZED` | Figma's UI is minimized, so the layers panel is not rendered. Every tool is affected. | Press Cmd+\ or click the button next to the file name. |
| `GUEST` | Not signed in to Figma, so layers cannot be selected: no selection, properties, exports, or snapshots, and screenshots of the whole page only. | Sign in to Figma in the browser that has the extension. |
| `EDIT_ACCESS` | With edit access Figma shows the Design panel, which Figloo does not read: no properties, snapshots, or exports. Layers and screenshots work. | Figloo targets view access; nothing helps in this file. |
| `UI_CHANGED` | Signed in, yet Figloo cannot find the right sidebar or the properties panel, so Figma may have changed its UI. | Reload the Figma tab; if that does not help, report it with the popup's Diagnostics. |
| `NO_KEYBOARD_TARGET` | Figma's canvas keyboard target is missing, so captures and snapshots cannot zoom. | Reload the Figma tab. |
| `NO_SCREEN_READER_MIRROR` | "Adapt content for screen readers" is off: `get_visual_neighbors` fails, screenshots crop by an estimate, snapshots cannot place most layers, and the view is not put back. | Turn it on under Main menu, Preferences, Accessibility settings. |
| `NOT_ENGLISH` | Figma's UI is in another language, and Figloo reads the panels by their English labels. | Switch Figma to English. |

Tool errors carry a `retry` field: `yes` means the same call can work as it is, perhaps after a moment; `after_user` means once the user did what the hint asks; `no` means the agent should do something else first, such as get a new context.

Common problems:

- `get_status` says `DISCONNECTED`: make sure the extension is loaded and paired, then check the options page. It shows the last connection error, for example a refused token, an unreachable port, or a protocol mismatch with the versions of both sides. `figloo-mcp doctor` tells whether a session holds the port and whether an extension is connected to it.
- The options page says `unpaired`: the token field is empty. Run the `pair` command again and paste the values.
- A tab is `DEGRADED` with "guest session": you are not signed in to Figma in that browser profile, so layers cannot be selected.
- A tab is `DEGRADED` with "Figma UI is minimized": the layers panel is not rendered while the UI is hidden. Press Cmd+\ or click the expand button next to the file name.
- A tab stays `LOADING` or becomes `INCOMPATIBLE` right after installing the extension: reload the Figma tab so the content script is injected.
- `export_asset` returns `EXPORT_BLOCKED`: Figma handed over no file and the browser started no download. If the browser blocked repeated downloads from figma.com, allow them in the site settings and retry.
- `export_asset` returns `LAYER_HIDDEN`: the layer, or a layer it is inside, is hidden in Figma, and Figma exports nothing for it, even from its own Export button.
- `export_asset` returns `EXPORT_PENDING`: the browser is waiting to save the fallback download, usually behind a Save dialog. Confirm it, or turn off asking where to save each file.
- `snapshot_layer` returns `complete: false`: the layer has more than one call can read in three minutes. Call it again with the same root until `complete` is true; `query_snapshot` answers `SNAPSHOT_INCOMPLETE` until then.
- `snapshot_layer` returns `SUBTREE_TOO_LARGE`: the layer holds more than 2,000 layers. Snapshot one of the children the message lists instead.
- `snapshot_layer` fails after 60 seconds in Codex: raise `tool_timeout_sec`, see [Register the MCP server](installation.md#2-register-the-mcp-server-with-your-agent).
- A tool returns `BUSY` and names another session: Figloo is serving that session, which is working or used Figloo in the last 10 seconds. Retry in a moment, or finish the work there first.
- `get_status` or a tool says the port is held by a session running an older Figloo: that session started Figloo 0.1.0, which cannot hand over. Restart that session, or close it.
- A tool says the session holding Figloo did not answer: that session's server is stuck. Close that session.
- With the plugin installed, no Figloo tools show up: the plugin could not download the server bundle for its version. `/plugin` lists the error; check that the GitHub release of that version has the `.mcpb` file and can be reached from your machine.
- The agent sees two sets of Figloo tools: a Figloo server registered by hand runs next to the plugin's. Remove it with `claude mcp remove figloo -s user`.
