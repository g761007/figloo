import { buildDiagnostics, formatDiagnostics, type Diagnostics } from "./diagnostics.js";
import type { PopupSnapshot } from "./popup-model.js";
import { renderDiagnostics, renderPopup } from "./popup-view.js";

const root = document.querySelector<HTMLElement>("#app")!;

/** The toolbar opens this page for the active tab; `?tabId=` opens it for another tab, as the end-to-end test does. */
async function targetTab(): Promise<number | undefined> {
  const requested = Number(new URLSearchParams(location.search).get("tabId"));
  if (Number.isInteger(requested) && requested > 0) return requested;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

document.querySelector<HTMLButtonElement>("#settings")!.addEventListener("click", () => void chrome.runtime.openOptionsPage());

const diagnosticsPanel = document.querySelector<HTMLElement>("#diagnostics-panel")!;

/** Opens or closes the diagnostics; they work even when the service worker does not answer. */
async function toggleDiagnostics(): Promise<void> {
  if (!diagnosticsPanel.hidden) {
    diagnosticsPanel.hidden = true;
    return;
  }
  let data: Diagnostics;
  try {
    const reply = (await chrome.runtime.sendMessage({ type: "figloo:diagnostics", tabId: await targetTab() })) as Diagnostics | { error: string };
    if ("error" in reply) throw new Error(reply.error);
    data = reply;
  } catch {
    data = buildDiagnostics({ extensionVersion: chrome.runtime.getManifest().version, userAgent: navigator.userAgent });
  }
  renderDiagnostics(diagnosticsPanel, formatDiagnostics(data, Date.now()), { copy });
  diagnosticsPanel.hidden = false;
}

document.querySelector<HTMLButtonElement>("#diagnostics")!.addEventListener("click", () => void toggleDiagnostics());

try {
  const reply = (await chrome.runtime.sendMessage({ type: "figloo:popup", tabId: await targetTab() })) as PopupSnapshot | { error: string };
  if ("error" in reply) throw new Error(reply.error);
  renderPopup(root, reply, { copy });
} catch (error) {
  root.replaceChildren();
  const message = document.createElement("p");
  message.textContent = `Cannot reach the Figloo service worker: ${error instanceof Error ? error.message : String(error)}`;
  root.append(message);
}
