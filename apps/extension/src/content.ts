import type { CaptureParams, ExplorePageParams, ExportParams, InspectParams, ListNeighborsParams } from "@figloo/protocol";
import { Explorer, OpError } from "./adapter/ops.js";
import { probeFigmaPage } from "./probe.js";
import { deriveReadiness } from "./readiness.js";

declare global {
  interface Window {
    __figlooStop?: () => void;
  }
}

/** How often the page is checked for changes that affect what Figloo can do in it. */
const WATCH_INTERVAL_MS = 1_000;

// The service worker may inject this file into a tab that already runs it (for example right
// after install), so an earlier copy in this isolated world is stopped first.
window.__figlooStop?.();

let lastReadiness = "";

/** A new ID per page load: contexts created before a reload or re-injection must not match. */
const explorer = new Explorer(crypto.randomUUID(), document, window);

interface OpMessage {
  type: "figloo:op";
  op: string;
  params?: unknown;
}

function onMessage(message: { type?: string } | undefined, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void): boolean | undefined {
  if (message?.type === "figloo:probe") {
    sendResponse(probeFigmaPage(document, window));
    return undefined;
  }
  if (message?.type === "figloo:op") {
    void runOp(message as OpMessage).then(sendResponse);
    return true; // Responds asynchronously.
  }
  return undefined;
}

async function runOp(message: OpMessage): Promise<unknown> {
  try {
    switch (message.op) {
      case "get_anchor":
        return { ok: true, result: await explorer.getAnchor() };
      // The service worker validated the params; keeping zod out of this script keeps it small.
      case "list_neighbors":
        return { ok: true, result: await explorer.listNeighbors(message.params as ListNeighborsParams) };
      case "list_pages":
        return { ok: true, result: explorer.listPages() };
      case "explore_page":
        return { ok: true, result: await explorer.explorePage(message.params as ExplorePageParams) };
      case "inspect_nodes":
        return { ok: true, result: await explorer.inspectNodes(message.params as InspectParams) };
      case "prepare_capture":
        return { ok: true, result: await explorer.prepareCapture(message.params as CaptureParams) };
      case "finish_capture":
        return { ok: true, result: await explorer.finishCapture((message.params as { token: string }).token) };
      case "prepare_export":
        return { ok: true, result: await explorer.prepareExport(message.params as ExportParams) };
      case "finish_export": {
        const { token, expected, waitMs } = message.params as { token: string; expected: number; waitMs: number };
        return { ok: true, result: await explorer.finishExport(token, expected, waitMs) };
      }
      default:
        return { ok: false, error: { code: "BAD_MESSAGE", message: `unsupported op ${message.op}` } };
    }
  } catch (error) {
    if (error instanceof OpError) return { ok: false, error: { code: error.code, message: error.message } };
    return { ok: false, error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) } };
  }
}

/** Tells the service worker when this page's readiness changes, so the toolbar icon can follow. */
function watch(): void {
  if (!chrome.runtime?.id) {
    // The extension was reloaded or removed, so this copy is orphaned.
    stop();
    return;
  }
  const { readiness, detail } = deriveReadiness(probeFigmaPage(document, window), 0);
  const current = `${readiness}|${detail ?? ""}`;
  if (current === lastReadiness) return;
  lastReadiness = current;
  try {
    chrome.runtime.sendMessage({ type: "figloo:page-changed" }).catch(() => {
      lastReadiness = ""; // Retry on the next tick.
    });
  } catch {
    stop();
  }
}

const timer = setInterval(watch, WATCH_INTERVAL_MS);

function stop(): void {
  clearInterval(timer);
  try {
    chrome.runtime.onMessage.removeListener(onMessage);
  } catch {
    // The runtime of an orphaned copy is already gone.
  }
  if (window.__figlooStop === stop) delete window.__figlooStop;
}

chrome.runtime.onMessage.addListener(onMessage);
window.__figlooStop = stop;
watch();
