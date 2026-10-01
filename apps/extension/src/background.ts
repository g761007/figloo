import {
  AnchorResultSchema,
  CaptureParamsSchema,
  CapturePlanSchema,
  ExplorePageParamsSchema,
  ExportFinishSchema,
  ExportPlanSchema,
  ExportRequestSchema,
  InspectParamsSchema,
  ListNeighborsParamsSchema,
  ListPagesResultSchema,
  MAX_SNAPSHOT_LAYERS,
  NeighborsResultSchema,
  PROTOCOL_VERSION,
  ProbeResultSchema,
  SNAPSHOT_TIME_BUDGET_MS,
  ServerMessageSchema,
  SnapshotParamsSchema,
  SnapshotReadResultSchema,
  TabOpResponseSchema,
  VisualNeighborsParamsSchema,
  type CaptureResult,
  type ExtensionMessage,
  type ProbeResult,
  type TabOpResponse,
  type TabStatus,
} from "@figloo/protocol";
import { DEFAULT_TITLE, actionAppearance, agentLine, applyAppearance } from "./action.js";
import { cropCapture, insideImage, placeInImage } from "./capture.js";
import { installExportCapture, removeExportCapture } from "./export-capture.js";
import { parseFigmaUrl } from "./figma-url.js";
import { POPUP_CHILDREN, type PopupSnapshot } from "./popup-model.js";
import { deriveReadiness } from "./readiness.js";
import { DEFAULT_PORT, type ConnectionState } from "./state.js";

const FIGMA_DESIGN_URLS = ["https://www.figma.com/design/*", "https://www.figma.com/file/*"];
const RECONNECT_ALARM = "figloo-reconnect";
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const REJECTED_RETRY_MS = 60_000;
const PROBE_TIMEOUT_MS = 3_000;
const REFRESH_DEBOUNCE_MS = 500;

interface Settings {
  token: string;
  port: number;
}

const state: ConnectionState = { phase: "disconnected", port: null, connectedAt: null, lastError: null, attempts: 0, tabCount: 0 };
let socket: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const tabs = new Map<number, TabStatus>();
const unreachableProbes = new Map<number, number>();
let connectPending = false;

async function loadSettings(): Promise<Settings | null> {
  const stored = await chrome.storage.local.get(["token", "port"]);
  const token = typeof stored.token === "string" ? stored.token.trim() : "";
  if (!token) return null;
  return { token, port: Number(stored.port) || DEFAULT_PORT };
}

async function connect(): Promise<void> {
  // Startup, alarm, and storage events can all call this in the same tick; open one socket only.
  if (connectPending || (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))) return;
  connectPending = true;
  const settings = await loadSettings().finally(() => {
    connectPending = false;
  });
  if (!settings) {
    setPhase("unpaired");
    state.lastError = "no pairing token saved; open the Figloo options page";
    return;
  }
  setPhase("connecting");
  state.port = settings.port;
  const ws = new WebSocket(`ws://127.0.0.1:${settings.port}/`);
  socket = ws;

  ws.addEventListener("open", () => {
    send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      token: settings.token,
      extensionVersion: chrome.runtime.getManifest().version,
      userAgent: navigator.userAgent,
    });
  });
  ws.addEventListener("message", (event) => {
    if (socket === ws) void handleServerMessage(String(event.data));
  });
  ws.addEventListener("error", () => {
    state.lastError = `cannot reach ws://127.0.0.1:${settings.port}; is figloo-mcp running?`;
  });
  ws.addEventListener("close", (event) => {
    // A socket that was replaced or closed on purpose must not touch the current connection's state.
    if (socket !== ws) return;
    socket = null;
    stopHeartbeat();
    const wasConnected = state.phase === "connected";
    setPhase("disconnected");
    state.connectedAt = null;
    if (event.code >= 4000 && event.reason) state.lastError = `${event.code} ${event.reason}`;
    // Unauthorized or incompatible: retry slowly so a bad token does not hammer the bridge.
    if (event.code === 4001 || event.code === 4003) {
      scheduleReconnect(REJECTED_RETRY_MS);
      return;
    }
    scheduleReconnect(wasConnected ? BACKOFF_MS[0] : nextBackoff());
  });
}

