import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import {
  ExtensionMessageSchema,
  HANDED_OVER_CLOSE_CODE,
  PROTOCOL_VERSION,
  SessionIdentitySchema,
  TabStatusSchema,
  protocolCompatible,
  sessionLabel,
  type BridgeErrorCode,
  type BridgeOp,
  type ErrorCode,
  type ServerMessage,
  type SessionIdentity,
  type TabStatus,
} from "@figloo/protocol";

export interface BridgeOptions {
  port: number;
  token: string;
  allowedExtensionIds: string[];
  serverVersion: string;
  /** Folder name of the project this session works in, shown to the user. */
  project: string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  /** How often a standby server tries to take the port. */
  standbyRetryMs?: number;
  /** How long after its last request the holder still counts as busy and keeps the extension. */
  idleGraceMs?: number;
  /** How long a standby server waits for the holder to answer. */
  handoverTimeoutMs?: number;
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

/** What the holder reports about itself on GET /holder and in answer to POST /handover. */
const HolderInfoSchema = z.object({
  session: SessionIdentitySchema,
  busy: z.boolean(),
  lastActivityAt: z.number().nullable(),
  /** The tabs the extension last pushed to the holder, so a standby session can name a tabId. */
  tabs: z.array(TabStatusSchema).default([]),
});
type HolderInfo = z.infer<typeof HolderInfoSchema>;

type HolderAnswer = { status: number; body: unknown } | "unreachable" | "timeout";

const HANDSHAKE_TIMEOUT_MS = 5_000;
/** After the holder let go, how long the new holder keeps trying to listen. */
const RELISTEN_WINDOW_MS = 2_000;
/** After taking the port, how long the new holder waits for the extension to reconnect. */
const EXTENSION_WAIT_MS = 5_000;
const MAX_BODY_BYTES = 4_096;

/**
 * Loopback WebSocket endpoint the extension connects to. Exactly one authenticated
 * extension connection is kept; a newer valid handshake replaces the previous one.
 *
 * Several agent sessions each run a server, but only one, the holder, listens on the port.
 * The others stand by, take the port when the holder exits, and ask an idle holder to hand
 * it over when one of their tools needs the extension.
 */
export class Bridge {
  port: number;
  listening = false;
  listenError: string | null = null;
  lastDisconnectAt: number | null = null;
  lastError: string | null = null;
  /** This server's session; index.ts fills in `client` once the MCP client initialized. */
  readonly session: SessionIdentity;

  private readonly options: BridgeOptions &
    Required<Pick<BridgeOptions, "heartbeatIntervalMs" | "heartbeatTimeoutMs" | "standbyRetryMs" | "idleGraceMs" | "handoverTimeoutMs" | "log">>;
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private info: ExtensionInfo | null = null;
  private tabs: TabStatus[] = [];
  private tabsUpdatedAt: number | null = null;
  private lastSeen = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, Pending>();
  /** The session holding the port while this server stands by, when known, and its tabs. */
  private otherHolder: SessionIdentity | null = null;
  private otherTabs: TabStatus[] = [];
  private inflight = 0;
  private lastActivityAt: number | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private listenAttempt: Promise<boolean> | null = null;
  private acquiring: Promise<void> | null = null;
  private releasing: Promise<void> | null = null;
  private stopped = false;

  constructor(options: BridgeOptions) {
    this.options = {
      heartbeatIntervalMs: 20_000,
      heartbeatTimeoutMs: 45_000,
      standbyRetryMs: 3_000,
      idleGraceMs: 10_000,
      handoverTimeoutMs: 2_000,
      log: (message) => console.error(`[figloo] ${message}`),
      ...options,
    };
    this.port = options.port;
    this.session = { client: null, project: options.project, pid: process.pid, startedAt: Date.now(), serverVersion: options.serverVersion };
  }

  get role(): "holder" | "standby" {
    return this.listening ? "holder" : "standby";
  }

  /** The session the extension serves: this one while it holds the port. */
  get holder(): SessionIdentity | null {
    return this.listening ? this.session : this.otherHolder;
  }

  get connected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN && this.info !== null;
  }

  get extension(): ExtensionInfo | null {
    return this.info;
  }

  /** While standing by, the holder's tabs as of the last lookupHolder. */
  getTabs(): { tabs: TabStatus[]; updatedAt: number | null } {
    if (!this.listening) return { tabs: this.otherTabs, updatedAt: null };
    return { tabs: this.tabs, updatedAt: this.tabsUpdatedAt };
  }

  /** Takes the port, or stands by when another session holds it; `listenError` records why. */
  async start(): Promise<void> {
    if (await this.tryListen()) return;
    this.options.log(`bridge on standby: ${this.listenError}; retrying every ${this.options.standbyRetryMs} ms`);
    this.scheduleRetry();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this.closeServer(1001, "server shutting down");
  }

