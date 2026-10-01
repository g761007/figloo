# Figloo

English | [繁體中文](README.zh-TW.md)

Figloo is a Chrome extension plus a local MCP server that lets a coding agent detect an open Figma design tab, use the user's current selection as an anchor, and explore nearby layers and their properties through the Figma web UI, without scanning the whole document. It only reads what the DOM and web UI expose: no Figma REST API, official Figma MCP, Figma plugin, or private internal state. It may change the view and selection, but it never edits the design.

## Status

The MVP (milestones M0 to M4 of the [plan](docs/plans/2026-09-30-figloo-mvp-plan.md)) is complete. An agent can list the pages of a Figma file, open a page or start from the user's selection, walk the layer tree one bounded page at a time, read what Figma's inspection panel shows, take screenshots, and export icons and images. To implement a page, `snapshot_layer` reads every layer of it at once, with a screenshot, and saves the result so that `query_snapshot` can look layers up without touching Figma again. Figloo targets engineers with view access to a file; it never edits the design.

- [docs/mcp-tools.md](docs/mcp-tools.md): every tool's parameters, results, and error codes.
- [docs/compatibility/](docs/compatibility/README.md): supported browsers and Figma settings, known limitations, and what was verified on real Figma pages.

## Requirements

- Node.js 24 to run the MCP server (see `.node-version`)
- pnpm 10 to build from source (see `packageManager` in `package.json`)
- A Chromium-based browser that loads unpacked extensions: Arc is verified, and Chrome 116 or newer is expected to work
- A Figma account with at least view access to the file, using Figma's English UI

## Install

### From release files

`pnpm package` builds two files into `release/` that can be handed to someone else:

| File | What to do with it |
|---|---|
| `figloo-extension-<version>.zip` | Unzip it into a folder you keep; the browser loads the extension from there. |
| `figloo-mcp-<version>.mjs` | Keep it anywhere; it is the whole MCP server and needs only Node.js 24. |

