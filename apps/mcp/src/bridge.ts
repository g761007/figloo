import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  ExtensionMessageSchema,
  PROTOCOL_VERSION,
  protocolCompatible,
  type BridgeErrorCode,
  type BridgeOp,
  type ErrorCode,
  type ServerMessage,
  type TabStatus,
} from "@figloo/protocol";

export interface BridgeOptions {
  port: number;
  token: string;
  allowedExtensionIds: string[];
  serverVersion: string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface ExtensionInfo {
  extensionVersion: string;
  userAgent: string;
  connectedAt: number;
}

export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode | ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const HANDSHAKE_TIMEOUT_MS = 5_000;

/**
 * Loopback WebSocket endpoint the extension connects to. Exactly one authenticated
 * extension connection is kept; a newer valid handshake replaces the previous one.
 */
export class Bridge {
  port: number;
  listening = false;
  listenError: string | null = null;
  lastDisconnectAt: number | null = null;
  lastError: string | null = null;

  private readonly options: BridgeOptions & Required<Pick<BridgeOptions, "heartbeatIntervalMs" | "heartbeatTimeoutMs" | "log">>;
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private info: ExtensionInfo | null = null;
  private tabs: TabStatus[] = [];
  private tabsUpdatedAt: number | null = null;
  private lastSeen = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, Pending>();

  constructor(options: BridgeOptions) {
    this.options = {
      heartbeatIntervalMs: 20_000,
      heartbeatTimeoutMs: 45_000,
      log: (message) => console.error(`[figloo] ${message}`),
      ...options,
    };
    this.port = options.port;
  }

  get connected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN && this.info !== null;
  }

  get extension(): ExtensionInfo | null {
    return this.info;
  }

  getTabs(): { tabs: TabStatus[]; updatedAt: number | null } {
    return { tabs: this.tabs, updatedAt: this.tabsUpdatedAt };
  }

  /** Starts listening. A port conflict is recorded in `listenError` instead of thrown. */
  start(): Promise<void> {
    return new Promise((resolve) => {
      const http = createServer((_req, res: ServerResponse) => {
        res.statusCode = 404;
        res.end();
      });
      const wss = new WebSocketServer({ noServer: true });
      http.on("upgrade", (req, socket, head) => this.handleUpgrade(wss, req, socket, head));
      http.on("error", (error: NodeJS.ErrnoException) => {
        this.listenError = error.code === "EADDRINUSE" ? `port ${this.port} is already in use by another process` : error.message;
        this.listening = false;
        this.options.log(`bridge cannot listen: ${this.listenError}`);
        resolve();
      });
      http.listen(this.port, "127.0.0.1", () => {
        this.port = (http.address() as AddressInfo).port;
        this.listening = true;
        this.listenError = null;
        this.options.log(`bridge listening on ws://127.0.0.1:${this.port}`);
        resolve();
      });
      this.http = http;
      this.wss = wss;
    });
  }

  async stop(): Promise<void> {
    this.stopHeartbeat();
    this.client?.close(1001, "server shutting down");
    this.wss?.close();
    await new Promise<void>((resolve) => {
      if (!this.http) return resolve();
      this.http.close(() => resolve());
      this.http.closeAllConnections();
    });
    this.listening = false;
  }

