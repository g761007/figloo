import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HANDED_OVER_CLOSE_CODE, sessionLabel } from "@figloo/protocol";
import type { Bridge } from "../src/bridge.js";
import { TOKEN, runReconnectingExtension, startBridge } from "./helpers.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function bridgeOn(port: number, project: string, overrides: Parameters<typeof startBridge>[0] = {}): Promise<Bridge> {
  const bridge = await startBridge({ port, project, ...overrides });
  cleanups.push(() => bridge.stop());
  return bridge;
}

function extensionOn(port: number, answer?: (op: string) => unknown) {
  const extension = runReconnectingExtension(port, answer);
  cleanups.push(() => extension.stop());
  return extension;
}

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A holder whose extension is connected, plus a second server standing by on the same port. */
async function holderAndStandby(holderOverrides: Parameters<typeof startBridge>[0] = {}, answer?: (op: string) => unknown) {
  const alpha = await bridgeOn(0, "alpha", holderOverrides);
  const extension = extensionOn(alpha.port, answer);
  await until(() => alpha.connected);
  const beta = await bridgeOn(alpha.port, "beta");
  expect(beta.role).toBe("standby");
  return { alpha, beta, extension };
}

/** Listens on a free port with a plain HTTP server, standing in for something that is not a 0.2.0 holder. */
async function listenPlain(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return (server.address() as AddressInfo).port;
}

/** Calls the holder's endpoints the way another session's server, or a web page, would. */
function call(port: number, method: string, path: string, headers: OutgoingHttpHeaders, body?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({ host: "127.0.0.1", port, method, path, agent: false, headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

const auth = { authorization: `Bearer ${TOKEN}` };
const requester = { client: "Claude Code", project: "gamma", pid: 1, startedAt: 0, serverVersion: "test" };

describe("handover between sessions", () => {
  it("hands the extension over from an idle holder to the session whose tool needs it", async () => {
    const { alpha, beta, extension } = await holderAndStandby();

    await expect(beta.request("refresh_tabs")).resolves.toEqual({ tabs: [] });

    expect(beta.role).toBe("holder");
    expect(beta.connected).toBe(true);
    expect(alpha.role).toBe("standby");
    expect(alpha.holder).toEqual(beta.session);
    // The extension learns why it was dropped and greets the new holder, which says who it is.
    expect(extension.closes[0]).toBe(HANDED_OVER_CLOSE_CODE);
    expect(extension.welcomes.at(-1)?.session).toEqual(beta.session);
  });

  it("answers BUSY with the holder's name while the holder has a request running", async () => {
    let answerLater: (() => void) | undefined;
    const { alpha, beta, extension } = await holderAndStandby({}, () => new Promise((resolve) => (answerLater = () => resolve({ tabs: [] }))));
    const running = alpha.request("refresh_tabs", undefined, 5_000);
    await until(() => answerLater !== undefined);

    await expect(beta.request("refresh_tabs")).rejects.toMatchObject({ code: "BUSY", message: expect.stringContaining(sessionLabel(alpha.session)) });

    answerLater!();
    await expect(running).resolves.toEqual({ tabs: [] });
    expect(alpha.role).toBe("holder");
    expect(beta.holder).toEqual(alpha.session);
    expect(extension.closes).toEqual([]);
  });

  it("keeps the extension for the idle grace after the holder's last request, then hands it over", async () => {
    const { alpha, beta } = await holderAndStandby({ idleGraceMs: 300 });
    await alpha.request("refresh_tabs");

    await expect(beta.request("refresh_tabs")).rejects.toMatchObject({ code: "BUSY" });
    await new Promise((resolve) => setTimeout(resolve, 350));
    await expect(beta.request("refresh_tabs")).resolves.toEqual({ tabs: [] });
    expect(beta.role).toBe("holder");
  });

  it("uses a 10 second grace by default", async () => {
    const { alpha, beta } = await holderAndStandby();
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    await alpha.request("refresh_tabs");

    vi.setSystemTime(Date.now() + 9_500);
    await expect(beta.request("refresh_tabs")).rejects.toMatchObject({ code: "BUSY" });
    vi.setSystemTime(Date.now() + 600);
    await expect(beta.request("refresh_tabs")).resolves.toEqual({ tabs: [] });
  });

  it("takes over on its own when the holder exits", async () => {
    const alpha = await bridgeOn(0, "alpha");
    const extension = extensionOn(alpha.port);
    await until(() => alpha.connected);
    const beta = await bridgeOn(alpha.port, "beta", { standbyRetryMs: 100 });

    await alpha.stop();

    // beta counts as connected once it sends welcome; the extension reads it a turn later.
    await until(() => beta.role === "holder" && beta.connected && extension.welcomes.at(-1)?.session?.project === "beta");
    expect(extension.welcomes.at(-1)?.session).toEqual(beta.session);
    await expect(beta.request("refresh_tabs")).resolves.toEqual({ tabs: [] });
  });

  it("asks for a restart when the port's holder is an older Figloo that cannot hand over", async () => {
    const port = await listenPlain((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const beta = await bridgeOn(port, "beta");

    await expect(beta.request("refresh_tabs")).rejects.toMatchObject({ code: "NOT_CONNECTED", message: expect.stringMatching(/older Figloo.*restart that session/) });
    expect(beta.role).toBe("standby");
  });

  it("asks to close a holder that does not answer", async () => {
    const port = await listenPlain(() => {});
    const beta = await bridgeOn(port, "beta", { handoverTimeoutMs: 200 });

    await expect(beta.request("refresh_tabs")).rejects.toMatchObject({ code: "NOT_CONNECTED", message: expect.stringMatching(/did not answer.*close that session/) });
  });
});

describe("holder endpoints", () => {
  it("reports the holder's session and whether it is busy", async () => {
    const alpha = await bridgeOn(0, "alpha");
    expect(await call(alpha.port, "GET", "/holder", auth)).toEqual({ status: 200, body: { session: alpha.session, busy: false, lastActivityAt: null, tabs: [], extensionVersion: null } });
    await expect(alpha.request("refresh_tabs")).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    expect((await call(alpha.port, "GET", "/holder", auth)).body).toMatchObject({ busy: true, lastActivityAt: expect.any(Number) });
  });

  it("refuses a handover request with a wrong token", async () => {
    const { alpha, extension } = await holderAndStandby();
    const answer = await call(alpha.port, "POST", "/handover", { authorization: "Bearer wrong" }, requester);

    expect(answer.status).toBe(401);
    expect(alpha.role).toBe("holder");
    expect(alpha.connected).toBe(true);
    expect(extension.closes).toEqual([]);
  });

  it("refuses a handover request that carries an Origin, even with the right token", async () => {
    const { alpha, extension } = await holderAndStandby();
    const answer = await call(alpha.port, "POST", "/handover", { ...auth, origin: "https://example.com" }, requester);

    expect(answer.status).toBe(403);
    expect(alpha.role).toBe("holder");
    expect(extension.closes).toEqual([]);
  });

  it("still answers 404 to anything else", async () => {
    const alpha = await bridgeOn(0, "alpha");
    expect((await call(alpha.port, "GET", "/", auth)).status).toBe(404);
    expect((await call(alpha.port, "GET", "/handover", auth)).status).toBe(404);
  });
});
