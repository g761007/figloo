import { HANDED_OVER_CLOSE_CODE, PROTOCOL_VERSION, ServerMessageSchema, type ExtensionMessage, type SessionIdentity } from "@figloo/protocol";
import { agentLine } from "../action.js";
import { DEFAULT_PORT, type ConnectionState } from "../state.js";
import { handleRequest } from "./operations.js";
import { applyAction, pushTabs, refreshAllTabs, tabs } from "./tabs.js";

export const RECONNECT_ALARM = "figloo-reconnect";
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const REJECTED_RETRY_MS = 60_000;
/** The session that took over listens within moments, and its tool call is waiting for this extension. */
const HANDOVER_RETRY_MS = 200;

interface Settings {
  token: string;
  port: number;
}

export const state: ConnectionState = {
  phase: "disconnected",
  port: null,
  connectedAt: null,
  lastError: null,
  attempts: 0,
  tabCount: 0,
  session: null,
  lastHandoverAt: null,
};
let socket: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** Versions from the connected server's welcome, for diagnostics. */
export const server: { version: string | null; protocolVersion: string | null } = { version: null, protocolVersion: null };
let connectPending = false;

async function loadSettings(): Promise<Settings | null> {
  const stored = await chrome.storage.local.get(["token", "port"]);
  const token = typeof stored.token === "string" ? stored.token.trim() : "";
  if (!token) return null;
  return { token, port: Number(stored.port) || DEFAULT_PORT };
}

export async function connect(): Promise<void> {
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
    server.version = null;
    server.protocolVersion = null;
    const wasConnected = state.phase === "connected";
    setPhase("disconnected");
    state.connectedAt = null;
    if (event.code === HANDED_OVER_CLOSE_CODE) {
      state.lastHandoverAt = Date.now();
      scheduleReconnect(HANDOVER_RETRY_MS);
      return;
    }
    // The bridge's error message, such as which side to update, says more than the close reason.
    if (event.code >= 4000 && event.reason && !state.lastError?.startsWith(`${event.reason}:`)) state.lastError = `${event.code} ${event.reason}`;
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

export function reconnectNow(): void {
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

export function send(message: ExtensionMessage): void {
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
      setPhase("connected", message.session ?? null);
      server.version = message.serverVersion;
      server.protocolVersion = message.protocolVersion;
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

function startHeartbeat(intervalMs: number): void {
  stopHeartbeat();
  // Regular traffic also keeps the service worker alive (Chrome 116+ extends its lifetime on WebSocket activity).
  heartbeatTimer = setInterval(() => send({ type: "ping", t: Date.now() }), intervalMs);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

/** `session` is the server's, from its welcome; any other phase has none. */
function setPhase(phase: ConnectionState["phase"], session: SessionIdentity | null = null): void {
  const agentChanged = agentLine({ phase, session }) !== agentLine(state);
  state.phase = phase;
  state.session = session;
  // Every tracked tab's tooltip mentions the agent connection, so refresh them when that changes.
  if (agentChanged) for (const status of tabs.values()) applyAction(status.tabId, status);
}
