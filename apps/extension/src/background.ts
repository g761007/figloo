import { AnchorResultSchema, EXTENSION_ID, ListPagesResultSchema, NeighborsResultSchema, PROTOCOL_VERSION } from "@figloo/protocol";
import { DEFAULT_TITLE } from "./action.js";
import { buildDiagnostics, type Diagnostics } from "./diagnostics.js";
import { parseFigmaUrl } from "./figma-url.js";
import { POPUP_CHILDREN, type PopupSnapshot } from "./popup-model.js";
import { RECONNECT_ALARM, connect, reconnectNow, server, state } from "./background/connection.js";
import { recentErrors, runInTab, snapshotting } from "./background/operations.js";
import { applyAction, forgetTab, injectIntoOpenTabs, probeTab, pushTabs, scheduleRefresh, tabs, unreachableProbes } from "./background/tabs.js";

/** What the popup's diagnostics show for a tab; buildDiagnostics keeps only fields that hold no design content. */
async function diagnostics(tabId: number | undefined): Promise<Diagnostics> {
  const tab = tabId === undefined ? null : await chrome.tabs.get(tabId).catch(() => null);
  const status = tab?.id !== undefined && parseFigmaUrl(tab.url ?? "").isDesignFile ? await probeTab(tab) : null;
  return buildDiagnostics({
    extensionVersion: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    protocolVersion: PROTOCOL_VERSION,
    pinnedId: chrome.runtime.id === EXTENSION_ID,
    state,
    server,
    tab: status,
    designTabs: tabs.size,
    snapshotRunning: tabId !== undefined && snapshotting.has(tabId),
    recentErrors,
  });
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
  if (message?.type === "figloo:diagnostics") {
    diagnostics(message.tabId).then(sendResponse, (error: unknown) => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
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