  /**
   * Sends a request to the extension and resolves with its `result`. A standby server first
   * asks the holder to hand over the port; a busy holder makes this fail with BUSY.
   */
  async request(op: BridgeOp, params?: Record<string, unknown>, timeoutMs = 3_000, tabId?: number): Promise<unknown> {
    this.inflight += 1;
    try {
      if (this.releasing) await this.releasing;
      if (!this.listening) await this.takeOver();
      if (!this.connected) throw new BridgeError("NOT_CONNECTED", "extension is not connected");
      const id = randomUUID();
      const message: ServerMessage = { type: "request", id, op, ...(tabId !== undefined ? { tabId } : {}), ...(params ? { params } : {}) };
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new BridgeError("TIMEOUT", `${op} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        this.send(message);
      });
    } finally {
      this.inflight -= 1;
      this.lastActivityAt = Date.now();
    }
  }

  /** While standing by, asks the holder who it is. Does not take the port from a running holder. */
  async lookupHolder(): Promise<void> {
    if (this.listening) return;
    const answer = await this.askHolder("GET", "/holder");
    if (answer === "unreachable") {
      // Nobody holds the port any more; taking a free port is not a handover.
      await this.tryListen();
      return;
    }
    const info = typeof answer === "object" && answer.status === 200 ? HolderInfoSchema.safeParse(answer.body) : null;
    if (info?.success) {
      this.otherHolder = info.data.session;
      this.otherTabs = info.data.tabs;
      this.listenError = null;
      return;
    }
    this.otherHolder = null;
    this.otherTabs = [];
    this.listenError = this.holderProblem(answer).message;
  }

  private get busy(): boolean {
    return this.inflight > 0 || (this.lastActivityAt !== null && Date.now() - this.lastActivityAt < this.options.idleGraceMs);
  }

  private holderInfo(): HolderInfo {
    return { session: this.session, busy: this.busy, lastActivityAt: this.lastActivityAt, tabs: this.tabs };
  }

  /** Listens on the port once; concurrent callers share the attempt. */
  private tryListen(): Promise<boolean> {
    if (this.listening) return Promise.resolve(true);
    if (this.stopped) return Promise.resolve(false);
    this.listenAttempt ??= this.openServer().finally(() => {
      this.listenAttempt = null;
    });
    return this.listenAttempt;
  }

  private openServer(): Promise<boolean> {
    return new Promise((resolve) => {
      const http = createServer((req, res) => this.handleHttp(req, res));
      const wss = new WebSocketServer({ noServer: true });
      http.on("upgrade", (req, socket, head) => this.handleUpgrade(wss, req, socket, head));
      http.on("error", (error: NodeJS.ErrnoException) => {
        if (this.http === http) {
          this.lastError = error.message;
          return;
        }
        this.listenError = error.code === "EADDRINUSE" ? `port ${this.port} is already in use by another process` : error.message;
        wss.close();
        resolve(false);
      });
      http.listen(this.port, "127.0.0.1", () => {
        if (this.stopped) {
          http.close();
          resolve(false);
          return;
        }
        this.port = (http.address() as AddressInfo).port;
        this.http = http;
        this.wss = wss;
        this.listening = true;
        this.listenError = null;
        this.otherHolder = null;
        this.otherTabs = [];
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.options.log(`bridge listening on ws://127.0.0.1:${this.port}`);
        resolve(true);
      });
    });
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.tryListen().then((listening) => {
        if (!listening) this.scheduleRetry();
      });
    }, this.options.standbyRetryMs);
    this.retryTimer.unref();
  }

  /** Stops listening: no new connections, then every socket closes with `code`. */
  private async closeServer(code: number, reason: string): Promise<void> {
    const http = this.http;
    const wss = this.wss;
    this.http = null;
    this.wss = null;
    this.listening = false;
    this.stopHeartbeat();
    if (!http) return;
    const closed = new Promise<void>((resolve) => http.close(() => resolve()));
    await Promise.all([...(wss?.clients ?? [])].map((ws) => closeSocket(ws, code, reason)));
    wss?.close();
    http.closeAllConnections();
    await closed;
  }

  private takeOver(): Promise<void> {
    this.acquiring ??= this.acquire().finally(() => {
      this.acquiring = null;
    });
    return this.acquiring;
  }

  /** Takes the port from the holder, then waits for the extension to reconnect here. */
  private async acquire(): Promise<void> {
    // Two rounds: a third server may grab the port between the holder letting go and this one listening.
    for (let round = 0; round < 2 && !(await this.tryListen()); round++) {
      const answer = await this.askHolder("POST", "/handover", this.session);
      if (answer === "unreachable") continue;
      const info = typeof answer === "object" ? HolderInfoSchema.safeParse(answer.body) : null;
      if (typeof answer === "object" && answer.status === 409 && info?.success) {
        this.otherHolder = info.data.session;
        throw new BridgeError("BUSY", `Figloo is working for ${sessionLabel(info.data.session)}; try again in a few seconds.`);
      }
      if (typeof answer === "object" && answer.status === 503) throw new BridgeError("BUSY", "Figloo is switching to another session; try again in a few seconds.");
      if (typeof answer !== "object" || answer.status !== 200) throw this.holderProblem(answer);
      const deadline = Date.now() + RELISTEN_WINDOW_MS;
      while (!(await this.tryListen()) && Date.now() < deadline) await sleep(100);
    }
    if (!this.listening) throw new BridgeError("NOT_CONNECTED", `could not take port ${this.port} from the session holding it; call get_status`);
    this.options.log(`took over the bridge on port ${this.port}`);
    const deadline = Date.now() + EXTENSION_WAIT_MS;
    while (!this.connected && Date.now() < deadline) await sleep(50);
  }

  /** Explains an answer from the port's holder that is neither a handover nor a busy holder. */
  private holderProblem(answer: HolderAnswer): BridgeError {
    if (answer === "timeout") {
      return new BridgeError("NOT_CONNECTED", `the session holding Figloo on port ${this.port} did not answer; ask the user to close that session`);
    }
    if (answer !== "unreachable" && answer.status === 404) {
      return new BridgeError(
        "NOT_CONNECTED",
        `port ${this.port} is held by another session running an older Figloo that cannot hand over; ask the user to restart that session`,
      );
    }
    if (answer !== "unreachable" && answer.status === 401) {
      return new BridgeError("NOT_CONNECTED", `the session holding port ${this.port} rejected this session's pairing token; its Figloo uses another config`);
    }
    return new BridgeError("NOT_CONNECTED", `unexpected answer from the session holding port ${this.port}: ${answer === "unreachable" ? "unreachable" : `HTTP ${answer.status}`}`);
  }

  private askHolder(method: "GET" | "POST", path: string, body?: unknown): Promise<HolderAnswer> {
    return new Promise((resolve) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: this.port,
          method,
          path,
          agent: false,
          headers: {
            authorization: `Bearer ${this.options.token}`,
            ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () => {
            clearTimeout(timer);
            resolve({ status: res.statusCode ?? 0, body: parseJson(text) });
          });
        },
      );
      const timer = setTimeout(() => {
        resolve("timeout");
        req.destroy();
      }, this.options.handoverTimeoutMs);
      req.on("error", () => {
        clearTimeout(timer);
        resolve("unreachable");
      });
      req.end(payload);
    });
  }

  /** GET /holder and POST /handover for other sessions' servers; anything else is 404 as before. */
  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const route = `${req.method} ${(req.url ?? "/").split("?")[0]}`;
    if (route !== "GET /holder" && route !== "POST /handover") return reply(res, 404);
    // Browsers always send Origin on these requests, so a web page cannot use them even with the token.
    if (req.headers.origin !== undefined) return reply(res, 403, { error: "requests from web pages are refused" });
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !tokenMatches(auth.slice("Bearer ".length), this.options.token)) {
      return reply(res, 401, { error: "pairing token rejected" });
    }
    if (route === "GET /holder") return reply(res, 200, this.holderInfo());

    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      text += chunk;
      if (text.length > MAX_BODY_BYTES) req.destroy();
    });
    req.on("end", () => {
      const requester = SessionIdentitySchema.safeParse(parseJson(text));
      if (!requester.success) return reply(res, 400, { error: "the body must be the requesting session" });
      if (!this.listening || this.releasing) return reply(res, 503, { error: "already handing over" });
      if (this.busy) {
        this.options.log(`kept the bridge: ${sessionLabel(requester.data)} asked for it while this session is busy`);
        return reply(res, 409, this.holderInfo());
      }
      const handover = new Promise<void>((resolve) => {
        // Keep the port when the answer never went out, for example because the requester gave up.
        res.on("close", () => (res.writableFinished ? void this.handOver(requester.data).finally(resolve) : resolve()));
      });
      this.releasing = handover.finally(() => {
        this.releasing = null;
      });
      reply(res, 200, this.holderInfo());
    });
  }

  private async handOver(to: SessionIdentity): Promise<void> {
    this.options.log(`handing the bridge over to ${sessionLabel(to)}`);
    this.otherHolder = to;
    await this.closeServer(HANDED_OVER_CLOSE_CODE, "handed over to another session");
    this.listenError = null;
    this.scheduleRetry();
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
      session: this.session,
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

function reply(res: ServerResponse, status: number, body?: unknown): void {
  res.statusCode = status;
  res.setHeader("connection", "close");
  if (body === undefined) {
    res.end();
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Closes a socket with `code`, waiting briefly for the peer so the code arrives before the server goes away. */
function closeSocket(ws: WebSocket, code: number, reason: string): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.terminate();
      resolve();
    }, 1_000);
    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.close(code, reason);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
