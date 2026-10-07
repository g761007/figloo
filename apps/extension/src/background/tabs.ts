import { ProbeResultSchema, type ProbeResult, type TabStatus } from "@figloo/protocol";
import { actionAppearance, applyAppearance } from "../action.js";
import { parseFigmaUrl } from "../figma-url.js";
import { deriveReadiness } from "../readiness.js";
import { send, state } from "./connection.js";

const FIGMA_DESIGN_URLS = ["https://www.figma.com/design/*", "https://www.figma.com/file/*"];
const PROBE_TIMEOUT_MS = 3_000;
const REFRESH_DEBOUNCE_MS = 500;

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
export const tabs = new Map<number, TabStatus>();
export const unreachableProbes = new Map<number, number>();

async function listDesignTabs(): Promise<chrome.tabs.Tab[]> {
  return chrome.tabs.query({ url: FIGMA_DESIGN_URLS });
}

export async function probeTab(tab: chrome.tabs.Tab): Promise<TabStatus> {
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

export async function refreshAllTabs(): Promise<TabStatus[]> {
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

/** Shows on the toolbar icon whether Figloo can use the page in this tab; null restores the default. */
export function applyAction(tabId: number, status: TabStatus | null): void {
  applyAppearance(tabId, actionAppearance(status, state)).catch((error: unknown) => {
    // The tab may have closed in the meantime; anything else is worth seeing in the worker console.
    if (!/No tab with id/.test(String(error))) console.warn("Figloo: cannot update the toolbar icon", error);
  });
}

export function forgetTab(tabId: number): void {
  const tracked = tabs.delete(tabId);
  unreachableProbes.delete(tabId);
  applyAction(tabId, null);
  if (!tracked) return;
  state.tabCount = tabs.size;
  pushTabs();
}

export function pushTabs(): void {
  send({ type: "tabs", tabs: [...tabs.values()] });
}

export function scheduleRefresh(): void {
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

export async function injectIntoOpenTabs(): Promise<void> {
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
