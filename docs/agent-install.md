# Installing Figloo, for coding agents

The user asked you to install Figloo: a Chrome extension plus a local MCP server that lets a coding agent read the Figma design open in the user's browser. Work through the steps in order; each ends when its **Done when** holds.

- Before a step writes outside the current project, tell the user what will change.
- A step marked **User** needs the user's hands. Tell them exactly what to do, in their language, and wait until they confirm.
- The pairing token is a local secret between Figloo's server and its extension. Show it only to the user, for pasting.

Paths below use `~` for the user's home folder (`%USERPROFILE%` on Windows).

## 1. Check the machine

Run `node --version`. Figloo's server needs Node.js 24 or newer; with an older version, stop and ask the user to install Node.js 24.

Note which agent you are, Claude Code or Codex; only step 5 differs between them.

**Done when** Node.js is 24 or newer.

## 2. Download the latest release

Read the latest release from `https://api.github.com/repos/g761007/figloo/releases/latest`: its `tag_name` (such as `v0.3.1`, so the version is `0.3.1`), its `assets`, and its `body`, which holds a table of SHA-256 checksums.

Download `figloo-extension-<version>.zip` and `figloo-mcp-<version>.mjs` from the assets' `browser_download_url` into `~/.figloo/releases/<version>/`. Compute each file's SHA-256 (`shasum -a 256 <file>` on macOS and Linux, `Get-FileHash <file>` on Windows) and compare it with the table. On a mismatch, delete the file, stop, and tell the user.

**Done when** both files are in place and match their checksums.

## 3. Unpack the extension

Remove `~/.figloo/extension/` if it exists; it holds nothing but the previous Figloo extension. Then unzip `figloo-extension-<version>.zip` into it. The browser loads the extension from this folder, so a later update only needs a reload in the browser.

**Done when** `~/.figloo/extension/manifest.json` exists.

## 4. Create the pairing token

Run `node ~/.figloo/releases/<version>/figloo-mcp-<version>.mjs pair`. It creates `~/.figloo/config.json` on its first run and prints the pairing token and the port.

**Done when** you have the token and the port.

## 5. Register the MCP server

### Claude Code

The Figloo plugin installs the MCP server together with the figloo-implement skill.

1. Run `claude mcp list`. If it lists a server named `figloo` that the user registered by hand, it would run next to the plugin's; ask the user, then remove it with `claude mcp remove figloo -s user`.
2. Run `claude plugin marketplace add g761007/figloo`, then `claude plugin install figloo@figloo`.

**Done when** `claude plugin list` shows `figloo` installed and enabled.

### Codex

1. In `~/.codex/config.toml`, add this table, or replace an existing `[mcp_servers.figloo]` table, keeping the rest of the file as it is. Write the server's absolute path, since the file does not expand `~`. `tool_timeout_sec` gives page snapshots their three minutes:

   ```toml
   [mcp_servers.figloo]
   command = "node"
   args = ["/absolute/path/to/.figloo/releases/<version>/figloo-mcp-<version>.mjs"]
   tool_timeout_sec = 300
   ```

2. Install the figloo-implement skill: download these three files from the release's tag into `~/.agents/skills/figloo-implement/`, keeping the `references/` folder:
   - `https://raw.githubusercontent.com/g761007/figloo/<tag>/plugins/figloo/skills/figloo-implement/SKILL.md`
   - `https://raw.githubusercontent.com/g761007/figloo/<tag>/plugins/figloo/skills/figloo-implement/references/snapshot-outline.md`
   - `https://raw.githubusercontent.com/g761007/figloo/<tag>/plugins/figloo/skills/figloo-implement/references/inspection-fields.md`

**Done when** `config.toml` has the table and `~/.agents/skills/figloo-implement/SKILL.md` exists.

## 6. User: load and pair the extension

Give the user these steps with the real folder path, token, and port filled in:

1. Open `chrome://extensions` (in Arc, `arc://extensions`), turn on Developer mode, click "Load unpacked", and choose `~/.figloo/extension`. Figloo needs a Chromium browser that loads unpacked extensions: Arc is verified, and Chrome 116 or newer is expected to work.
2. Open Figloo's options page (on the extension's card, Details, then Extension options), paste the token and the port, and click "Save and connect".

**Done when** the user confirms both.

## 7. User: prepare Figma

Tell the user that Figloo reads Figma through its web UI, which needs, in the browser that has the extension:

- Signed in to Figma; view access to a file is enough.
- Figma's English UI, kept expanded: Cmd+\ (Ctrl+\ on Windows) toggles it.
- "Adapt content for screen readers" turned on under Main menu, Preferences, Accessibility settings.

**Done when** you told the user; they can do this later.

## 8. Hand over

The MCP server loads only in a new agent session. Tell the user to start one, open a Figma design file in the browser, and ask the agent to call Figloo's `get_status`. It should report the extension as connected and the tab as `READY`; otherwise its `hint` says what to fix. The [README](https://github.com/g761007/figloo#troubleshooting) lists common problems.

To update Figloo later, run these steps again, then reload the extension on `chrome://extensions`.
