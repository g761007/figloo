# Figloo

English | [繁體中文](README.zh-TW.md)

Figloo is a local Figma bridge and design context layer for coding agents. It lets an agent explore the design you have open in your browser, starting from your selection: walk the layers around it, read layout and visual properties exactly as Figma's inspection panel shows them, take screenshots, export icons and images, and save snapshots of whole screens to implement from. It is a Chrome extension plus a local MCP server, and it only reads what Figma's web UI shows: no Figma REST API, official Figma MCP, Figma plugin, or private internal state. It may change the view and selection, but it never edits the design.

## Why Figloo

- **View access is enough.** Figma's REST API and its official MCP server set their limits by seat: a View or Collab seat gets up to 6 calls a month ([REST API](https://developers.figma.com/docs/rest-api/rate-limits), [MCP server](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/), as of October 2026). Figloo reads the Figma tab you already have open, so it needs no token or paid seat, and it has no monthly quota.
- **It starts from what you point at.** The agent begins at the layers you selected, and every call reads a bounded part of the file instead of scanning all of it.
- **Read once, implement from the snapshot.** `snapshot_layer` reads a whole screen, up to 2,000 layers, and saves it. The agent then looks up values, summarizes the colors, text styles, and spacing it uses, and compares it with the previous snapshot, without touching Figma again.
- **Local.** There is no Figloo server or account, and the bridge listens only on `127.0.0.1`. See [Privacy and security](#privacy-and-security).

If your team has Dev or Full seats, Figma's own MCP server reads the file directly and is the more direct route. Figloo is for engineers with view access who want their coding agent to work from the design in front of them.

## How it works

```text
Coding agent ──stdio (MCP)──▶ Figloo MCP server ──ws://127.0.0.1:47129──▶ Figloo extension ──DOM──▶ Figma tab
```

The agent calls Figloo's tools over MCP. The server, which the agent starts, passes each call to the extension over a local WebSocket. The extension's content script reads the Figma tab's layers panel and inspection panel, selecting and expanding layers the way you would, and puts your selection back afterwards. The server saves snapshots under `~/.figloo/snapshots/`.

## Status

Figloo covers the design-to-code exploration workflow: listing a file's pages, starting from the user's selection, walking the layer tree a bounded page at a time, reading the inspection panel, taking screenshots, exporting assets one at a time or in batches, and taking, querying, summarizing, and comparing snapshots of whole screens. It targets engineers with view access to a file.

Figloo is developed and tested against real Figma pages. Its version is still 0.x, so tools and results may change between minor versions: [CHANGELOG.md](CHANGELOG.md) lists what each release changed, and [ROADMAP.md](ROADMAP.md) what comes next.

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

Then start a new agent session, open a Figma design file, and ask the agent to call `get_status`. [docs/installation.md](docs/installation.md) describes the same steps by hand.

## Requirements

- Node.js 24 to run the MCP server (see `.node-version`)
- pnpm 10 to build from source (see `packageManager` in `package.json`)
- A Chromium-based browser that loads unpacked extensions: Arc is verified, and Chrome 116 or newer is expected to work
- A Figma account with at least view access to the file, using Figma's English UI

## Install

The [Quickstart](#quickstart) has your agent install the latest release. To install by hand, from the release files or from source, see [docs/installation.md](docs/installation.md#install).

## Set up

Setting up takes four steps: load the extension, register the MCP server with your agent (in Claude Code, the plugin also installs the [figloo-implement skill](#the-figloo-implement-skill)), pair once, and prepare Figma. [docs/installation.md](docs/installation.md#set-up) walks through them and explains the permissions the extension asks for.

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

Figma applies selection, expansion, zoom, and page changes only while its tab is visible. Reading pages, the selection, and already expanded layers works from a background tab; `get_visual_neighbors`, `inspect_nodes`, `capture`, `export_asset`, page switches, and expanding collapsed layers return `TAB_IN_BACKGROUND` until the Figma tab is on screen. `snapshot_layer` needs the tab on screen to start, then pauses while it is in the background. Keeping Figma beside the agent window is enough. These tools select layers one after another, and `capture` and `snapshot_layer` zoom the view; the user's selection, including several selected layers, is put back afterwards, and so are the zoom and the place on the canvas when "Adapt content for screen readers" is on (`viewRestored`).

## The figloo-implement skill

[`plugins/figloo/skills/figloo-implement/`](plugins/figloo/skills/figloo-implement/SKILL.md) guides an agent through implementing a Figma page or component with Figloo: check the connection, settle what to build, take a snapshot, map the design onto the project's tokens and components, read the details section by section, build, compare the result with the screenshot, and report. It also covers looking at a design and exporting assets. The agent picks it up when you paste a prompt from the popup or ask to build or export from the design you have open.

The Claude Code plugin includes it. To use it without the plugin, copy or link the folder:

| Agent | Where the folder goes | How to call it by name |
|---|---|---|
| Claude Code | `~/.claude/skills/figloo-implement` | `/figloo-implement` |
| Codex | `~/.agents/skills/figloo-implement` | `$figloo-implement` |

Codex also needs the MCP server registered in `~/.codex/config.toml`, as shown in [Register the MCP server](docs/installation.md#2-register-the-mcp-server-with-your-agent).

## Troubleshooting

Start with `get_status`: ask the agent to call it, and its `hint` says what to fix, while each tab lists the limitations it has and what to do about them. Outside an agent session, `figloo-mcp doctor` checks Node.js, the config file, and who holds the port. [docs/troubleshooting.md](docs/troubleshooting.md) lists where else to look and the common problems, from `DISCONNECTED` to `BUSY`.

## Privacy and security

Figloo runs on your machine. The MCP server listens only on `127.0.0.1` and accepts only the Figloo extension, identified by its pinned ID and the pairing token. Figloo has no server or account of its own, and it hands design content only to the agent that called the tool; what the agent does with it, such as sending it to its model provider, is up to the agent. Snapshots stay in `~/.figloo/snapshots/`. [SECURITY.md](SECURITY.md) has the details and how to report a vulnerability.

## Roadmap

[ROADMAP.md](ROADMAP.md) lists what comes next, by area: reliability, developer experience, design intelligence, performance, compatibility, and distribution.

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

GitHub Actions runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml) on every push to `main` and every pull request: build, typecheck, the unit tests one package at a time, and packaging. The integration tests below need a browser and a Figma link, so they run locally, and once a day in [`.github/workflows/figma-canary.yml`](.github/workflows/figma-canary.yml) against a public test file, to catch changes in Figma's web UI early.

To release a version:

1. Bump the version in `apps/extension/static/manifest.json`, the three `package.json` files, and `plugins/figloo/.claude-plugin/plugin.json` (its version and bundle URL), and add the version's section to CHANGELOG.md. Text above the section's first `###` heading becomes the introduction of the release notes.
2. Run `pnpm package` and `pnpm test:release`.
3. Commit, tag the commit `vX.Y.Z`, and push both at once: `git push origin main vX.Y.Z`. [`.github/workflows/release.yml`](.github/workflows/release.yml) tests and packages the tagged commit, checks the tag against the version, writes the notes with the SHA-256 of the files it uploads, and publishes the release. New plugin installs cannot download the bundle until the release is out, so push the tag together with the commit.

Running the Release workflow by hand from the Actions tab is a dry run: it keeps the files and the notes as an artifact and publishes nothing.

The integration test (`tests/integration/get-status.e2e.mjs`) launches Playwright's Chromium with the built extension, pairs it through the options page, opens a Figma file as a guest, and checks `get_status` before and after restarting the MCP process, and while a second server takes the extension over and exits again. It needs network access, a built workspace, the browser download, and a Figma design file that anyone with the link can view and that has at least two pages. The link is not committed: copy the example file to `tests/integration/.env.local`, which git ignores, and fill it in, or set `FIGLOO_E2E_FIGMA_URL` instead:

```sh
pnpm exec playwright install chromium
cp tests/integration/.env.example tests/integration/.env.local
```

Branded Google Chrome 137 and newer ignore `--load-extension`, which is why the test does not use the installed Chrome. A second script, `tests/integration/explore.e2e.mjs`, injects the layer navigation code into a visible guest Figma tab and checks expanding, listing, paging, climbing past same-named layers, and restoring the panel, so the file needs two same-named sibling layers with children. Set `FIGLOO_E2E_HEADED=1` to watch them.

The Figma canary workflow runs both scripts every day, and on demand from the Actions tab. It reads the link from the repository secret `FIGLOO_CANARY_FIGMA_URL` and fails when the secret is missing. Its logs are public and show layer names, so the file must be one made for the test, never a real design.

The signed-in canary checks what a guest cannot reach: the selection, the inspection panel, snapshots, exports, and putting the view back. It runs on your machine only, never in CI, with a browser profile signed in to a dedicated Figma test account that only views the test file and has "Adapt content for screen readers" on. Sign in once with the first command below, which opens the profile in a window and types nothing for you; the profile stays in `~/.figloo/canary-profile` (or `FIGLOO_CANARY_PROFILE`). Then set `FIGLOO_CANARY_FIGMA_URL` in `tests/integration/.env.local` to a link to the frame to snapshot, which must hold a layer with export settings, and run the canary. It prints refs, counts, and codes only.

```sh
node tests/canary/login.mjs
pnpm test:canary
```

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
docs/                Installation, troubleshooting, the tool contract, and the agent install steps
docs/plans/          Planning documents
docs/compatibility/  What was verified on real Figma pages, and known limits
plugins/figloo/      Claude Code plugin: the figloo-implement skill, its evals, and the server bundle it downloads
.claude-plugin/      Marketplace manifest, so the repository can be added with /plugin marketplace add
scripts/             Release packaging, the release check, and the release notes
.github/workflows/   CI, the release workflow a version tag starts, and the daily Figma canary
tests/fixtures/      Captured Figma markup and export files for regression tests
tests/integration/   End-to-end tests against real Chromium and Figma
tests/canary/        Signed-in canary for a dedicated test account, run locally
tests/acceptance/    Core-scenario acceptance run for a signed-in browser
release/             Output of pnpm package (not committed)
```

## License

Figloo is released under the [MIT License](LICENSE).
