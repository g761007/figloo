# Figloo

Figloo is a Chrome extension plus a local MCP server that lets a coding agent detect an open Figma design tab, use the user's current selection as an anchor, and explore nearby layers and their properties through the Figma web UI, without scanning the whole document. It only reads what the DOM and web UI expose: no Figma REST API, official Figma MCP, Figma plugin, or private internal state. It may change the view and selection, but it never edits the design.

## Status

Pre-M0 skeleton. This repository contains the workspace layout, build tooling, the shared protocol enums, a placeholder MCP server, and an extension shell that only logs. The feasibility milestone (M0), which validates DOM-based reading on real Figma pages, is still in progress, so there is no WebSocket bridge, pairing, or DOM adapter yet.

## Requirements

- Node.js 24 (see `.node-version`)
- pnpm 10 (see `packageManager` in `package.json`)
- Chrome 116 or newer, to load the extension

## Install

```sh
pnpm install
```

## Development

Run these from the repository root. `build` runs the workspace packages in dependency order; run it before `typecheck` and `test`, because `@figloo/mcp` consumes the built output of `@figloo/protocol`.

```sh
pnpm build       # pnpm -r build
pnpm typecheck   # pnpm -r typecheck
pnpm test        # pnpm -r test
```

### Load the extension

1. Run `pnpm build`.
2. Open `chrome://extensions`, turn on the Developer mode toggle, and click "Load unpacked".
3. Select `apps/extension/dist`.

The extension currently logs on install and when its content script loads on `https://www.figma.com/design/*` or `https://www.figma.com/file/*`. The options page is a placeholder with no behavior.

### Run the MCP server

```sh
node apps/mcp/dist/index.js
```

The server speaks MCP over stdio and exposes a single tool, `get_status`, which always returns `{"status":"DISCONNECTED"}` until the extension bridge exists.

Example MCP client configuration (replace the path with your checkout):

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

## Repository layout

```text
apps/extension/      Chrome extension (Manifest V3): @figloo/extension
apps/mcp/            Local MCP server over stdio: @figloo/mcp
packages/protocol/   Shared zod schemas, types, and constants: @figloo/protocol
docs/plans/          Planning documents
docs/compatibility/  Compatibility matrix (placeholder)
tests/fixtures/      Regression fixtures (placeholder)
tests/integration/   Integration tests (placeholder)
```

## Plan

See [docs/plans/2026-09-30-figloo-mvp-plan.md](docs/plans/2026-09-30-figloo-mvp-plan.md).
