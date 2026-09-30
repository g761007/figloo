// Runs the end-to-end test against the artifacts in release/ instead of the build output: the
// extension is loaded from its unzipped archive and the server runs from the single-file bundle.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const extensionVersion = JSON.parse(readFileSync(join(ROOT, "apps/extension/static/manifest.json"), "utf8")).version;
const mcpVersion = JSON.parse(readFileSync(join(ROOT, "apps/mcp/package.json"), "utf8")).version;
const unpacked = mkdtempSync(join(tmpdir(), "figloo-release-extension-"));
try {
  execFileSync("unzip", ["-q", join(ROOT, "release", `figloo-extension-${extensionVersion}.zip`), "-d", unpacked]);
  execFileSync(process.execPath, [join(ROOT, "tests/integration/get-status.e2e.mjs")], {
    stdio: "inherit",
    env: { ...process.env, FIGLOO_E2E_EXTENSION_DIR: unpacked, FIGLOO_E2E_MCP_ENTRY: join(ROOT, "release", `figloo-mcp-${mcpVersion}.mjs`) },
  });
} finally {
  rmSync(unpacked, { recursive: true, force: true });
}