Then follow [Set up](#set-up), using the unzipped folder and the `.mjs` file in place of the paths from a checkout.

### From source

```sh
pnpm install
pnpm build
```

`pnpm build` runs the workspace packages in dependency order; run it before `typecheck` and `test`, because both other packages consume the built output of `@figloo/protocol`. pnpm may warn that it ignored esbuild's build script; the build does not need it.

## Set up

### 1. Load the extension

1. Open `chrome://extensions` (or `arc://extensions`), turn on the Developer mode toggle, and click "Load unpacked".
2. Select `apps/extension/dist`, or the folder you unzipped the release file into.

The extension ID is pinned by the `key` field in `apps/extension/static/manifest.json`, so it is the same on every machine (`offikfnknfkgijgianpfcghbccmkcjnb`). The local server only accepts connections from that ID.

The extension asks for access to all sites (`<all_urls>`) because Chrome only lets an extension screenshot a tab without a click on its icon when it has that permission. Its content script still runs only on Figma design files.

`export_asset` receives Figma's exported file inside the page: for the length of one export, the extension wraps the functions Figma uses to start a download, takes the file, and puts the originals back, so the browser saves nothing. The `downloads` permission is only for the fallback: when the file cannot be taken in the page, the extension watches for the browser's own download of that export and reports where it was saved.

After updating Figloo, run `pnpm build` and click the reload button on the extension's card, so the browser loads the new files and any new permission.

### 2. Register the MCP server with your agent

For Claude Code, register it once for all your projects, then start a new session:

```sh
claude mcp add -s user figloo -- node /absolute/path/to/figloo/apps/mcp/dist/index.js
```

With the release file, use its path instead, for example `node /absolute/path/to/figloo-mcp-0.0.1.mjs`. In a session, `/mcp` shows whether the server connected.

For other MCP clients, a configuration like this starts the server (replace the path):

```json
{
  "mcpServers": {
    "figloo": {
      "command": "node",
      "args": ["/absolute/path/to/figloo/apps/mcp/dist/index.js"]
    }
  }
}
```

`snapshot_layer` can take up to three minutes. Claude Code waits long enough by default; if you set `MCP_TOOL_TIMEOUT` or `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, keep them above 200000 milliseconds. Codex stops a tool call after 60 seconds by default, so raise `tool_timeout_sec` for Figloo in `~/.codex/config.toml`:

```toml
[mcp_servers.figloo]
command = "node"
args = ["/absolute/path/to/figloo/apps/mcp/dist/index.js"]
tool_timeout_sec = 300
```

The server speaks MCP over stdio and, in the same process, listens on `ws://127.0.0.1:47129` for the extension. Set `FIGLOO_PORT` or edit `port` in the config file to change the port. If the port is taken, `get_status` reports the error instead of the server crashing.

### 3. Pair once

```sh
node apps/mcp/dist/index.js pair
```

With the release file, run `node figloo-mcp-<version>.mjs pair`.

This prints the pairing token and port stored in `~/.figloo/config.json` (created on first run, mode 0600; override the directory with `FIGLOO_CONFIG_DIR`). Open the extension's options page, paste both values, and click "Save and connect". From then on the extension connects automatically whenever the MCP server is running, and reconnects after either side restarts.

### 4. Prepare Figma

- Sign in to Figma in the browser that has the extension. View access to the file is enough.
- Use Figma's English UI, and keep the UI expanded: Cmd+\ toggles it, and a minimized UI hides the layers panel.
- Turn on "Adapt content for screen readers" under Main menu, Preferences, Accessibility settings. Screenshots then crop to the layer's position on screen, and `get_visual_neighbors` can tell where layers are.
- Keep the Figma tab on screen while the agent works; next to the agent's window is enough. Figma ignores selection and expansion in background tabs, so Figloo reports `TAB_IN_BACKGROUND` instead of guessing.

## Toolbar icon

The icon shows, for the tab you are looking at, whether Figloo can use it. Hover over it for the reason and for whether a coding agent is connected.

| Icon | Meaning |
|---|---|
| Colorful | A Figma design file Figloo can read. |
| Colorful with an amber `!` | A design file Figloo can read with a limitation, such as a guest session or a minimized UI. |
| Gray | Not a Figma design file, or the file is still loading. |
| Gray with a red `!` | A Figma design page Figloo cannot read. |

Click the icon to open the popup. It shows the file, the page, and whether Figloo and the coding agent are ready. When one layer is selected in Figma, it also shows the layer's path from the page and its direct children. Reading the children can briefly expand that layer in the layers panel; Figloo collapses it again.

"Copy prompt for the agent" copies text to paste into your coding agent before you describe the task. It names the file, the tab, and the selected layer, and tells the agent which Figloo tools to start with. When the selected layer is a frame on the canvas or in a section, such as a screen, the prompt says you want to implement that page and asks the agent for a snapshot of it first. Without a selection, the prompt asks the agent to explore the file on its own. The popup shows the prompt before you copy it.

The artwork lives in `apps/extension/scripts/render-icons.mjs`. After changing it, regenerate the committed PNGs:

```sh
pnpm --filter @figloo/extension icons
```

## Tools

| Tool | Description |
|---|---|
| `get_status` | Reports the bridge state, whether the extension is connected, and every open Figma design tab with its readiness (`LOADING`, `READY`, `DEGRADED`, `INCOMPATIBLE`), access level (`edit`, `view`, `guest`, `unknown`), UI locale, whether the tab is visible, and which UI surfaces the content script found. Includes a `hint` when something needs attention. |
| `list_pages` | Lists the pages of the Figma file in a tab and which one is shown. |
| `explore_page` | Opens a page (switching if needed) and lists the layers directly on it, with a `contextId`. |
| `get_anchor` | Returns the layers the user selected in a tab, up to 20 in layers panel order, plus a `contextId`. |
| `get_neighbors` | Lists the `parent`, `ancestors`, `siblings`, or `children` of a layer returned in the same context. Pages hold at most 50 layers (20 by default); follow `nextCursor` for more. `children` also takes `depth` (up to 3) for a breadth-first subtree. |
| `get_visual_neighbors` | Lists the siblings of a layer by where they are on screen: to its right, left, below, or above, or nearest first, with the gap and offset in design pixels. Frames, groups, shapes, and instances are measured on screen; text layers come from the inspection panel. Needs "Adapt content for screen readers". |
| `inspect_nodes` | Reads Figma's inspection panel for up to 5 layers: size and sizing mode, position, auto layout flow, padding, gap, corner radius, fills, borders, shadows, text content, typography per style run, and component properties. Values are exactly as Figma shows them. |
| `capture` | Screenshots a layer, zoomed to fit, or the whole page. Returns a JPEG of at most 1568 px on its long edge. |
| `export_asset` | Exports a layer the way Figma's Export button does, as SVG, PNG, JPG, or PDF, so the agent can pick the format and scale the project needs, for example SVG for web or PDF and PNG at 1x, 2x, and 3x for iOS. Returns SVG markup inline and PNG or JPG of at most 1568 px as an image. With `saveTo`, also writes the files to that path inside the project directory (`CLAUDE_PROJECT_DIR`, which Claude Code sets, or else the server's working directory); existing files are only replaced with `overwrite: true`. Figma names files after the layer without a scale suffix, so save each scale under its own file name. Without `format`, the layer's own export settings are used when it has some, and a layer without settings exports as SVG. With `format`, a temporary setting in that format and `scale` (1x by default) is added and removed again, unless the layer already has that exact setting. The layer's own settings are never changed. ZIP archives Figma packs several files into are opened. |
| `snapshot_layer` | Reads a layer and everything inside it, up to 400 layers, in one call of about 40 seconds for 300 layers and at most three minutes: a screenshot, and for each layer its place and size relative to the layer, whether it is hidden, its export settings, and everything `inspect_nodes` shows. Instances count as one layer. Returns the screenshot and an outline with one line per layer, and saves the snapshot under `~/.figloo/snapshots/`. A saved snapshot is returned without reading Figma again for 24 hours (`snapshotTtlHours` in the config file); `refresh: true` reads it again. Meanwhile the user cannot use Figma; a click in Figma stops it. |
| `query_snapshot` | Looks layers up in a saved snapshot without the Figma tab, even after the page reloads: by ref, in full, or by text, type, and the layer they are inside, as outline lines or in full, a page at a time. |
| `release_context` | Forgets a context and its layer refs. |

