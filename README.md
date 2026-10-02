# Figloo

English | [繁體中文](README.zh-TW.md)

Figloo is a Chrome extension plus a local MCP server that lets a coding agent detect an open Figma design tab, use the user's current selection as an anchor, and explore nearby layers and their properties through the Figma web UI, without scanning the whole document. It only reads what the DOM and web UI expose: no Figma REST API, official Figma MCP, Figma plugin, or private internal state. It may change the view and selection, but it never edits the design.

## Status

The MVP (milestones M0 to M4 of the [plan](docs/plans/2026-09-30-figloo-mvp-plan.md)) is complete. An agent can list the pages of a Figma file, open a page or start from the user's selection, walk the layer tree one bounded page at a time, read what Figma's inspection panel shows, take screenshots, and export icons and images. To implement a page, `snapshot_layer` reads every layer of it at once, with a screenshot, and saves the result so that `query_snapshot` can look layers up without touching Figma again. Figloo targets engineers with view access to a file; it never edits the design.

- [docs/mcp-tools.md](docs/mcp-tools.md): every tool's parameters, results, and error codes.
- [docs/compatibility/](docs/compatibility/README.md): supported browsers and Figma settings, known limitations, and what was verified on real Figma pages.

## Quickstart

Paste this into your coding agent, Claude Code or Codex:

```text
Install Figloo for me by following https://raw.githubusercontent.com/g761007/figloo/main/docs/agent-install.md
```

The agent checks Node.js, downloads the latest release and verifies its checksums, registers the MCP server (as a plugin in Claude Code), and gives you a pairing token. It then walks you through the three steps only you can do:

1. Load the extension: on `chrome://extensions` (or `arc://extensions`), turn on Developer mode, click "Load unpacked", and pick the folder the agent names.
2. Paste the token and port into the extension's options page.
3. In Figma, use the English UI and turn on "Adapt content for screen readers".

