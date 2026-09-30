# Figloo

Figloo is a Chrome extension plus a local MCP server that lets a coding agent detect an open Figma design tab, use the user's current selection as an anchor, and explore nearby layers and their properties through the Figma web UI, without scanning the whole document. It only reads what the DOM and web UI expose: no Figma REST API, official Figma MCP, Figma plugin, or private internal state. It may change the view and selection, but it never edits the design.

## Status

M1 (connection loop) in progress. The extension pairs with the local MCP server over a loopback WebSocket, reconnects on its own, and reports which Figma design tabs are open and what each one can read. The `get_status` tool is real; the exploration tools (`get_anchor`, `get_neighbors`, `inspect_nodes`) are not implemented yet. See [docs/plans/2026-09-30-figloo-mvp-plan.md](docs/plans/2026-09-30-figloo-mvp-plan.md) for the roadmap and [docs/compatibility/](docs/compatibility/) for what was verified on real Figma pages.

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
| `get_status` | Reports the bridge state, whether the extension is connected, and every open Figma design tab with its readiness (`LOADING`, `READY`, `DEGRADED`, `INCOMPATIBLE`), access level (`edit`, `view`, `guest`, `unknown`), UI locale, and which UI surfaces the content script found. Includes a `hint` when something needs attention. |

## Development

```sh
pnpm build             # pnpm -r build
pnpm typecheck         # pnpm -r typecheck
pnpm test              # pnpm -r test (vitest in every package)
pnpm test:integration  # real Chrome + real MCP process + real Figma tab, see below
```

The integration test (`tests/integration/get-status.e2e.mjs`) launches Playwright's Chromium with the built extension, pairs it through the options page, opens a public Figma file as a guest, and checks `get_status` before and after restarting the MCP process. It needs network access, a built workspace, and the browser download:

```sh
pnpm exec playwright install chromium
```

Branded Google Chrome 137 and newer ignore `--load-extension`, which is why the test does not use the installed Chrome. Set `FIGLOO_E2E_HEADED=1` to watch it, and `FIGLOO_E2E_FIGMA_URL` to use another file.

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
