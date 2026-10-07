// Prints the GitHub release notes for a version: the text of its CHANGELOG.md section, how to
// upgrade, the release files with their SHA-256 (docs/agent-install.md checks downloads against this
// table), how to install, and the section's changes. Run after `pnpm package`, so the table describes
// the files that get uploaded: `node scripts/release-notes.mjs 0.4.0 > release/notes.md`.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("usage: node scripts/release-notes.mjs <version>, for example 0.4.0");

/** The lines of the version's section, without its heading, up to the next version or the link definitions. */
function changelogSection() {
  const lines = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8").split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${version}] - `));
  if (start < 0) throw new Error(`CHANGELOG.md has no "## [${version}] - <date>" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## [") || /^\[[^\]]+\]: https?:\/\//.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

const section = changelogSection();
const firstHeading = section.search(/^### /m);
const intro = (firstHeading < 0 ? section : section.slice(0, firstHeading)).trim();
const changes = firstHeading < 0 ? "" : section.slice(firstHeading).trim();

const protocol = /PROTOCOL_VERSION = "([^"]+)"/.exec(readFileSync(join(ROOT, "packages/protocol/src/index.ts"), "utf8"))?.[1];
if (!protocol) throw new Error("packages/protocol/src/index.ts has no PROTOCOL_VERSION");

const files = [`figloo-extension-${version}.zip`, `figloo-mcp-${version}.mjs`, `figloo-mcp-${version}.mcpb`];
const rows = files.map((name) => `| \`${name}\` | \`${createHash("sha256").update(readFileSync(join(ROOT, "release", name))).digest("hex")}\` |`);

const notes = [
  ...(intro ? [intro, ""] : []),
  "## Upgrading",
  "",
  "- Replace the extension with the new zip and press the reload button on its card in `chrome://extensions` or `arc://extensions`.",
  "- Update the Claude Code plugin, or the `.mjs` file you registered, then start new agent sessions so they run the new server.",
  `- The extension and the MCP server speak bridge protocol ${protocol}. A pair that speaks different versions does not connect, and \`get_status\` reports \`PROTOCOL_MISMATCH\`.`,
  "",
  "## Files",
  "",
  "| File | SHA-256 |",
  "|---|---|",
  ...rows,
  "",
  "## Install",
  "",
  `1. Unzip \`${files[0]}\` into a folder you keep. On \`chrome://extensions\` or \`arc://extensions\`, turn on Developer mode, click "Load unpacked", and select that folder.`,
  `2. Register the MCP server. In Claude Code, install the plugin, which downloads \`${files[2]}\` from this release:`,
  "   ```text",
  "   /plugin marketplace add g761007/figloo",
  "   /plugin install figloo@figloo",
  "   ```",
  `   Without the plugin, keep \`${files[1]}\` anywhere (it needs only Node.js 24), register it, then start a new session:`,
  "   ```sh",
  `   claude mcp add -s user figloo -- node /absolute/path/to/${files[1]}`,
  "   ```",
  `3. Pair once: run \`node ${files[1]} pair\` and paste the token and port into the extension's options page. The plugin's server reads the same \`~/.figloo/config.json\`, so this works for the plugin too.`,
  '4. In Figma, sign in (view access is enough), use the English UI, keep the UI expanded, and turn on "Adapt content for screen readers" under Main menu, Preferences, Accessibility settings. Keep the Figma tab on screen while the agent works.',
  "",
  "Or let your agent do it: the README's Quickstart has one sentence to paste into Claude Code or Codex, which installs Figloo by following `docs/agent-install.md` and walks you through the steps only you can do.",
  "",
  "The [README](https://github.com/g761007/figloo#readme) has the details, and [docs/troubleshooting.md](https://github.com/g761007/figloo/blob/main/docs/troubleshooting.md) the common problems.",
  // The section's Added, Changed, and Fixed headings sit one level below this one.
  ...(changes ? ["", "## Changes", "", changes] : []),
];
process.stdout.write(`${notes.join("\n")}\n`);