function nextBackoff(): number {
  const delay = BACKOFF_MS[Math.min(state.attempts, BACKOFF_MS.length - 1)];
  state.attempts += 1;
  return delay;
}

function scheduleReconnect(delayMs: number): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delayMs);
}

function reconnectNow(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  state.attempts = 0;
  if (socket) {
    const ws = socket;
    socket = null;
    ws.close(1000, "reconnect requested");
  }
  void connect();
}

function send(message: ExtensionMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

async function handleServerMessage(raw: string): Promise<void> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return;
  }
  const parsed = ServerMessageSchema.safeParse(json);
  if (!parsed.success) return;
  const message = parsed.data;
  switch (message.type) {
    case "welcome":
      setPhase("connected");
      state.connectedAt = Date.now();
      state.attempts = 0;
      state.lastError = null;
      startHeartbeat(message.heartbeatIntervalMs);
      await refreshAllTabs();
      pushTabs();
      return;
    case "error":
      state.lastError = `${message.code}: ${message.message}`;
      return;
    case "ping":
      send({ type: "pong", t: message.t });
      return;
    case "pong":
      return;
    case "request":
      await handleRequest(message.id, message.op, message.tabId, message.params);
      return;
    default:
      return;
  }
}

async function handleRequest(id: string, op: string, tabId?: number, params?: Record<string, unknown>): Promise<void> {
  try {
    switch (op) {
      case "refresh_tabs":
        send({ type: "response", id, ok: true, result: { tabs: await refreshAllTabs() } });
        return;
      case "get_anchor":
      case "list_neighbors":
      case "list_pages":
      case "explore_page":
      case "inspect_nodes":
      case "capture":
      case "export_asset":
      case "visual_neighbors":
      case "snapshot_layer": {
        const reply = await runInTab(tabId, op, params);
        send(reply.ok ? { type: "response", id, ok: true, result: reply.result } : { type: "response", id, ok: false, error: reply.error });
        return;
      }
      default:
        send({ type: "response", id, ok: false, error: { code: "BAD_MESSAGE", message: `unsupported op ${op}` } });
    }
  } catch (error) {
    send({ type: "response", id, ok: false, error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) } });
  }
}

const tabQueues = new Map<number, Promise<unknown>>();
/** Tabs with a snapshot queued or running; a snapshot takes minutes, so other ops do not wait behind it. */
const snapshotting = new Set<number>();

/** Forwards an op to the tab's content script; each tab runs one UI operation sequence at a time. */
async function runInTab(tabId: number | undefined, op: string, params: unknown): Promise<TabOpResponse> {
  const tab = tabId === undefined ? null : await chrome.tabs.get(tabId).catch(() => null);
  if (tabId === undefined || !tab || !parseFigmaUrl(tab.url ?? "").isDesignFile) {
    return { ok: false, error: { code: "TAB_NOT_FOUND", message: `tab ${tabId ?? "(none)"} is not an open Figma design file` } };
  }
  const schema = PARAM_SCHEMAS[op];
  if (schema && !schema.safeParse(params).success) {
    return { ok: false, error: { code: "BAD_MESSAGE", message: `${op} params do not match the protocol schema` } };
  }
  if (snapshotting.has(tabId)) {
    return { ok: false, error: { code: "BUSY", message: "Figloo is reading a snapshot in this tab, which takes up to three minutes" } };
  }
  if (op === "snapshot_layer") snapshotting.add(tabId);
  const previous = tabQueues.get(tabId) ?? Promise.resolve();
  const current = previous.then((): Promise<TabOpResponse> =>
    op === "capture"
      ? captureTab(tabId, params)
      : op === "export_asset"
        ? exportTab(tabId, params)
        : op === "snapshot_layer"
          ? snapshotTab(tabId, params)
          : sendToTab(tabId, op, params),
  );
  const settled = current.catch(() => undefined);
  tabQueues.set(tabId, settled);
  void settled.then(() => {
    if (op === "snapshot_layer") snapshotting.delete(tabId);
    if (tabQueues.get(tabId) === settled) tabQueues.delete(tabId);
  });
  return current;
}

const PARAM_SCHEMAS: Record<string, { safeParse(value: unknown): { success: boolean } }> = {
  list_neighbors: ListNeighborsParamsSchema,
  explore_page: ExplorePageParamsSchema,
  inspect_nodes: InspectParamsSchema,
  capture: CaptureParamsSchema,
  export_asset: ExportRequestSchema,
  visual_neighbors: VisualNeighborsParamsSchema,
  snapshot_layer: SnapshotParamsSchema,
};

