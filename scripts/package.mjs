// Builds the installable artifacts into release/: the unpacked extension as a zip, the MCP server as
// one self-contained file that runs with Node.js 24, and the same server as an MCP bundle (.mcpb) for
// the Claude Code plugin. Run through `pnpm package`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { build } from "esbuild";

const ROOT = resolve(import.meta.dirname, "..");
const RELEASE = join(ROOT, "release");
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

const extensionVersion = readJson("apps/extension/static/manifest.json").version;
const mcpVersion = readJson("apps/mcp/package.json").version;
const extensionZip = join(RELEASE, `figloo-extension-${extensionVersion}.zip`);
const mcpBundle = join(RELEASE, `figloo-mcp-${mcpVersion}.mjs`);
const mcpbName = `figloo-mcp-${mcpVersion}.mcpb`;
const mcpb = join(RELEASE, mcpbName);

// The plugin downloads this release's bundle, so its version and URL move with the server's.
const plugin = readJson("plugins/figloo/.claude-plugin/plugin.json");
const bundleUrl = `${plugin.repository}/releases/download/v${mcpVersion}/${mcpbName}`;
if (plugin.version !== mcpVersion || plugin.mcpServers !== bundleUrl) {
  throw new Error(`plugins/figloo/.claude-plugin/plugin.json needs "version": "${mcpVersion}" and "mcpServers": "${bundleUrl}"`);
}

// Every published version gets its own CHANGELOG.md section.
if (!readFileSync(join(ROOT, "CHANGELOG.md"), "utf8").includes(`\n## [${mcpVersion}] - `)) {
  throw new Error(`CHANGELOG.md needs a "## [${mcpVersion}] - <date>" section before this version is packaged`);
}

mkdirSync(RELEASE, { recursive: true });
for (const file of [extensionZip, mcpBundle, mcpb]) rmSync(file, { force: true });

await build({
  entryPoints: [join(ROOT, "apps/mcp/src/index.ts")],
  outfile: mcpBundle,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  define: { __FIGLOO_VERSION__: JSON.stringify(mcpVersion) },
  // ws loads these optional native add-ons only when they are installed.
  external: ["bufferutil", "utf-8-validate"],
  // Bundled CommonJS dependencies such as ws call require() for Node's own modules. esbuild keeps
  // the entry's #! line above this banner.
  banner: { js: 'import { createRequire as __figlooRequire } from "node:module";\nconst require = __figlooRequire(import.meta.url);' },
  logLevel: "warning",
});

// Zip the built extension with manifest.json at the top, so the unzipped folder loads as is.
execFileSync("zip", ["-r", "-X", "-q", extensionZip, "."], { cwd: join(ROOT, "apps/extension/dist") });

// An MCP bundle is a zip with manifest.json at the top; the format is at github.com/modelcontextprotocol/mcpb.
const staging = mkdtempSync(join(tmpdir(), "figloo-mcpb-"));
try {
  mkdirSync(join(staging, "server"));
  copyFileSync(mcpBundle, join(staging, "server/index.mjs"));
  copyFileSync(join(ROOT, "apps/extension/static/icons/color-128.png"), join(staging, "icon.png"));
  const manifest = {
    manifest_version: "0.3",
    name: "figloo",
    display_name: "Figloo",
    version: mcpVersion,
    description: "Lets a coding agent explore the Figma design open in the browser through the Figloo extension.",
    author: plugin.author,
    repository: { type: "git", url: plugin.repository },
    icon: "icon.png",
    server: {
      type: "node",
      entry_point: "server/index.mjs",
      mcp_config: { command: "node", args: ["${__dirname}/server/index.mjs"], env: {} },
    },
    compatibility: { runtimes: { node: ">=24.0.0" } },
  };
  writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  execFileSync("zip", ["-r", "-X", "-q", mcpb, "."], { cwd: staging });
} finally {
  rmSync(staging, { recursive: true, force: true });
}

for (const file of [extensionZip, mcpBundle, mcpb]) {
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  console.log(`${relative(ROOT, file)}  ${statSync(file).size} bytes  sha256 ${sha256}`);
}
