# Security

## Reporting a vulnerability

Please report a vulnerability privately, not in a public issue: open the repository's [Security tab](https://github.com/g761007/figloo/security) and choose "Report a vulnerability". Describe what an attacker can do and how to reproduce it. Leave out the contents of private Figma files; a public file or a description of the layers is enough.

Only the latest release gets security fixes. Figloo is versioned 0.x, so a fix ships as a new release, not as a patch to older ones.

## How Figloo is put together

```text
Coding agent ──stdio (MCP)──▶ Figloo MCP server ──ws://127.0.0.1:47129──▶ Figloo extension ──DOM──▶ Figma tab
```

The agent starts the MCP server and talks to it over stdio. The server waits for the browser extension on a local WebSocket. The extension reads the Figma tab through its web UI, the way a person would. It does not use Figma's API, Figma's internal state, or the user's Figma credentials.

## The local bridge

- The server listens on `127.0.0.1` only, on port 47129 unless `FIGLOO_PORT` or the config file says otherwise. It does not listen on other network interfaces.
- A WebSocket connection is accepted only when its `Origin` is the Figloo extension, `chrome-extension://offikfnknfkgijgianpfcghbccmkcjnb`. The ID is pinned by the `key` in the extension's manifest, so it is the same on every machine.
- The first message must be a `hello` with the pairing token and a compatible protocol version, sent within the handshake timeout. Otherwise the connection is closed. The token is compared in constant time.
- Besides the WebSocket, the server answers two HTTP requests, `GET /holder` and `POST /handover`, which other Figloo servers on the same machine use to hand the extension over between agent sessions. Both need the pairing token as a bearer token, and any request with an `Origin` header is refused, so a web page cannot make them even if it learned the token.
- The pairing token is 24 random bytes, created on first run and stored in `~/.figloo/config.json`. The folder is created with mode 0700 and the file with mode 0600. The extension keeps its copy in the browser's extension storage.

The token keeps web pages and other users of the machine away from the bridge. It does not protect against software running under your own user account, which can read the config file.

## The extension

| Permission | Why |
|---|---|
| `<all_urls>` host access | Chrome lets an extension screenshot a tab without a click on its icon only with this permission. `capture` and `snapshot_layer` need it. The content script still runs only on `https://www.figma.com/design/*` and `https://www.figma.com/file/*`. |
| `scripting` | Puts the content script into Figma tabs that were open before the extension was installed or reloaded, and, for the length of one export, wraps the functions Figma's page uses to start a download, so the exported file is handed to Figloo instead of being saved. The originals are put back afterwards. |
| `downloads` | Fallback for exports: when the file cannot be taken in the page, the extension watches for the browser's own download of that export and reports where it was saved. |
| `storage` | The pairing token and port. |
| `alarms` | Tries to reach the local server again every minute while it is not connected. |

Figloo never edits the design. It selects and expands layers, zooms, and switches pages, and it puts the user's selection back afterwards, and the zoom and place on the canvas when the screen reader setting is on. `export_asset` with a format the layer has no setting for adds a temporary export setting and removes it again. With view access, which Figloo is built for, such a setting never reaches the file. With edit access it is added to and removed from the file itself, so it may show up in the file's version history; Figloo has not been verified with edit access.

## Data on your machine

| What | Where | What it holds |
|---|---|---|
| Config | `~/.figloo/config.json` (mode 0600) | The pairing token, the port, the allowed extension IDs, and settings such as `snapshotTtlHours`. |
| Snapshots | `~/.figloo/snapshots/` (folders 0700, files 0600) | Per Figma file key and root layer: the layers' names, text, properties, and positions, and a screenshot. A snapshot is reused for 24 hours by default. An expired one is kept 30 days to compare the next snapshot with; after that, it is deleted the next time Figloo saves a snapshot of the same file. |
| Exported assets | Inside the project directory, only when the agent passes `saveTo` | The files Figma exported. The path must resolve inside the project directory (`CLAUDE_PROJECT_DIR`, or else the server's working directory), and an existing file is replaced only with `overwrite: true`. |
| Server log | stderr of the server process | One line per call with counts, UI operations, and time, but no layer names. |
| Diagnostics | The extension's memory, until the browser stops its service worker | Versions, the browser, the connection, each tab's readiness and which parts of Figma's UI were found, and the codes of the last 10 errors. No file, page, or layer names, no links, no error messages, and no token. It leaves the browser only when the user copies it. |

## Where design content goes

Figloo has no server, no account, and no telemetry. The extension talks only to the local server, and the server returns what it reads only to the agent that called the tool. What the agent does with that content, such as sending it to its model provider, is up to the agent and its provider, so check their data policies before using Figloo on confidential designs.

The Figma tab keeps talking to Figma as it always does. Installing Figloo downloads release files from GitHub: the Claude Code plugin downloads the server bundle of its version, and [docs/agent-install.md](docs/agent-install.md) has the agent check every file against the SHA-256 checksums in the release notes, which the release workflow computes from the files it uploads.