/** How long the page hook waits for Figma to hand over the exported files. */
const EXPORT_CAPTURE_WAIT_MS = 8_000;
/** How long a browser download may take before the export is reported as pending. */
const EXPORT_DOWNLOAD_WAIT_MS = 30_000;

/**
 * Exports a layer. First choice: a short-lived hook in the page's main world receives the files
 * Figma produces, so nothing reaches the download folder. Fallback: when nothing was captured, the
 * browser's own download of the file is used and its path is reported.
 */
async function exportTab(tabId: number, params: unknown): Promise<TabOpResponse> {
  const started = Date.now();
  const token = crypto.randomUUID();
  const downloads: number[] = [];
  const onCreated = (item: chrome.downloads.DownloadItem) => {
    const fromFigma = item.url.startsWith("blob:https://www.figma.com/") || item.url.startsWith("data:") || (item.referrer ?? "").startsWith("https://www.figma.com/");
    if (fromFigma && Date.parse(item.startTime) >= started - 1_000) downloads.push(item.id);
  };
  chrome.downloads.onCreated.addListener(onCreated);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: installExportCapture, args: [token, EXPORT_CAPTURE_WAIT_MS + 20_000] });
    const prepared = await sendToTab(tabId, "prepare_export", { ...(params as object), token });
    if (!prepared.ok) return prepared;
    const plan = ExportPlanSchema.parse(prepared.result);
    const finished = await sendToTab(tabId, "finish_export", { token, expected: plan.settings.length, waitMs: EXPORT_CAPTURE_WAIT_MS });
    if (!finished.ok) return finished;
    const { files, userSelectionRestored } = ExportFinishSchema.parse(finished.result);
    // The MCP server opens any ZIP and keeps only plan.onlyFormat, so every file goes along as is.
    const base = { identity: plan.identity, onlyFormat: plan.onlyFormat, usedExistingSettings: !plan.temporary, userSelectionRestored };
    if (files.length > 0) {
      return { ok: true, result: { ...base, source: "direct", files: files.map((f) => ({ ...f, downloadPath: null })), elapsedMs: Date.now() - started } };
    }
    for (let waited = 0; downloads.length === 0 && waited < 3_000; waited += 200) await delay(200);
    if (downloads.length === 0) {
      return { ok: false, error: { code: "EXPORT_BLOCKED", message: "Figma produced no file that Figloo could receive, and the browser started no download" } };
    }
    const items = await Promise.all(downloads.map((id) => waitForDownload(id, EXPORT_DOWNLOAD_WAIT_MS)));
    if (items.some((item) => !item || item.state === "in_progress")) {
      return { ok: false, error: { code: "EXPORT_PENDING", message: "the browser is still waiting to save the export, possibly for a confirmation" } };
    }
    const saved = items.filter((item): item is chrome.downloads.DownloadItem => item?.state === "complete" && item.filename.length > 0);
    if (saved.length === 0) return { ok: false, error: { code: "EXPORT_BLOCKED", message: "the browser did not complete the export download" } };
    return {
      ok: true,
      result: {
        ...base,
        source: "download",
        files: saved.map((item) => ({ name: item.filename.split("/").pop() ?? item.filename, mimeType: item.mime, data: null, downloadPath: item.filename })),
        elapsedMs: Date.now() - started,
      },
    };
  } catch (error) {
    await sendToTab(tabId, "finish_export", { token, expected: 0, waitMs: 0 });
    return { ok: false, error: { code: "INTERNAL", message: `export failed: ${error instanceof Error ? error.message : String(error)}` } };
  } finally {
    chrome.downloads.onCreated.removeListener(onCreated);
    await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: removeExportCapture, args: [token] }).catch(() => undefined);
  }
}

async function waitForDownload(id: number, timeoutMs: number): Promise<chrome.downloads.DownloadItem | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [item] = await chrome.downloads.search({ id });
    if (!item || item.state !== "in_progress" || Date.now() >= deadline) return item;
    await delay(200);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendToTab(tabId: number, op: string, params: unknown): Promise<TabOpResponse> {
  try {
    return TabOpResponseSchema.parse(await chrome.tabs.sendMessage(tabId, { type: "figloo:op", op, params }));
  } catch {
    return { ok: false, error: { code: "UI_NOT_READY", message: "the Figloo content script is not running in this tab; reload the tab" } };
  }
}