  /** Sends a request to the extension and resolves with its `result`. */
  request(op: BridgeOp, params?: Record<string, unknown>, timeoutMs = 3_000, tabId?: number): Promise<unknown> {
    if (!this.connected) return Promise.reject(new BridgeError("NOT_CONNECTED", "extension is not connected"));
    const id = randomUUID();
    const message: ServerMessage = { type: "request", id, op, ...(tabId !== undefined ? { tabId } : {}), ...(params ? { params } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError("TIMEOUT", `${op} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send(message);
    });
  }

  private handleUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const origin = req.headers.origin ?? "";
    const allowed = this.options.allowedExtensionIds.some((id) => origin === `chrome-extension://${id}`);
    if (!allowed) {
      this.options.log(`rejected connection from origin "${origin}"`);
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => this.handleConnection(ws));
  }

  private handleConnection(ws: WebSocket): void {
    let authenticated = false;
    const handshakeTimer = setTimeout(() => {
      if (!authenticated) this.fail(ws, "UNAUTHORIZED", "no hello within the handshake timeout", 4008);
    }, HANDSHAKE_TIMEOUT_MS);

    ws.on("message", (data) => {
      let json: unknown;
      try {
        json = JSON.parse(data.toString());
      } catch {
        this.fail(ws, "BAD_MESSAGE", "message is not JSON", 4002);
        return;
      }
      const parsed = ExtensionMessageSchema.safeParse(json);
      if (!parsed.success) {
        this.fail(ws, "BAD_MESSAGE", "message does not match the protocol schema", 4002);
        return;
      }
      const message = parsed.data;
      if (!authenticated) {
        if (message.type !== "hello") {
          this.fail(ws, "UNAUTHORIZED", "first message must be hello", 4003);
          return;
        }
        if (!protocolCompatible(message.protocolVersion, PROTOCOL_VERSION)) {
          this.fail(ws, "PROTOCOL_MISMATCH", `extension speaks ${message.protocolVersion}, server speaks ${PROTOCOL_VERSION}`, 4001);
          return;
        }
        if (!tokenMatches(message.token, this.options.token)) {
          this.fail(ws, "UNAUTHORIZED", "pairing token rejected", 4003);
          return;
        }
        authenticated = true;
        clearTimeout(handshakeTimer);
        this.adopt(ws, { extensionVersion: message.extensionVersion, userAgent: message.userAgent, connectedAt: Date.now() });
        return;
      }
      if (this.client !== ws) return; // A replaced connection must not touch shared state.
      this.lastSeen = Date.now();
      switch (message.type) {
        case "ping":
          this.send({ type: "pong", t: message.t });
          return;
        case "tabs":
          this.tabs = message.tabs;
          this.tabsUpdatedAt = Date.now();
          return;
        case "response": {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.ok) pending.resolve(message.result);
          else pending.reject(new BridgeError(message.error?.code ?? "INTERNAL", message.error?.message ?? "request failed"));
          return;
        }
        default:
          return;
      }
    });

    ws.on("close", (code, reason) => {
      clearTimeout(handshakeTimer);
      if (this.client === ws) this.dropClient(`connection closed (${code} ${reason.toString()})`.trim());
    });
    ws.on("error", (error) => {
      this.lastError = error.message;
    });
  }

  private adopt(ws: WebSocket, info: ExtensionInfo): void {
    if (this.client && this.client !== ws) {
      const previous = this.client;
      this.client = null;
      previous.close(4000, "replaced by a newer connection");
      this.options.log("replaced the previous extension connection");
    }
    this.client = ws;
    this.info = info;
    this.lastSeen = Date.now();
    this.lastError = null;
    this.send({
      type: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: this.options.serverVersion,
      heartbeatIntervalMs: this.options.heartbeatIntervalMs,
    });
    this.startHeartbeat();
    this.options.log(`extension ${info.extensionVersion} connected`);
  }

  private dropClient(reason: string): void {
    this.stopHeartbeat();
    this.client = null;
    this.info = null;
    this.tabs = [];
    this.tabsUpdatedAt = null;
    this.lastDisconnectAt = Date.now();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeError("NOT_CONNECTED", reason));
      this.pending.delete(id);
    }
    this.options.log(`extension disconnected: ${reason}`);
  }

  private fail(ws: WebSocket, code: BridgeErrorCode, message: string, closeCode: number): void {
    this.lastError = message;
    this.options.log(`closing connection: ${code} ${message}`);
    const error: ServerMessage = { type: "error", code, message };
    try {
      ws.send(JSON.stringify(error));
    } catch {
      // The socket may already be gone; closing below is enough.
    }
    ws.close(closeCode, code);
  }

  private send(message: ServerMessage): void {
    if (this.client?.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(message));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (!this.client) return;
      if (Date.now() - this.lastSeen > this.options.heartbeatTimeoutMs) {
        this.options.log("extension heartbeat timed out");
        this.client.terminate();
        return;
      }
      this.send({ type: "ping", t: Date.now() });
    }, this.options.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
