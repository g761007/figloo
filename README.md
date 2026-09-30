# Figloo

Figloo is a Chrome extension plus a local MCP server that lets a coding agent detect an open Figma design tab, use the user's current selection as an anchor, and explore nearby layers and their properties through the Figma web UI, without scanning the whole document. It only reads what the DOM and web UI expose: no Figma REST API, official Figma MCP, Figma plugin, or private internal state. It may change the view and selection, but it never edits the design.

## Status

M3 (properties, screenshots, and page entry points) implemented; verification in a signed-in browser is in progress. An agent can list the pages of a Figma file, open a page or start from the user's selection, walk the layer tree one bounded page at a time, read what Figma's inspection panel shows for a layer, and take screenshots. Figloo targets engineers with view access to a file; it never edits the design. See [docs/plans/2026-09-30-figloo-mvp-plan.md](docs/plans/2026-09-30-figloo-mvp-plan.md) for the roadmap and [docs/compatibility/](docs/compatibility/) for what was verified on real Figma pages.

## Requirements

- Node.js 24 (see `.node-version`)
- pnpm 10 (see `packageManager` in `package.json`)
- Chrome 116 or newer (Chromium-based browsers such as Arc work too), to load the extension

## Install

```sh
pnpm install
pnpm build
```

`pnpm build` runs the workspace packages in dependency order; run it before `typecheck` and `test`, because both other packages consume the built output of `@figloo/protocol`.

## Set up

### 1. Load the extension

1. Open `chrome://extensions` (or `arc://extensions`), turn on the Developer mode toggle, and click "Load unpacked".
2. Select `apps/extension/dist`.

The extension ID is pinned by the `key` field in `apps/extension/static/manifest.json`, so it is the same on every machine (`offikfnknfkgijgianpfcghbccmkcjnb`). The local server only accepts connections from that ID.

The extension asks for access to all sites (`<all_urls>`) because Chrome only lets an extension screenshot a tab without a click on its icon when it has that permission. Its content script still runs only on Figma design files.

### 2. Register the MCP server with your agent

Example configuration (replace the path with your checkout):

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

The server speaks MCP over stdio and, in the same process, listens on `ws://127.0.0.1:47129` for the extension. Set `FIGLOO_PORT` or edit `port` in the config file to change the port. If the port is taken, `get_status` reports the error instead of the server crashing.

### 3. Pair once

```sh
node apps/mcp/dist/index.js pair
```

This prints the pairing token and port stored in `~/.figloo/config.json` (created on first run, mode 0600; override the directory with `FIGLOO_CONFIG_DIR`). Open the extension's options page, paste both values, and click "Save and connect". From then on the extension connects automatically whenever the MCP server is running, and reconnects after either side restarts.

## Toolbar icon

The icon shows, for the tab you are looking at, whether Figloo can use it. Hover over it for the reason and for whether a coding agent is connected.

| Icon | Meaning |
|---|---|
| Colorful | A Figma design file Figloo can read. |
| Colorful with an amber `!` | A design file Figloo can read with a limitation, such as a guest session or a minimized UI. |
| Gray | Not a Figma design file, or the file is still loading. |
| Gray with a red `!` | A Figma design page Figloo cannot read. |

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
| `get_anchor` | Returns the single layer the user selected in a tab, plus a `contextId`. |
| `get_neighbors` | Lists the `parent`, `ancestors`, `siblings`, or `children` of a layer returned in the same context. Pages hold at most 50 layers (20 by default); follow `nextCursor` for more. `children` also takes `depth` (up to 3) for a breadth-first subtree. |
| `inspect_nodes` | Reads Figma's inspection panel for up to 5 layers: size and sizing mode, position, auto layout flow, padding, gap, corner radius, fills, borders, shadows, text content, typography per style run, and component properties. Values are exactly as Figma shows them. |
| `capture` | Screenshots a layer, zoomed to fit, or the whole page. Returns a JPEG of at most 1568 px on its long edge. |
| `release_context` | Forgets a context and its layer refs. |

A typical request goes: `get_status`, then `list_pages` and `explore_page` (or `get_anchor` when the user selected something), `capture` to see a page or frame, `get_neighbors` to find the parts that matter, and `inspect_nodes` for their exact values. Each call is bounded and reports how many UI operations it used.

Figma applies selection, expansion, zoom, and page changes only while its tab is visible. Reading pages, the selection, and already expanded layers works from a background tab; `inspect_nodes`, `capture`, page switches, and expanding collapsed layers return `TAB_IN_BACKGROUND` until the Figma tab is on screen. Keeping Figma beside the agent window is enough. `inspect_nodes` and `capture` select layers one after another, and `capture` zooms the view; the user's selection is put back afterwards, the zoom is not.

## Development

```sh
pnpm build             # pnpm -r build
pnpm typecheck         # pnpm -r typecheck
pnpm test              # pnpm -r test (vitest in every package)
pnpm test:integration  # real Chromium + real MCP process + real Figma tabs, see below
```

The integration test (`tests/integration/get-status.e2e.mjs`) launches Playwright's Chromium with the built extension, pairs it through the options page, opens a public Figma file as a guest, and checks `get_status` before and after restarting the MCP process. It needs network access, a built workspace, and the browser download:

```sh
pnpm exec playwright install chromium
```

Branded Google Chrome 137 and newer ignore `--load-extension`, which is why the test does not use the installed Chrome. A second script, `tests/integration/explore.e2e.mjs`, injects the layer navigation code into a visible guest Figma tab and checks expanding, listing, paging, climbing past same-named layers, and restoring the panel. Set `FIGLOO_E2E_HEADED=1` to watch them, and `FIGLOO_E2E_FIGMA_URL` to use another file.

## Repository layout

```text
apps/extension/      Chrome extension (Manifest V3): @figloo/extension
apps/mcp/            Local MCP server over stdio plus the WebSocket bridge: @figloo/mcp
packages/protocol/   Shared zod schemas, types, and constants: @figloo/protocol
docs/plans/          Planning documents
docs/compatibility/  What was verified on real Figma pages, and known limits
tests/fixtures/      Regression fixtures (placeholder)
tests/integration/   End-to-end test against real Chrome and Figma
```

## Troubleshooting

- `get_status` says `DISCONNECTED`: make sure the extension is loaded and paired, then check the options page. It shows the last connection error, for example a refused token or an unreachable port.
- The options page says `unpaired`: the token field is empty. Run the `pair` command again and paste the values.
- A tab is `DEGRADED` with "guest session": you are not signed in to Figma in that browser profile, so layers cannot be selected.
- A tab is `DEGRADED` with "Figma UI is minimized": the layers panel is not rendered while the UI is hidden. Press Cmd+\ or click the expand button next to the file name.
- A tab stays `LOADING` or becomes `INCOMPATIBLE` right after installing the extension: reload the Figma tab so the content script is injected.
