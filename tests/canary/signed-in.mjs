// Signed-in canary: what only a signed-in session with view access reaches on real Figma, such as the
// selection, the inspection panel, exports, snapshots, and putting the view back. It runs on the
// maintainer's machine with a browser profile signed in to a dedicated Figma test account, never in CI,
// and prints refs, counts, and codes only.
//
//   node tests/canary/signed-in.mjs
//
// Needs `pnpm build`, Playwright's Chromium, a profile signed in once with tests/canary/login.mjs
// (FIGLOO_CANARY_PROFILE, default ~/.figloo/canary-profile) whose account has "Adapt content for screen
// readers" on, and FIGLOO_CANARY_FIGMA_URL, set or in tests/integration/.env.local: a file the account can
// only view, linked to the frame to snapshot (node-id), which must hold a layer with export settings.
// Exits with 1 when a check fails and 2 when it is not set up.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "../..");
const envFile = join(ROOT, "tests/integration/.env.local");
if (!process.env.FIGLOO_CANARY_FIGMA_URL && existsSync(envFile)) process.loadEnvFile(envFile);
const FIGMA_URL = process.env.FIGLOO_CANARY_FIGMA_URL;
const PROFILE = process.env.FIGLOO_CANARY_PROFILE ?? join(homedir(), ".figloo", "canary-profile");
// As in the integration tests, these can point at the unzipped extension and the bundled server of a release.
const EXTENSION_DIR = process.env.FIGLOO_E2E_EXTENSION_DIR ?? join(ROOT, "apps/extension/dist");
const MCP_ENTRY = process.env.FIGLOO_E2E_MCP_ENTRY ?? join(ROOT, "apps/mcp/dist/index.js");
const TOKEN = `canary-${Math.random().toString(36).slice(2)}`;
const HEADLESS = process.env.FIGLOO_E2E_HEADED !== "1";

const log = (...args) => console.log("[canary]", ...args);
const assert = (condition, message) => {
  if (!condition) throw new Error(`assertion failed: ${message}`);
};
if (!FIGMA_URL || !existsSync(PROFILE)) {
  console.error("Set FIGLOO_CANARY_FIGMA_URL (or add it to tests/integration/.env.local) and sign in once with node tests/canary/login.mjs.");
  process.exit(2);
}
const FILE_KEY = new URL(FIGMA_URL).pathname.split("/")[2];

