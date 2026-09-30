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

function onMessage(message: { type?: string } | undefined, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void): void {
  if (message?.type === "figloo:probe") sendResponse(probeFigmaPage(document, window));
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