Then start a new agent session, open a Figma design file, and ask the agent to call `get_status`. [Install](#install) and [Set up](#set-up) describe the same steps by hand.

## Requirements

- Node.js 24 to run the MCP server (see `.node-version`)
- pnpm 10 to build from source (see `packageManager` in `package.json`)
- A Chromium-based browser that loads unpacked extensions: Arc is verified, and Chrome 116 or newer is expected to work
- A Figma account with at least view access to the file, using Figma's English UI

## Install

### From release files

`pnpm package` builds three files into `release/` that can be handed to someone else:

| File | What to do with it |
|---|---|
| `figloo-extension-<version>.zip` | Unzip it into a folder you keep; the browser loads the extension from there. |
| `figloo-mcp-<version>.mjs` | Keep it anywhere; it is the whole MCP server and needs only Node.js 24. |
| `figloo-mcp-<version>.mcpb` | The same server as an MCP bundle. The Claude Code plugin downloads it from the GitHub release of its version, so attach it to that release. |

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

For Claude Code, the Figloo plugin installs the MCP server together with the [figloo-implement skill](#the-figloo-implement-skill):

```text
/plugin marketplace add g761007/figloo
/plugin install figloo@figloo
```

The plugin downloads the server bundle from the GitHub release of its version, so the release has to be reachable from your machine. A Figloo server you registered by hand would run next to the plugin's in every session; remove it with `claude mcp remove figloo -s user`.

Without the plugin, register the server once for all your projects, then start a new session:

```sh
claude mcp add -s user figloo -- node /absolute/path/to/figloo/apps/mcp/dist/index.js
```

With the release file, use its path instead, for example `node /absolute/path/to/figloo-mcp-0.3.2.mjs`. In a session, `/mcp` shows whether the server connected.

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

The server speaks MCP over stdio and, in the same process, listens on `ws://127.0.0.1:47129` for the extension. Set `FIGLOO_PORT` or edit `port` in the config file to change the port. If another program holds the port, `get_status` reports it instead of the server crashing.

Several agent sessions can use Figloo, one at a time. Each session starts its own server; one of them, the holder, listens on the port and serves the extension, and the others stand by. When a tool in a standby session needs Figma, that session takes the extension over once the holder has been idle for 10 seconds. While the holder is working, the tool returns `BUSY` and names the session Figloo is working for. When the holder exits, a standby session takes over on its own within a few seconds. Sessions are named after the agent, the project folder, and when they started, for example `Claude Code · shop (started 09:15)`; `get_status`, the toolbar icon, the popup, and the options page show which one Figloo serves. Servers from Figloo 0.1.0 cannot hand over, so restart sessions that still run one.

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
- Keep the Figma tab on screen while the agent works; next to the agent's window is enough. Figma ignores selection and expansion in background tabs, so Figloo reports `TAB_IN_BACKGROUND` instead of guessing. A page snapshot waits instead: it pauses while the tab is in the background and goes on when it is back.

## Toolbar icon

The icon shows, for the tab you are looking at, whether Figloo can use it. Hover over it for the reason and for which coding agent session Figloo serves, if any.

| Icon | Meaning |
|---|---|
| Indigo | A Figma design file Figloo can read. |
| Indigo with an amber `!` | A design file Figloo can read with a limitation, such as a guest session or a minimized UI. |
| Gray | Not a Figma design file, or the file is still loading. |
| Gray with a red `!` | A Figma design page Figloo cannot read. |

Click the icon to open the popup. It shows the file, the page, whether Figloo is ready, and which coding agent session it serves. When one layer is selected in Figma, it also shows the layer's path from the page and its direct children. Reading the children can briefly expand that layer in the layers panel; Figloo collapses it again.

"Copy prompt for the agent" copies text to paste into your coding agent before you describe the task. It names the file, the tab, and the selected layer, and tells the agent which Figloo tools to start with. When the selected layer is a frame on the canvas or in a section, such as a screen, the prompt says you want to implement that page and asks the agent for a snapshot of it first. Without a selection, the prompt asks the agent to explore the file on its own. The popup shows the prompt before you copy it.

"Diagnostics", at the bottom of the popup, shows a short report to paste into a [bug report](https://github.com/g761007/figloo/issues/new?template=bug_report.yml): the extension, protocol, and server versions, the browser, the connection, the tab's readiness and the parts of Figma's UI Figloo found, and the codes of the latest errors. It holds no file, page, or layer names and no links, and the popup shows it before you copy it.

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
| `export_asset` | Exports a layer the way Figma's Export button does, as SVG, PNG, JPG, or PDF, so the agent can pick the format and scale the project needs, for example SVG for web or PDF and PNG at 1x, 2x, and 3x for iOS. Returns SVG markup inline and PNG or JPG of at most 1568 px as an image. With `saveTo`, also writes the files to that path inside the project directory (`CLAUDE_PROJECT_DIR`, which Claude Code sets, or else the server's working directory); existing files are only replaced with `overwrite: true`. Figma names files after the layer without a scale suffix, so save each scale under its own file name. Without `format`, the layer's own export settings are used when it has some, and a layer without settings exports as SVG. With `format`, a temporary setting in that format and `scale` (1x by default) is added and removed again, unless the layer already has that exact setting. The layer's own settings are never changed. ZIP archives Figma packs several files into are opened. A hidden layer, or one inside a hidden layer, returns `LAYER_HIDDEN` at once, since Figma exports nothing for it. |
| `export_assets` | Exports several layers one after another into one folder of the project, as `export_asset` would: the given refs, or every layer a snapshot marks with export settings, optionally only inside one of its layers. Files keep Figma's names, with the layer's ref added when a name repeats. A call exports at most 50 layers and starts none after about 150 seconds; the rest come back in `remaining`. It stops early when the Figma tab goes to the background or the user steps in, and lists the other failures while the rest still export. |
| `snapshot_layer` | Reads a layer and everything inside it, up to 2,000 layers, about 40 seconds for 300 layers: a screenshot, and for each layer its place and size relative to the layer, whether it is hidden, its export settings, and everything `inspect_nodes` shows. Instances count as one layer. Returns the screenshot and an outline with one line per layer, and saves the snapshot under `~/.figloo/snapshots/`. A saved snapshot is returned without reading Figma again for 24 hours (`snapshotTtlHours` in the config file); `refresh: true` reads it again. One call reads for at most three minutes; when layers are left, it returns `complete: false` with its progress, and the next call with the same root reads on where it stopped. Meanwhile Figma shows an overlay with the progress and a Stop button, and other windows stay usable. Stop or Esc ends the read and puts the layers panel back; a click elsewhere in Figma also stops it. If the tab goes to the background, the read pauses and goes on when it is back. After the page reloads, the root of a saved snapshot can be passed again with a new context, and every ref of the snapshot works in it. When the root was snapshotted before, the result counts the layers new, changed, and removed since then, names the removed ones, and marks the others in the outline; an expired snapshot is kept 30 days for this comparison. |
| `query_snapshot` | Looks layers up in a saved snapshot without the Figma tab, even after the page reloads: by ref, in full, or by text, type, the layer they are inside, and whether they are new or changed since the previous snapshot, as outline lines or in full, a page at a time. |
| `summarize_snapshot` | Summarizes a saved snapshot, or one section of it, without the Figma tab: every color with what it colors, text style, gap, padding side, corner radius, border width, and shadow, with how many layers use each, and the instances by name with their component properties. For mapping a design onto the project's tokens and components. |
| `release_context` | Forgets a context and its layer refs. |

The full contract, with every parameter, result field, and error code, is in [docs/mcp-tools.md](docs/mcp-tools.md).

A typical request goes: `get_status`, then `list_pages` and `explore_page` (or `get_anchor` when the user selected something), `capture` to see a page or frame, `get_neighbors` to find the parts that matter, `inspect_nodes` for their exact values, and `export_asset` for icons and images. Each call is bounded and reports how many UI operations it used. To implement a whole page, call `snapshot_layer` on its frame instead, `summarize_snapshot` for the values and components it uses, then `query_snapshot` for the details.

When several Figma tabs are open, the tools that start from a tab take its `tabId`. The prompt copied from the popup names its tab; without one, `get_status` asks the agent to check with the user which file to use.

Figma applies selection, expansion, zoom, and page changes only while its tab is visible. Reading pages, the selection, and already expanded layers works from a background tab; `get_visual_neighbors`, `inspect_nodes`, `capture`, `export_asset`, page switches, and expanding collapsed layers return `TAB_IN_BACKGROUND` until the Figma tab is on screen. `snapshot_layer` needs the tab on screen to start, then pauses while it is in the background. Keeping Figma beside the agent window is enough. These tools select layers one after another, and `capture` zooms the view; the user's selection, including several selected layers, is put back afterwards, the zoom is not.

## The figloo-implement skill

[`plugins/figloo/skills/figloo-implement/`](plugins/figloo/skills/figloo-implement/SKILL.md) guides an agent through implementing a Figma page or component with Figloo: check the connection, settle what to build, take a snapshot, map the design onto the project's tokens and components, read the details section by section, build, compare the result with the screenshot, and report. It also covers looking at a design and exporting assets. The agent picks it up when you paste a prompt from the popup or ask to build or export from the design you have open.

The Claude Code plugin includes it. To use it without the plugin, copy or link the folder:

| Agent | Where the folder goes | How to call it by name |
|---|---|---|
| Claude Code | `~/.claude/skills/figloo-implement` | `/figloo-implement` |
| Codex | `~/.agents/skills/figloo-implement` | `$figloo-implement` |

Codex also needs the MCP server registered in `~/.codex/config.toml`, as shown in [Register the MCP server](#2-register-the-mcp-server-with-your-agent).

## Development

```sh
pnpm build             # pnpm -r build
pnpm typecheck         # pnpm -r typecheck
pnpm test              # pnpm -r test (vitest in every package)
pnpm test:integration  # real Chromium + real MCP process + real Figma tabs, see below
pnpm package           # build, then write the release files into release/
pnpm test:release      # the status integration test, run against the files in release/
pnpm --filter @figloo/mcp docs:tools   # regenerate docs/mcp-tools.md after changing a tool
claude plugin validate --strict plugins/figloo   # check the plugin; run it on . for the marketplace
claude plugin eval plugins/figloo --mocks off --ablation none   # whether the skill fires when it should, and only then
```

`pnpm package` also checks that the extension's manifest and the three `package.json` files carry the same version, that `plugins/figloo/.claude-plugin/plugin.json` carries it with the URL of that version's bundle, and that [CHANGELOG.md](CHANGELOG.md) has a section for the version, so bump them together. The plugin evals need `--mocks off`, since `claude plugin eval` cannot stand in for a server declared through a bundle; the cases grant no Figloo tools, so nothing reaches Figma.

`pnpm test` fails when `docs/mcp-tools.md` no longer matches the tools the server registers.

GitHub Actions runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml) on every push to `main` and every pull request: build, typecheck, the unit tests one package at a time, and packaging. The integration tests below need a browser and a Figma link, so they only run locally.

To release a version:

1. Bump the version in `apps/extension/static/manifest.json`, the three `package.json` files, and `plugins/figloo/.claude-plugin/plugin.json` (its version and bundle URL), and add the version's section to CHANGELOG.md. Text above the section's first `###` heading becomes the introduction of the release notes.
2. Run `pnpm package` and `pnpm test:release`.
3. Commit, tag the commit `vX.Y.Z`, and push both at once: `git push origin main vX.Y.Z`. [`.github/workflows/release.yml`](.github/workflows/release.yml) tests and packages the tagged commit, checks the tag against the version, writes the notes with the SHA-256 of the files it uploads, and publishes the release. New plugin installs cannot download the bundle until the release is out, so push the tag together with the commit.

Running the Release workflow by hand from the Actions tab is a dry run: it keeps the files and the notes as an artifact and publishes nothing.

The integration test (`tests/integration/get-status.e2e.mjs`) launches Playwright's Chromium with the built extension, pairs it through the options page, opens a Figma file as a guest, and checks `get_status` before and after restarting the MCP process, and while a second server takes the extension over and exits again. It needs network access, a built workspace, the browser download, and a Figma design file that anyone with the link can view. The link is not committed: copy the example file to `tests/integration/.env.local`, which git ignores, and fill it in, or set `FIGLOO_E2E_FIGMA_URL` instead:

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
plugins/figloo/      Claude Code plugin: the figloo-implement skill, its evals, and the server bundle it downloads
.claude-plugin/      Marketplace manifest, so the repository can be added with /plugin marketplace add
scripts/             Release packaging, the release check, and the release notes
.github/workflows/   CI, and the release workflow a version tag starts
tests/fixtures/      Captured Figma markup and export files for regression tests
tests/integration/   End-to-end tests against real Chromium and Figma
tests/acceptance/    Core-scenario acceptance run for a signed-in browser
release/             Output of pnpm package (not committed)
```

## License

Figloo is released under the [MIT License](LICENSE).

## Troubleshooting

Where to look:

- **`get_status`**: ask the agent to call it. It reports the bridge, the extension connection, and each Figma tab's readiness with the reason, plus a `hint` with the next step.
- **Toolbar icon and popup**: the tooltip and the popup show the same readiness and agent connection for the current tab. "Diagnostics" in the popup gives a report for a bug report, without file, page, or layer names.
- **Options page**: shows the connection state, the agent session Figloo serves, the last handover between sessions, and the last connection error.
- **Service worker console**: on `chrome://extensions` (or `arc://extensions`), click "service worker" on the Figloo card.
- **Server log**: the server writes one line per call to stderr, with counts, UI operations, and time, but no layer names. To read it, run the server by hand in a terminal, for example `node apps/mcp/dist/index.js`, while no agent session runs one.

Common problems:

- `get_status` says `DISCONNECTED`: make sure the extension is loaded and paired, then check the options page. It shows the last connection error, for example a refused token or an unreachable port.
- The options page says `unpaired`: the token field is empty. Run the `pair` command again and paste the values.
- A tab is `DEGRADED` with "guest session": you are not signed in to Figma in that browser profile, so layers cannot be selected.
- A tab is `DEGRADED` with "Figma UI is minimized": the layers panel is not rendered while the UI is hidden. Press Cmd+\ or click the expand button next to the file name.
- A tab stays `LOADING` or becomes `INCOMPATIBLE` right after installing the extension: reload the Figma tab so the content script is injected.
- `export_asset` returns `EXPORT_BLOCKED`: Figma handed over no file and the browser started no download. If the browser blocked repeated downloads from figma.com, allow them in the site settings and retry.
- `export_asset` returns `LAYER_HIDDEN`: the layer, or a layer it is inside, is hidden in Figma, and Figma exports nothing for it, even from its own Export button.
- `export_asset` returns `EXPORT_PENDING`: the browser is waiting to save the fallback download, usually behind a Save dialog. Confirm it, or turn off asking where to save each file.
- `snapshot_layer` returns `complete: false`: the layer has more than one call can read in three minutes. Call it again with the same root until `complete` is true; `query_snapshot` answers `SNAPSHOT_INCOMPLETE` until then.
- `snapshot_layer` returns `SUBTREE_TOO_LARGE`: the layer holds more than 2,000 layers. Snapshot one of the children the message lists instead.
- `snapshot_layer` fails after 60 seconds in Codex: raise `tool_timeout_sec`, see [Register the MCP server](#2-register-the-mcp-server-with-your-agent).
- A tool returns `BUSY` and names another session: Figloo is serving that session, which is working or used Figloo in the last 10 seconds. Retry in a moment, or finish the work there first.
- `get_status` or a tool says the port is held by a session running an older Figloo: that session started Figloo 0.1.0, which cannot hand over. Restart that session, or close it.
- A tool says the session holding Figloo did not answer: that session's server is stuck. Close that session.
- With the plugin installed, no Figloo tools show up: the plugin could not download the server bundle for its version. `/plugin` lists the error; check that the GitHub release of that version has the `.mcpb` file and can be reached from your machine.
- The agent sees two sets of Figloo tools: a Figloo server registered by hand runs next to the plugin's. Remove it with `claude mcp remove figloo -s user`.