The full contract, with every parameter, result field, and error code, is in [docs/mcp-tools.md](docs/mcp-tools.md).

A typical request goes: `get_status`, then `list_pages` and `explore_page` (or `get_anchor` when the user selected something), `capture` to see a page or frame, `get_neighbors` to find the parts that matter, `inspect_nodes` for their exact values, and `export_asset` for icons and images. Each call is bounded and reports how many UI operations it used. To implement a whole page, call `snapshot_layer` on its frame instead, then `query_snapshot` for the details.

Figma applies selection, expansion, zoom, and page changes only while its tab is visible. Reading pages, the selection, and already expanded layers works from a background tab; `get_visual_neighbors`, `inspect_nodes`, `capture`, `export_asset`, `snapshot_layer`, page switches, and expanding collapsed layers return `TAB_IN_BACKGROUND` until the Figma tab is on screen. Keeping Figma beside the agent window is enough. These tools select layers one after another, and `capture` zooms the view; the user's selection, including several selected layers, is put back afterwards, the zoom is not.

## Development

```sh
pnpm build             # pnpm -r build
pnpm typecheck         # pnpm -r typecheck
pnpm test              # pnpm -r test (vitest in every package)
pnpm test:integration  # real Chromium + real MCP process + real Figma tabs, see below
pnpm package           # build, then write the release files into release/
pnpm test:release      # the status integration test, run against the files in release/
pnpm --filter @figloo/mcp docs:tools   # regenerate docs/mcp-tools.md after changing a tool
```

`pnpm test` fails when `docs/mcp-tools.md` no longer matches the tools the server registers.