function freePort() {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

const configDir = mkdtempSync(join(tmpdir(), "figloo-canary-config-"));
let client = null;
let context = null;
const started = Date.now();
try {
  const port = await freePort();
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ token: TOKEN, port }));
  client = new Client({ name: "figloo-canary", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [MCP_ENTRY],
      // Exported files stay in the temporary folder.
      env: { ...process.env, FIGLOO_CONFIG_DIR: configDir, FIGLOO_PORT: String(port), CLAUDE_PROJECT_DIR: configDir },
      stderr: "ignore",
    }),
  );
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
    if (result.isError) throw new Error(`${name} failed with ${JSON.parse(result.content.find((c) => c.type === "text").text).error.code}`);
    return { ...result.structuredContent, images: result.content.filter((c) => c.type === "image") };
  };

  // Figma's CDN rejects the default "HeadlessChrome" user agent, as in the integration tests.
  context = await chromium.launchPersistentContext(PROFILE, {
    channel: "chromium",
    headless: HEADLESS,
    viewport: { width: 1600, height: 1000 },
    userAgent: HEADLESS ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36" : undefined,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
  const options = await context.newPage();
  await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  await options.fill("#token", TOKEN);
  await options.fill("#port", String(port));
  await options.click("button[type=submit]");
  await options.close();

  const figma = await context.newPage();
  await figma.goto(FIGMA_URL, { waitUntil: "domcontentloaded" });
  let tab = null;
  for (let i = 0; i < 60 && !tab; i += 1) {
    const status = await call("get_status");
    const found = status.tabs?.find((t) => t.fileKey === FILE_KEY);
    if (found?.capabilities.uiCollapsed) await figma.click('button[aria-label^="Expand UI"]').catch(() => {});
    if (found && found.readiness !== "LOADING" && !found.capabilities.uiCollapsed) tab = found;
    else await new Promise((r) => setTimeout(r, 2_000));
  }
  assert(tab, "the Figma tab became ready within two minutes");
  log(`tab: readiness=${tab.readiness} access=${tab.access} mirror=${tab.capabilities.mirrorDom}`);
  assert(tab.access === "view", `the test account views the file (access is ${tab.access}; guest means the profile is signed out, so sign in again with node tests/canary/login.mjs)`);
  assert(tab.readiness === "READY", `the tab is READY (got ${tab.readiness}: ${tab.detail})`);
  assert(tab.capabilities.mirrorDom, 'the test account has "Adapt content for screen readers" on');

  // The link names the frame, which Figma selects on opening.
  const anchored = await call("get_anchor", { tabId: tab.tabId });
  const root = anchored.anchor.ref;
  log(`anchor: ${root}`);

  // Every frame on the page lists its children, including those under Fixed and Scrolls headers.
  const page = await call("explore_page", { tabId: tab.tabId, limit: 50 });
  const frames = page.nodes.filter((node) => node.hasChildren);
  for (const frame of frames) {
    const children = await call("get_neighbors", { contextId: page.contextId, ref: frame.ref, relation: "children", limit: 50 });
    assert(children.nodes.length > 0 && ["complete", "limit"].includes(children.stopReason), `children of ${frame.ref} are listed (got ${children.nodes.length}, ${children.stopReason})`);
  }
  log(`children listed for ${frames.length} frames on the page`);

  let snapshot = await call("snapshot_layer", { contextId: anchored.contextId, ref: root, refresh: true });
  while (!snapshot.complete) snapshot = await call("snapshot_layer", { contextId: anchored.contextId, ref: root });
  const lines = snapshot.outline.split("\n");
  const exported = lines.filter((line) => line.includes("[export ")).map((line) => line.trim().split(" ")[0]);
  log(`snapshot: ${snapshot.layerCount} layers, ${exported.length} with export settings, unreadable=${snapshot.unreadableLayers}, alignment=${snapshot.image.alignment}, viewRestored=${snapshot.viewRestored}`);
  assert(snapshot.unreadableLayers === 0, `every part of the inspection panel was read (${snapshot.unreadableLayers} layers were not)`);
  assert(exported.length > 0, "the snapshot found the export settings of at least one layer");
  assert(snapshot.image.alignment !== "unconfirmed", "the screenshot was checked against the screen reader mirror");
  assert(snapshot.viewRestored, "the view was put back after the snapshot");

  const refs = lines.slice(0, 5).map((line) => line.trim().split(" ")[0]);
  const inspected = await call("inspect_nodes", { contextId: anchored.contextId, refs });
  const sections = inspected.nodes.map((node) => node.sections.length);
  assert(sections.every((count) => count > 0), `every inspected layer shows sections (got ${sections.join(",")})`);
  assert(inspected.nodes.every((node) => node.sections.every((section) => !section.unreadable)), "no inspected section is unreadable");
  assert(inspected.userSelectionRestored, "the selection was put back after inspecting");
  log(`inspected ${refs.length} layers with ${sections.join(",")} sections`);

  const file = await call("export_asset", { contextId: anchored.contextId, ref: exported[0] });
  assert(file.usedExistingSettings && file.files.length > 0 && file.files.every((f) => f.bytes > 0), "the layer exported with the designer's settings");
  log(`export of ${exported[0]}: ${file.files.length} file(s), ${file.files.map((f) => f.mimeType).join(",")}`);

  const shot = await call("capture", { contextId: anchored.contextId, ref: root });
  assert(shot.images.length === 1 && shot.images[0].mimeType === "image/jpeg", "capture returns a JPEG");
  assert(shot.viewRestored, "the view was put back after the capture");

  const neighbors = await call("get_visual_neighbors", { contextId: anchored.contextId, ref: refs[1] });
  log(`visual neighbors of ${refs[1]}: ${neighbors.neighbors.length} placed, ${neighbors.unplaced.length} unplaced`);

  log(`PASS in ${Math.round((Date.now() - started) / 1000)} s`);
} catch (error) {
  console.error("[canary] FAIL", error.message);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  await client?.close().catch(() => {});
  rmSync(configDir, { recursive: true, force: true });
}
