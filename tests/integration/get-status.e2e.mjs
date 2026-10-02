// End-to-end check for M1 and the toolbar icon: Playwright's Chromium with the unpacked extension,
// a real figloo-mcp process over stdio, and a real Figma tab. Run with `pnpm test:integration`
// after `pnpm build` and `pnpm exec playwright install chromium`.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright";
import { FIGMA_URL } from "./figma-url.mjs";
import { EXTENSION_ID } from "../../packages/protocol/dist/index.js";

const ROOT = resolve(import.meta.dirname, "../..");
// `pnpm test:release` points these at the unzipped extension and the bundled server in release/.
const EXTENSION_DIR = process.env.FIGLOO_E2E_EXTENSION_DIR ?? join(ROOT, "apps/extension/dist");
const MCP_ENTRY = process.env.FIGLOO_E2E_MCP_ENTRY ?? join(ROOT, "apps/mcp/dist/index.js");
const FILE_KEY = new URL(FIGMA_URL).pathname.split("/")[2];
const TOKEN = `e2e-${Math.random().toString(36).slice(2)}`;
const HEADLESS = process.env.FIGLOO_E2E_HEADED !== "1";
const MANIFEST = JSON.parse(readFileSync(join(EXTENSION_DIR, "manifest.json"), "utf8"));
const DEFAULT_TITLE = MANIFEST.action.default_title;

const log = (...args) => console.log("[e2e]", ...args);
const assert = (condition, message) => {
  if (!condition) throw new Error(`assertion failed: ${message}`);
};

function freePort() {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function startMcp(configDir, port) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY],
    env: { ...process.env, FIGLOO_CONFIG_DIR: configDir, FIGLOO_PORT: String(port) },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => process.stderr.write(`[mcp] ${chunk}`));
  const client = new Client({ name: "figloo-e2e", version: "0" });
  await client.connect(transport);
  return client;
}

/** The error body of a tool result that failed, or null when it succeeded. */
function toolErrorOf(result) {
  if (!result.isError) return null;
  return JSON.parse(result.content[0].text).error;
}

async function getStatus(client) {
  const result = await client.callTool({ name: "get_status" });
  return result.structuredContent;
}

async function waitFor(probe, { timeoutMs, intervalMs = 1_000, label }) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await probe();
    if (last.ok) return last.value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const detail = last?.value?.tabs ? JSON.stringify(last.value.tabs) : JSON.stringify(last?.value)?.slice(0, 600);
  throw new Error(`timed out waiting for ${label}; last value: ${detail}`);
}

// Branded Google Chrome 137+ ignores --load-extension, so use Playwright's Chromium
// (`pnpm exec playwright install chromium`); "chromium" selects the full binary that supports extensions headlessly.
// Figma's CDN rejects the default "HeadlessChrome" user agent, so present a regular Chrome one.
function launchBrowser() {
  return chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: HEADLESS,
    userAgent: HEADLESS ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36" : undefined,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
}

async function serviceWorkerOf(browserContext) {
  const [worker] = browserContext.serviceWorkers();
  return worker ?? browserContext.waitForEvent("serviceworker", { timeout: 15_000 });
}

/** The per-tab toolbar tooltip and badge, read from inside the extension. */
function actionState(worker, tabId) {
  return worker.evaluate(
    async (id) => ({ title: await chrome.action.getTitle({ tabId: id }), badge: await chrome.action.getBadgeText({ tabId: id }) }),
    tabId,
  );
}

const configDir = mkdtempSync(join(tmpdir(), "figloo-e2e-config-"));
const profileDir = mkdtempSync(join(tmpdir(), "figloo-e2e-profile-"));
let client = null;
let context = null;

