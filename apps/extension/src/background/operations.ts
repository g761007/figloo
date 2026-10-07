import { CaptureParamsSchema, ExplorePageParamsSchema, ExportRequestSchema, InspectParamsSchema, ListNeighborsParamsSchema, SnapshotParamsSchema, VisualNeighborsParamsSchema, type TabOpResponse } from "@figloo/protocol";
import { MAX_RECENT_ERRORS, type RecentError } from "../diagnostics.js";
import { parseFigmaUrl } from "../figma-url.js";
import { send } from "./connection.js";
import { captureTab, exportTab, sendToTab, snapshotTab } from "./delivery.js";
import { refreshAllTabs, tabs } from "./tabs.js";

/** The last ops that failed, by code, for diagnostics. */
export const recentErrors: RecentError[] = [];

export async function handleRequest(id: string, op: string, tabId?: number, params?: Record<string, unknown>): Promise<void> {
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
        if (!reply.ok) recordError(op, reply.error?.code ?? "INTERNAL");
        send(reply.ok ? { type: "response", id, ok: true, result: reply.result } : { type: "response", id, ok: false, error: reply.error });
        return;
      }
      default:
        send({ type: "response", id, ok: false, error: { code: "BAD_MESSAGE", message: `unsupported op ${op}` } });
    }
  } catch (error) {
    recordError(op, "INTERNAL");
    send({ type: "response", id, ok: false, error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) } });
  }
}

function recordError(op: string, code: string): void {
  recentErrors.push({ op, code, at: Date.now() });
  recentErrors.splice(0, Math.max(0, recentErrors.length - MAX_RECENT_ERRORS));
}

const tabQueues = new Map<number, Promise<unknown>>();
/** Tabs with a snapshot queued or running; a snapshot takes minutes, so other ops do not wait behind it. */
export const snapshotting = new Set<number>();

/** Forwards an op to the tab's content script; each tab runs one UI operation sequence at a time. */
export async function runInTab(tabId: number | undefined, op: string, params: unknown): Promise<TabOpResponse> {
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