/**
 * The tab moves its view to the target and clears the selection; the worker captures what is on
 * screen, crops it to the target, and the tab then puts the user's selection back.
 */
async function captureTab(tabId: number, params: unknown): Promise<TabOpResponse> {
  return (await takeCapture(tabId, params)).response;
}

/** A capture, and whether the user stepped in before their selection could be put back. */
async function takeCapture(tabId: number, params: unknown): Promise<{ response: TabOpResponse; interrupted: boolean }> {
  const started = Date.now();
  // Read the tab again: it may have changed while this request waited in the queue.
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const window = tab ? await chrome.windows.get(tab.windowId).catch(() => null) : null;
  if (!tab || !tab.active || !window || window.state === "minimized") {
    return { response: { ok: false, error: { code: "TAB_IN_BACKGROUND", message: "the Figma tab must be the visible tab of its window to capture it" } }, interrupted: false };
  }
  const prepared = await sendToTab(tabId, "prepare_capture", params);
  if (!prepared.ok) return { response: prepared, interrupted: false };
  const plan = CapturePlanSchema.parse(prepared.result);
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const { crop, ...image } = await cropCapture(dataUrl, plan.crop, plan.viewport);
    const finished = await sendToTab(tabId, "finish_capture", { token: plan.token });
    const done = finished.ok ? (finished.result as { userSelectionRestored?: boolean; interrupted?: boolean } | undefined) : undefined;
    const result: CaptureResult = {
      identity: plan.identity,
      image: { ...image, mimeType: "image/jpeg" },
      crop,
      cropSource: plan.cropSource,
      zoom: plan.zoom,
      userSelectionRestored: done?.userSelectionRestored === true,
      elapsedMs: Date.now() - started,
    };
    return { response: { ok: true, result }, interrupted: done?.interrupted === true };
  } catch (error) {
    await sendToTab(tabId, "finish_capture", { token: plan.token });
    return { response: { ok: false, error: { code: "INTERNAL", message: `capture failed: ${error instanceof Error ? error.message : String(error)}` } }, interrupted: false };
  }
}

/**
 * Kept back from a snapshot's time budget: when reading runs out of time, the tab still closes what
 * it opened and puts the selection back, which took about 5 s in Arc, and the reply has to arrive.
 */
const SNAPSHOT_CLEANUP_MS = 15_000;

/**
 * Captures the root zoomed to fit the screen, then has the tab read every layer below it without
 * moving the view, so each layer's place on screen can be found in the screenshot.
 */
async function snapshotTab(tabId: number, params: unknown): Promise<TabOpResponse> {
  const started = Date.now();
  const { expect, ref } = SnapshotParamsSchema.parse(params);
  const shot = await takeCapture(tabId, { expect, ref });
  if (!shot.response.ok) return shot.response;
  if (shot.interrupted) return { ok: false, error: { code: "USER_INTERRUPTED", message: "the user interacted with Figma during the screenshot" } };
  const { image, crop } = shot.response.result as CaptureResult;
  const timeBudgetMs = Math.round(SNAPSHOT_TIME_BUDGET_MS - SNAPSHOT_CLEANUP_MS - (Date.now() - started));
  if (timeBudgetMs <= 0) return { ok: false, error: { code: "BUDGET_EXCEEDED", message: "the screenshot used up the snapshot's time budget" } };
  const read = await sendToTab(tabId, "read_subtree", { expect, ref, maxLayers: MAX_SNAPSHOT_LAYERS, timeBudgetMs });
  if (!read.ok) return read;
  const result = SnapshotReadResultSchema.parse(read.result);
  const elapsedMs = Date.now() - started;
  if (result.status === "too_large") return { ok: true, result: { ...result, elapsedMs } };
  const rootInImage = result.rootOnScreen ? placeInImage(result.rootOnScreen, crop, image) : null;
  // The read measures the root where the screenshot was taken; a root outside the image means the view moved in between.
  if (rootInImage && !insideImage(rootInImage, image)) {
    return { ok: false, error: { code: "UI_NOT_READY", message: "the screenshot does not show the whole root, so the view moved while it was taken; take the snapshot again" } };
  }
  return {
    ok: true,
    result: {
      ...result,
      image,
      crop,
      rootInImage,
      imageScale: result.zoom ? (image.width / crop.width) * result.zoom : null,
      elapsedMs,
    },
  };
}

