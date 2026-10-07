# Install and set up Figloo

English | [繁體中文](installation.zh-TW.md)

The README's [Quickstart](../README.md#quickstart) has your coding agent do these steps for you; this page describes them by hand. Check the [requirements](../README.md#requirements) first.

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

For Claude Code, the Figloo plugin installs the MCP server together with the [figloo-implement skill](../README.md#the-figloo-implement-skill):

```text
/plugin marketplace add g761007/figloo
/plugin install figloo@figloo
```

The plugin downloads the server bundle from the GitHub release of its version, so the release has to be reachable from your machine. A Figloo server you registered by hand would run next to the plugin's in every session; remove it with `claude mcp remove figloo -s user`.

Without the plugin, register the server once for all your projects, then start a new session:

```sh
claude mcp add -s user figloo -- node /absolute/path/to/figloo/apps/mcp/dist/index.js
```

With the release file, use its path instead, for example `node /absolute/path/to/figloo-mcp-0.4.1.mjs`. In a session, `/mcp` shows whether the server connected.

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
- Turn on "Adapt content for screen readers" under Main menu, Preferences, Accessibility settings. Screenshots then crop to the layer's position on screen, `get_visual_neighbors` can tell where layers are, and Figloo can put your zoom and place on the canvas back after a screenshot.
- Keep the Figma tab on screen while the agent works; next to the agent's window is enough. Figma ignores selection and expansion in background tabs, so Figloo reports `TAB_IN_BACKGROUND` instead of guessing. A page snapshot waits instead: it pauses while the tab is in the background and goes on when it is back.
