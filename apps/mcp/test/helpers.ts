import { WebSocket } from "ws";
import { EXTENSION_ID, PROTOCOL_VERSION, type ExtensionMessage, type ServerMessage, type TabStatus, type WelcomeMessage } from "@figloo/protocol";
import { Bridge } from "../src/bridge.js";

export const TOKEN = "test-token";

export function startBridge(overrides: Partial<ConstructorParameters<typeof Bridge>[0]> = {}): Promise<Bridge> {
  const bridge = new Bridge({ port: 0, token: TOKEN, allowedExtensionIds: [EXTENSION_ID], serverVersion: "test", project: "test", log: () => {}, ...overrides });
  return bridge.start().then(() => bridge);
}

export interface FakeExtension {
  ws: WebSocket;
  messages: ServerMessage[];
  next: (predicate?: (message: ServerMessage) => boolean) => Promise<ServerMessage>;
  send: (message: ExtensionMessage) => void;
  closed: Promise<{ code: number; reason: string }>;
}

/** Opens a raw WebSocket the way the extension would, without sending hello. */
export function openFakeExtension(port: number, origin = `chrome-extension://${EXTENSION_ID}`): Promise<FakeExtension> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { origin } });
    const messages: ServerMessage[] = [];
    const waiters: Array<{ predicate: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      messages.push(message);
      const index = waiters.findIndex((w) => w.predicate(message));
      if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
    });
    const closed = new Promise<{ code: number; reason: string }>((resolveClosed) => {
      ws.on("close", (code, reason) => resolveClosed({ code, reason: reason.toString() }));
    });
    ws.on("unexpected-response", (_req, res) => reject(new Error(`unexpected response ${res.statusCode}`)));
    ws.on("error", reject);
    ws.on("open", () =>
      resolve({
        ws,
        messages,
        next: (predicate = () => true) => {
          const existing = messages.find(predicate);
          if (existing) return Promise.resolve(existing);
          return new Promise((resolveNext) => waiters.push({ predicate, resolve: resolveNext }));
        },
        send: (message) => ws.send(JSON.stringify(message)),
        closed,
      }),
    );
  });
}

export function hello(overrides: Partial<Extract<ExtensionMessage, { type: "hello" }>> = {}): ExtensionMessage {
  return { type: "hello", protocolVersion: PROTOCOL_VERSION, token: TOKEN, extensionVersion: "0.0.1", userAgent: "fake", ...overrides };
}

/** Connects and completes the handshake, resolving once welcome arrived. */
export async function pairFakeExtension(port: number): Promise<FakeExtension> {
  const ext = await openFakeExtension(port);
  ext.send(hello());
  await ext.next((m) => m.type === "welcome");
  return ext;
}

export interface ReconnectingExtension {
  /** Close codes of every connection that ended, in order. */
  closes: number[];
  welcomes: WelcomeMessage[];
  stop: () => void;
}

/**
 * Keeps a paired connection to `port` the way the extension does, reconnecting 50 ms after
 * any close, and answers each request with `answer` (by default an empty tab list).
 */
export function runReconnectingExtension(port: number, answer: (op: string) => unknown = () => ({ tabs: [] })): ReconnectingExtension {
  const closes: number[] = [];
  const welcomes: WelcomeMessage[] = [];
  let stopped = false;
  let ws: WebSocket;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { origin: `chrome-extension://${EXTENSION_ID}` } });
    ws.on("open", () => ws.send(JSON.stringify(hello())));
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      if (message.type === "welcome") welcomes.push(message);
      if (message.type === "request") {
        const socket = ws;
        void Promise.resolve(answer(message.op)).then((result) => socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result })));
      }
    });
    ws.on("error", () => {});
    ws.on("close", (code) => {
      closes.push(code);
      if (!stopped) reconnect = setTimeout(connect, 50);
    });
  };
  connect();
  return {
    closes,
    welcomes,
    stop: () => {
      stopped = true;
      // A reconnect still pending would otherwise reach whatever listens on the port next.
      clearTimeout(reconnect);
      ws.close();
    },
  };
}

export function sampleTab(overrides: Partial<TabStatus> = {}): TabStatus {
  return {
    tabId: 7,
    windowId: 1,
    url: "https://www.figma.com/design/abc/Name?node-id=1-2",
    title: "Name – Figma",
    fileKey: "abc",
    fileName: "Name",
    nodeIdFromUrl: "1:2",
    readiness: "READY",
    access: "view",
    uiLocale: "en",
    capabilities: { layersPanel: true, focusTarget: true, propertiesPanel: true, mirrorDom: true, uiCollapsed: false },
    layerRowCount: 42,
    visible: true,
    probedAt: 1,
    detail: null,
    ...overrides,
  };
}
