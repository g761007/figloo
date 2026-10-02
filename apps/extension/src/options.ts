import { formatState } from "./options-model.js";
import { DEFAULT_PORT, type ConnectionState } from "./state.js";

const form = document.querySelector<HTMLFormElement>("#pairing-form")!;
const tokenInput = document.querySelector<HTMLInputElement>("#token")!;
const portInput = document.querySelector<HTMLInputElement>("#port")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;

async function loadSaved(): Promise<void> {
  const stored = await chrome.storage.local.get(["token", "port"]);
  if (typeof stored.token === "string") tokenInput.value = stored.token;
  portInput.value = String(Number(stored.port) || DEFAULT_PORT);
}

async function refreshStatus(): Promise<void> {
  try {
    const state = (await chrome.runtime.sendMessage({ type: "figloo:status" })) as ConnectionState;
    statusEl.textContent = formatState(state);
  } catch (error) {
    statusEl.textContent = `Cannot reach the service worker: ${String(error)}`;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void chrome.storage.local
    .set({ token: tokenInput.value.trim(), port: Number(portInput.value) || DEFAULT_PORT })
    .then(() => new Promise((r) => setTimeout(r, 300)))
    .then(refreshStatus);
});

document.querySelector<HTMLButtonElement>("#reconnect")!.addEventListener("click", () => {
  void chrome.runtime
    .sendMessage({ type: "figloo:reconnect" })
    .then(() => new Promise((r) => setTimeout(r, 300)))
    .then(refreshStatus);
});

void loadSaved();
void refreshStatus();
setInterval(() => void refreshStatus(), 2_000);