The integration test (`tests/integration/get-status.e2e.mjs`) launches Playwright's Chromium with the built extension, pairs it through the options page, opens a Figma file as a guest, and checks `get_status` before and after restarting the MCP process. It needs network access, a built workspace, the browser download, and a Figma design file that anyone with the link can view. The link is not committed: copy the example file to `tests/integration/.env.local`, which git ignores, and fill it in, or set `FIGLOO_E2E_FIGMA_URL` instead:

```sh
pnpm exec playwright install chromium
cp tests/integration/.env.example tests/integration/.env.local
```

Branded Google Chrome 137 and newer ignore `--load-extension`, which is why the test does not use the installed Chrome. A second script, `tests/integration/explore.e2e.mjs`, injects the layer navigation code into a visible guest Figma tab and checks expanding, listing, paging, climbing past same-named layers, and restoring the panel, so the file needs two same-named sibling layers with children. Set `FIGLOO_E2E_HEADED=1` to watch them.

The core-scenario acceptance run needs a signed-in browser, so it is not part of `pnpm test`. With the extension paired, the Figma tab on screen, no other Figloo server running, and one layer inside a card selected, it runs the whole flow ten times and checks that every run returns the same result:

```sh
node tests/acceptance/core-scenario.mjs
```

`FIGLOO_ACCEPT_RUNS` changes the number of runs, and `FIGLOO_ACCEPT_MCP_ENTRY=release/figloo-mcp-<version>.mjs` runs it against the release file.

## Repository layout

```text
apps/extension/      Chrome extension (Manifest V3): @figloo/extension
apps/mcp/            Local MCP server over stdio plus the WebSocket bridge: @figloo/mcp
packages/protocol/   Shared zod schemas, types, and constants: @figloo/protocol
docs/plans/          Planning documents
docs/compatibility/  What was verified on real Figma pages, and known limits
scripts/             Release packaging and the release check
tests/fixtures/      Captured Figma markup and export files for regression tests
tests/integration/   End-to-end tests against real Chromium and Figma
tests/acceptance/    Core-scenario acceptance run for a signed-in browser
release/             Output of pnpm package (not committed)
```

## Troubleshooting

Where to look:

- **`get_status`**: ask the agent to call it. It reports the bridge, the extension connection, and each Figma tab's readiness with the reason, plus a `hint` with the next step.
- **Toolbar icon and popup**: the tooltip and the popup show the same readiness and agent connection for the current tab.
- **Options page**: shows the connection state and the last connection error.
- **Service worker console**: on `chrome://extensions` (or `arc://extensions`), click "service worker" on the Figloo card.
- **Server log**: the server writes one line per call to stderr, with counts, UI operations, and time, but no layer names. To read it, run the server by hand in a terminal, for example `node apps/mcp/dist/index.js`, while no agent session runs one.

Common problems:

- `get_status` says `DISCONNECTED`: make sure the extension is loaded and paired, then check the options page. It shows the last connection error, for example a refused token or an unreachable port.
- The options page says `unpaired`: the token field is empty. Run the `pair` command again and paste the values.
- A tab is `DEGRADED` with "guest session": you are not signed in to Figma in that browser profile, so layers cannot be selected.
- A tab is `DEGRADED` with "Figma UI is minimized": the layers panel is not rendered while the UI is hidden. Press Cmd+\ or click the expand button next to the file name.
- A tab stays `LOADING` or becomes `INCOMPATIBLE` right after installing the extension: reload the Figma tab so the content script is injected.
- `export_asset` returns `EXPORT_BLOCKED`: Figma handed over no file and the browser started no download. If the browser blocked repeated downloads from figma.com, allow them in the site settings and retry.
- `export_asset` returns `EXPORT_PENDING`: the browser is waiting to save the fallback download, usually behind a Save dialog. Confirm it, or turn off asking where to save each file.
- `snapshot_layer` returns `SUBTREE_TOO_LARGE`: the layer holds more than 400 layers. Snapshot one of the children the message lists instead.
- `snapshot_layer` fails after 60 seconds in Codex: raise `tool_timeout_sec`, see [Register the MCP server](#2-register-the-mcp-server-with-your-agent).
- `get_status` reports that port 47129 is already in use: another agent session already runs Figloo, and only one server can serve the extension at a time. Close the other session, then start the agent again.