function startHeartbeat(intervalMs: number): void {
  stopHeartbeat();
  // Regular traffic also keeps the service worker alive (Chrome 116+ extends its lifetime on WebSocket activity).
  heartbeatTimer = setInterval(() => send({ type: "ping", t: Date.now() }), intervalMs);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function listDesignTabs(): Promise<chrome.tabs.Tab[]> {
  return chrome.tabs.query({ url: FIGMA_DESIGN_URLS });
}

async function probeTab(tab: chrome.tabs.Tab): Promise<TabStatus> {
  const tabId = tab.id ?? -1;
  const url = tab.url ?? "";
  const parsed = parseFigmaUrl(url);
  let probe: ProbeResult | null = null;
  try {
    const response: unknown = await withTimeout(chrome.tabs.sendMessage(tabId, { type: "figloo:probe" }), PROBE_TIMEOUT_MS);
    probe = ProbeResultSchema.parse(response);
    unreachableProbes.delete(tabId);
  } catch {
    unreachableProbes.set(tabId, (unreachableProbes.get(tabId) ?? 0) + 1);
  }
  const { readiness, detail } = deriveReadiness(probe, unreachableProbes.get(tabId) ?? 0);
  return {
    tabId,
    windowId: tab.windowId,
    url,
    title: tab.title ?? "",
    fileKey: parsed.fileKey,
    fileName: probe?.fileName ?? parsed.fileName,
    nodeIdFromUrl: parsed.nodeId,
    readiness,
    access: probe?.access ?? "unknown",
    uiLocale: probe?.uiLocale ?? null,
    capabilities: probe?.capabilities ?? { layersPanel: false, focusTarget: false, propertiesPanel: false, mirrorDom: false, uiCollapsed: false },
    layerRowCount: probe?.layerRowCount ?? 0,
    visible: probe?.visible ?? null,
    probedAt: probe ? Date.now() : null,
    detail,
  };
}

async function refreshAllTabs(): Promise<TabStatus[]> {
  const list = (await listDesignTabs()).filter((tab) => tab.id !== undefined);
  const statuses = await Promise.all(list.map(probeTab));
  const previous = [...tabs.keys()];
  tabs.clear();
  for (const status of statuses) tabs.set(status.tabId, status);
  state.tabCount = statuses.length;
  // Chrome keeps per-tab icons across navigations until the tab closes, so reset tabs that left.
  for (const tabId of previous) if (!tabs.has(tabId)) applyAction(tabId, null);
  for (const status of statuses) applyAction(status.tabId, status);
  return statuses;
}

function setPhase(phase: ConnectionState["phase"]): void {
  const agentChanged = agentLine(phase) !== agentLine(state.phase);
  state.phase = phase;
  // Every tracked tab's tooltip mentions the agent connection, so refresh them when that changes.
  if (agentChanged) for (const status of tabs.values()) applyAction(status.tabId, status);
}

/** Shows on the toolbar icon whether Figloo can use the page in this tab; null restores the default. */
function applyAction(tabId: number, status: TabStatus | null): void {
  applyAppearance(tabId, actionAppearance(status, state.phase)).catch((error: unknown) => {
    // The tab may have closed in the meantime; anything else is worth seeing in the worker console.
    if (!/No tab with id/.test(String(error))) console.warn("Figloo: cannot update the toolbar icon", error);
  });
}

function forgetTab(tabId: number): void {
  const tracked = tabs.delete(tabId);
  unreachableProbes.delete(tabId);
  applyAction(tabId, null);
  if (!tracked) return;
  state.tabCount = tabs.size;
  pushTabs();
}

function pushTabs(): void {
  send({ type: "tabs", tabs: [...tabs.values()] });
}

function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshAllTabs().then(pushTabs);
  }, REFRESH_DEBOUNCE_MS);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function injectIntoOpenTabs(): Promise<void> {
  const list = await listDesignTabs();
  await Promise.all(
    list.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      } catch {
        // Discarded or restricted tabs cannot be injected; they will be probed again after a reload.
      }
    }),
  );
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" && changeInfo.url === undefined) return;
  if (parseFigmaUrl(tab.url ?? "").isDesignFile) {
    scheduleRefresh();
    return;
  }
  // Chrome keeps per-tab icons across navigations until the tab closes, so a tab that left its
  // design file is reset here. This worker may have restarted since it changed the icon, so for
  // untracked tabs Chrome's own per-tab title tells whether anything needs resetting.
  if (tabs.has(tabId)) {
    forgetTab(tabId);
    return;
  }
  chrome.action
    .getTitle({ tabId })
    .then((title) => {
      if (title !== DEFAULT_TITLE) applyAction(tabId, null);
    })
    .catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!tabs.delete(tabId)) return;
  unreachableProbes.delete(tabId);
  state.tabCount = tabs.size;
  pushTabs();
});

