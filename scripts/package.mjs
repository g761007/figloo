// Builds the installable artifacts into release/: the unpacked extension as a zip, and the MCP
// server as one self-contained file that runs with Node.js 24. Run through `pnpm package`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { build } from "esbuild";

const ROOT = resolve(import.meta.dirname, "..");
const RELEASE = join(ROOT, "release");
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

const extensionVersion = readJson("apps/extension/static/manifest.json").version;
const mcpVersion = readJson("apps/mcp/package.json").version;
const extensionZip = join(RELEASE, `figloo-extension-${extensionVersion}.zip`);
const mcpBundle = join(RELEASE, `figloo-mcp-${mcpVersion}.mjs`);

mkdirSync(RELEASE, { recursive: true });
rmSync(extensionZip, { force: true });
rmSync(mcpBundle, { force: true });

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

for (const file of [extensionZip, mcpBundle]) {
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  console.log(`${relative(ROOT, file)}  ${statSync(file).size} bytes  sha256 ${sha256}`);
}