try {
  const port = await freePort();
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ token: TOKEN, port }));

  client = await startMcp(configDir, port);
  let status = await getStatus(client);
  assert(status.status === "DISCONNECTED", `initial status is ${status.status}`);
  assert(status.bridge.listening === true, "bridge is listening");
  log(`mcp up on port ${port}, status ${status.status}`);

  context = await launchBrowser();
  const worker = await serviceWorkerOf(context);
  const extensionId = new URL(worker.url()).host;
  assert(extensionId === EXTENSION_ID, `extension id ${extensionId} matches the pinned id`);
  log(`extension loaded with id ${extensionId}`);

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.fill("#token", TOKEN);
  await options.fill("#port", String(port));
  await options.click("button[type=submit]");
  await waitFor(
    async () => {
      const text = (await options.textContent("#status")) ?? "";
      return { ok: /Connection: connected/.test(text), value: text };
    },
    { timeoutMs: 20_000, label: "options page to report connected" },
  );
  log("paired through the options page");

  status = await waitFor(
    async () => {
      const value = await getStatus(client);
      return { ok: value.extension.connected, value };
    },
    { timeoutMs: 10_000, label: "get_status to see the extension" },
  );
  assert(status.status === "NO_DESIGN_TAB", `status without design tabs is ${status.status}`);
  assert(status.extension.extensionVersion === MANIFEST.version, "extension version is reported");

  // A tab without a design file keeps the default gray icon, and Chrome can load both icon sets.
  const optionsTabId = await options.evaluate(() => chrome.tabs.getCurrent().then((t) => t.id));
  let action = await actionState(worker, optionsTabId);
  assert(action.title === DEFAULT_TITLE && action.badge === "", `options tab keeps the default icon state (got ${JSON.stringify(action)})`);
  await worker.evaluate(async (tabId) => {
    for (const variant of ["color", "gray"]) {
      await chrome.action.setIcon({ tabId, path: { 16: `icons/${variant}-16.png`, 32: `icons/${variant}-32.png` } });
    }
  }, optionsTabId);

  const figma = await context.newPage();
  await figma.goto(FIGMA_URL, { waitUntil: "domcontentloaded" });
  const findTab = (value) => value.tabs.find((t) => t.fileKey === FILE_KEY);
  status = await waitFor(
    async () => {
      const value = await getStatus(client);
      const tab = findTab(value);
      return { ok: Boolean(tab && tab.probedAt !== null && tab.readiness !== "LOADING"), value };
    },
    { timeoutMs: 120_000, intervalMs: 3_000, label: "the Figma tab to finish loading" },
  );
  let tab = findTab(status);
  log(`figma tab (guest default): readiness=${tab.readiness} access=${tab.access} collapsed=${tab.capabilities.uiCollapsed} url=${tab.url} detail=${tab.detail}`);
  assert(["guest", "unknown"].includes(tab.access), `a fresh profile is a guest session or not yet classified (got ${tab.access})`);
  assert(tab.capabilities.uiCollapsed === true, "a guest starts with the Figma UI minimized");
  assert(tab.readiness === "DEGRADED", `minimized UI is reported as DEGRADED (got ${tab.readiness})`);
  // Figma may drop the query string for guests, so compare with the URL the tab has right now.
  const nodeInUrl = new URL(tab.url).searchParams.get("node-id")?.replace("-", ":") ?? null;
  assert(tab.nodeIdFromUrl === nodeInUrl, `node id matches the tab URL (got ${tab.nodeIdFromUrl}, url ${tab.url})`);
  const figmaTabId = tab.tabId;
  action = await actionState(worker, figmaTabId);
  log(`toolbar (guest default): badge=${JSON.stringify(action.badge)} title=${JSON.stringify(action.title)}`);
  assert(action.badge === "!" && action.title.startsWith("Figloo: limited on"), "a degraded tab gets the colored icon with a warning badge");
  assert(action.title.includes("minimized") && action.title.endsWith("Agent: connected"), "the tooltip says why and that the agent is connected");

  // Expand the UI the way a user would. No tab event fires for this, so only the content script's
  // change notification can update the toolbar; get_status is not called until it has.
  await figma.click('button[aria-label^="Expand UI"]');
  action = await waitFor(
    async () => {
      const value = await actionState(worker, figmaTabId);
      return { ok: value.title.includes("guest session"), value };
    },
    { timeoutMs: 30_000, intervalMs: 500, label: "the content script to report the expanded UI" },
  );
  log(`toolbar after expanding the UI: ${JSON.stringify(action.title)}`);
  status = await waitFor(
    async () => {
      const value = await getStatus(client);
      const tab = findTab(value);
      return { ok: Boolean(tab && tab.capabilities.layersPanel && tab.access === "guest"), value };
    },
    { timeoutMs: 30_000, intervalMs: 2_000, label: "the layers panel and guest banner after expanding the UI" },
  );
  tab = findTab(status);
  log(`figma tab (expanded): readiness=${tab.readiness} rows=${tab.layerRowCount} locale=${tab.uiLocale} detail=${tab.detail}`);
  assert(status.tabsFresh === true, "tabs were refreshed for this call");
  assert(tab.layerRowCount > 0, "layer rows are counted");
  assert(tab.readiness === "DEGRADED", `guest session stays DEGRADED (got ${tab.readiness})`);
  assert(status.status === "DEGRADED", `overall status follows the tab (got ${status.status})`);
  action = await actionState(worker, figmaTabId);
  assert(action.badge === "!" && action.title.includes("guest session"), `tooltip follows the new limitation (got ${JSON.stringify(action.title)})`);

  // M2 through every hop: a guest cannot select, so get_anchor must say so instead of guessing an anchor.
  let anchorError = toolErrorOf(await client.callTool({ name: "get_anchor", arguments: { tabId: figmaTabId } }));
  assert(anchorError?.code === "NO_SELECTION" && /select the layers to work on/.test(anchorError.hint), `get_anchor without a selection (got ${JSON.stringify(anchorError)})`);
  anchorError = toolErrorOf(await client.callTool({ name: "get_anchor", arguments: { tabId: optionsTabId } }));
  assert(anchorError?.code === "TAB_NOT_FOUND", `get_anchor on a tab without a design file (got ${JSON.stringify(anchorError)})`);
  const neighborsError = toolErrorOf(await client.callTool({ name: "get_neighbors", arguments: { contextId: "ctx_missing", ref: "1:1", relation: "parent" } }));
  assert(neighborsError?.code === "CONTEXT_NOT_FOUND", `get_neighbors without a context (got ${JSON.stringify(neighborsError)})`);
  log("get_anchor and get_neighbors report missing selection, tab, and context through the extension");

  // M3 through every hop, as far as a guest can go: pages, a page context, a subtree, and a page capture.
  const pagesResult = await client.callTool({ name: "list_pages", arguments: { tabId: figmaTabId } });
  const pageList = pagesResult.structuredContent?.pages ?? [];
  assert(!pagesResult.isError && pageList.length > 1 && pageList.filter((p) => p.current).length === 1, `list_pages returns the file's pages (got ${JSON.stringify(pagesResult.structuredContent)})`);
  const explored = await client.callTool({ name: "explore_page", arguments: { tabId: figmaTabId } });
  assert(!explored.isError, `explore_page on the shown page (got ${JSON.stringify(explored.content)})`);
  const pageContext = explored.structuredContent;
  assert(pageContext.nodes.length > 0 && pageContext.nodes.every((n) => n.depth === 0), "explore_page lists the layers directly on the page");
  const withChildren = pageContext.nodes.find((n) => n.hasChildren);
  const tree = await client.callTool({ name: "get_neighbors", arguments: { contextId: pageContext.contextId, ref: withChildren.ref, relation: "children", depth: 2, limit: 30 } });
  assert(!tree.isError, `children with depth 2 (got ${JSON.stringify(tree.content)})`);
  const treeNodes = tree.structuredContent.nodes;
  const firstLevel = new Set(treeNodes.filter((n) => n.parentRef === withChildren.ref).map((n) => n.ref));
  assert(treeNodes.every((n) => n.parentRef === withChildren.ref || firstLevel.has(n.parentRef)), "every layer in the subtree hangs off the ref or its children");
  log(`subtree of ${withChildren.ref}: ${treeNodes.length} layers, ${firstLevel.size} direct children, hasMore=${tree.structuredContent.hasMore}`);
  const shot = await client.callTool({ name: "capture", arguments: { contextId: pageContext.contextId } });
  assert(!shot.isError, `capture of the whole page (got ${JSON.stringify(shot.content)})`);
  const image = shot.content.find((c) => c.type === "image");
  const jpeg = Buffer.from(image.data, "base64");
  assert(image.mimeType === "image/jpeg" && jpeg[0] === 0xff && jpeg[1] === 0xd8, "capture returns a JPEG image");
  assert(shot.structuredContent.width <= 1568 && shot.structuredContent.height <= 1568, "the capture fits within 1568 px");
  log(`page capture: ${shot.structuredContent.width}x${shot.structuredContent.height}, ${jpeg.length} bytes, crop=${shot.structuredContent.cropSource}`);
  const inspectError = toolErrorOf(await client.callTool({ name: "inspect_nodes", arguments: { contextId: pageContext.contextId, refs: [withChildren.ref] } }));
  assert(inspectError?.code === "UI_NOT_READY" && /guest/.test(inspectError.message), `inspect_nodes explains that a guest cannot select (got ${JSON.stringify(inspectError)})`);
  const exportError = toolErrorOf(await client.callTool({ name: "export_asset", arguments: { contextId: pageContext.contextId, ref: withChildren.ref, format: "svg" } }));
  assert(exportError?.code === "UI_NOT_READY" && /guest/.test(exportError.message), `export_asset explains that a guest cannot select (got ${JSON.stringify(exportError)})`);
  // The download hook runs in Figma's own page; it must be gone even when the export fails.
  const hookLeft = await figma.evaluate(() => ({ marker: "__figlooExportCapture" in window, native: URL.createObjectURL.toString().includes("[native code]") && HTMLAnchorElement.prototype.click.toString().includes("[native code]") }));
  assert(!hookLeft.marker && hookLeft.native, `the export hook is removed from the page after a failed export (got ${JSON.stringify(hookLeft)})`);
  log("inspect_nodes and export_asset explain that a guest cannot select; the export hook was removed");

  // The toolbar popup for the guest tab: its status, the missing selection, and a prompt that lets
  // the agent explore the file. Opened as a page, since the toolbar button cannot be clicked here.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${figmaTabId}`);
  await popup.waitForSelector("section.prompt textarea", { timeout: 30_000 });
  const shown = await popup.evaluate(() => ({
    file: document.querySelector(".status .file")?.textContent ?? "",
    readiness: document.querySelector(".readiness")?.textContent ?? "",
    agent: document.querySelector(".agent")?.textContent ?? "",
    hint: document.querySelector(".hint")?.textContent ?? "",
    prompt: document.querySelector("textarea.preview")?.value ?? "",
  }));
  assert(shown.file.length > 0 && shown.prompt.includes(`File: ${shown.file} (tab ${figmaTabId})`), `the popup names the file and its tab (got ${JSON.stringify(shown)})`);
  assert(/guest session cannot select layers/.test(shown.readiness), `the popup shows the guest limitation (got ${shown.readiness})`);
  assert(shown.agent === "Agent: connected", `the popup shows the agent connection (got ${shown.agent})`);
  assert(/No layer is selected/.test(shown.hint) && shown.prompt.includes(`Call list_pages and explore_page with tabId ${figmaTabId}`), `without a selection the popup offers a prompt to explore the file (got ${JSON.stringify(shown)})`);
  await popup.click("button.copy");
  const copyOutcome = await popup
    .waitForFunction(() => (document.querySelector("button.copy")?.textContent === "Copied" ? "copied" : /press Cmd\+C/.test(document.body.textContent ?? "") ? "selected for a manual copy" : null), null, { timeout: 5_000 })
    .then((handle) => handle.jsonValue());
  // Reading the clipboard needs a permission extension pages lack here, so paste it into a field instead.
  let clipboard = null;
  if (copyOutcome === "copied") {
    await popup.evaluate(() => {
      const field = document.createElement("textarea");
      field.id = "paste-check";
      document.body.append(field);
      field.focus();
    });
    await popup.keyboard.press("ControlOrMeta+V");
    clipboard = await popup.evaluate(() => document.querySelector("#paste-check").value);
  }
  assert(copyOutcome !== "copied" || clipboard === shown.prompt, `the clipboard holds the prompt (got ${JSON.stringify(clipboard)})`);
  log(`popup for the guest tab: "${shown.readiness}"; copy: ${copyOutcome}${clipboard === null ? "" : "; pasting gives back the prompt"}`);
  await popup.close();
  await figma.bringToFront();

  // Chrome keeps per-tab state across reloads, so scramble it first; the extension must restore it
  // on its own after the reload (get_status is not called here).
  await worker.evaluate(async (tabId) => {
    await chrome.action.setTitle({ tabId, title: "stale" });
    await chrome.action.setBadgeText({ tabId, text: "" });
  }, figmaTabId);
  await figma.reload({ waitUntil: "domcontentloaded" });
  action = await waitFor(
    async () => {
      const value = await actionState(worker, figmaTabId);
      return { ok: value.badge === "!" && value.title.startsWith("Figloo: limited on"), value };
    },
    { timeoutMs: 90_000, intervalMs: 1_000, label: "the toolbar icon to recover after a reload" },
  );
  log(`toolbar after reload: ${JSON.stringify(action.title)}`);

  await client.close();
  client = null;
  action = await waitFor(
    async () => {
      const value = await actionState(worker, figmaTabId);
      return { ok: value.title.includes("Agent: not connected"), value };
    },
    { timeoutMs: 10_000, intervalMs: 500, label: "the tooltip to report the agent as gone" },
  );
  log("mcp stopped; tooltip reports the agent as not connected; starting a new one to check reconnection");
  client = await startMcp(configDir, port);
  status = await waitFor(
    async () => {
      const value = await getStatus(client);
      return { ok: value.extension.connected && value.tabs.length > 0, value };
    },
    { timeoutMs: 90_000, intervalMs: 3_000, label: "the extension to reconnect after the MCP restart" },
  );
  log(`reconnected after restart, status ${status.status}`);
  action = await waitFor(
    async () => {
      const value = await actionState(worker, figmaTabId);
      return { ok: value.title.endsWith("Agent: connected"), value };
    },
    { timeoutMs: 10_000, intervalMs: 500, label: "the tooltip to report the agent as connected again" },
  );

  // Leaving the design file must restore the default icon for that tab.
  await figma.goto("about:blank");
  action = await waitFor(
    async () => {
      const value = await actionState(worker, figmaTabId);
      return { ok: value.title === DEFAULT_TITLE && value.badge === "", value };
    },
    { timeoutMs: 15_000, intervalMs: 500, label: "the toolbar icon to reset after leaving the design file" },
  );
  log("toolbar reset after leaving the design file");

  // A tab whose icon was changed before the worker lost track of it (for example after the worker
  // restarted) must also be reset when it navigates. The options tab plays that tab here.
  await worker.evaluate(async (tabId) => {
    await chrome.action.setTitle({ tabId, title: "left over from before a worker restart" });
    await chrome.action.setIcon({ tabId, path: { 16: "icons/color-16.png", 32: "icons/color-32.png" } });
  }, optionsTabId);
  await options.goto("about:blank");
  action = await waitFor(
    async () => {
      const value = await actionState(worker, optionsTabId);
      return { ok: value.title === DEFAULT_TITLE, value };
    },
    { timeoutMs: 15_000, intervalMs: 500, label: "an untracked tab with a leftover icon to reset" },
  );
  log("untracked tab with a leftover icon was reset");

  await figma.close();
  status = await waitFor(
    async () => {
      const value = await getStatus(client);
      return { ok: value.tabs.length === 0, value };
    },
    { timeoutMs: 20_000, label: "the closed tab to disappear" },
  );
  assert(status.status === "NO_DESIGN_TAB", `status after closing the tab is ${status.status}`);

  // Restart the browser with the same profile: the saved pairing must reconnect without touching any UI.
  await context.close();
  context = await launchBrowser();
  status = await waitFor(
    async () => {
      const value = await getStatus(client);
      return { ok: value.extension.connected, value };
    },
    { timeoutMs: 60_000, intervalMs: 2_000, label: "the extension to reconnect after a browser restart" },
  );
  log(`reconnected after browser restart, status ${status.status}`);
  assert(status.status === "NO_DESIGN_TAB", `status after browser restart is ${status.status}`);
  log("PASS");
} catch (error) {
  console.error("[e2e] FAIL", error);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  await client?.close().catch(() => {});
  rmSync(configDir, { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });
}