chrome.runtime.onInstalled.addListener(() => {
  void injectIntoOpenTabs().then(scheduleRefresh);
  void chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
  void connect();
});

chrome.runtime.onStartup.addListener(() => {
  void connect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM && state.phase !== "connected") void connect();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.token || changes.port)) reconnectNow();
});

/** Ancestors read for the popup's path, the most one request returns. */
const POPUP_ANCESTORS = 50;

/**
 * What the toolbar popup shows for a tab: the tab's readiness, the agent connection, and the
 * selected layer with its path and children. Reads go through the tab's queue like agent requests.
 */
async function popupSnapshot(tabId: number | undefined): Promise<PopupSnapshot> {
  const snapshot: PopupSnapshot = { connection: { ...state }, tab: null, page: null, selection: null, selectionError: null };
  const tab = tabId === undefined ? null : await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.id === undefined || !parseFigmaUrl(tab.url ?? "").isDesignFile) return snapshot;
  const id = tab.id;
  snapshot.tab = await probeTab(tab);
  if (snapshot.tab.readiness !== "READY" && snapshot.tab.readiness !== "DEGRADED") return snapshot;
  const pages = await runInTab(id, "list_pages", undefined);
  if (pages.ok) snapshot.page = ListPagesResultSchema.parse(pages.result).pages.find((page) => page.current)?.name ?? null;
  const anchored = await runInTab(id, "get_anchor", undefined);
  if (!anchored.ok) {
    snapshot.selectionError = anchored.error ?? { code: "INTERNAL", message: "the Figma tab did not report its selection" };
    return snapshot;
  }
  const { identity, anchor, anchors, selectionCount } = AnchorResultSchema.parse(anchored.result);
  if (anchors.length > 1) {
    // Several selected layers are listed as they are; reading each one's path would expand too much.
    snapshot.selection = { anchor, anchors, selectionCount, ancestors: [], children: [], childrenTotal: null, childrenHasMore: false };
    return snapshot;
  }
  const list = async (relation: "ancestors" | "children", limit: number) => {
    const reply = await runInTab(id, "list_neighbors", { expect: identity, ref: anchor.ref, relation, from: 1, limit });
    return reply.ok ? NeighborsResultSchema.parse(reply.result) : null;
  };
  const ancestors = await list("ancestors", POPUP_ANCESTORS);
  const children = anchor.hasChildren ? await list("children", POPUP_CHILDREN) : null;
  snapshot.selection = {
    anchor,
    anchors,
    selectionCount,
    ancestors: ancestors?.nodes ?? [],
    children: children?.nodes ?? [],
    childrenTotal: anchor.hasChildren ? (children?.total ?? null) : 0,
    childrenHasMore: children?.hasMore ?? false,
  };
  return snapshot;
}

chrome.runtime.onMessage.addListener((message: { type?: string; tabId?: number } | undefined, _sender, sendResponse) => {
  if (message?.type === "figloo:popup") {
    popupSnapshot(message.tabId).then(sendResponse, (error: unknown) => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
    // Keeps the message channel open for the asynchronous reply.
    return true;
  }
  if (message?.type === "figloo:status") {
    sendResponse(state);
    return;
  }
  if (message?.type === "figloo:reconnect") {
    reconnectNow();
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === "figloo:page-changed") {
    scheduleRefresh();
    sendResponse({ ok: true });
  }
});

void connect();
