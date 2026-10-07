import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@figloo/protocol";
import { Bridge, BridgeError } from "../src/bridge.js";
import { hello, openFakeExtension, pairFakeExtension, sampleTab, startBridge } from "./helpers.js";

const bridges: Bridge[] = [];
const track = (bridge: Bridge) => {
  bridges.push(bridge);
  return bridge;
};

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
});

describe("Bridge handshake", () => {
  it("welcomes an extension with the right origin, token, and protocol version", async () => {
    const bridge = track(await startBridge());
    const ext = await pairFakeExtension(bridge.port);
    const welcome = ext.messages.find((m) => m.type === "welcome");
    expect(welcome).toMatchObject({ type: "welcome", protocolVersion: PROTOCOL_VERSION, serverVersion: "test" });
    expect(bridge.connected).toBe(true);
    expect(bridge.extension?.extensionVersion).toBe("0.0.1");
    ext.ws.close();
  });

  it("rejects a wrong token with UNAUTHORIZED and closes the socket", async () => {
    const bridge = track(await startBridge());
    const ext = await openFakeExtension(bridge.port);
    ext.send(hello({ token: "wrong" }));
    const error = await ext.next((m) => m.type === "error");
    expect(error).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
    expect((await ext.closed).code).toBe(4003);
    expect(bridge.connected).toBe(false);
  });

  it("rejects an incompatible protocol version and names both versions and the side to update", async () => {
    const bridge = track(await startBridge({ serverVersion: "0.5.0" }));
    const ext = await openFakeExtension(bridge.port);
    ext.send(hello({ protocolVersion: "0.9.0", extensionVersion: "0.9.1" }));
    expect(await ext.next((m) => m.type === "error")).toMatchObject({
      code: "PROTOCOL_MISMATCH",
      message: expect.stringMatching(/^extension 0\.9\.1 speaks protocol 0\.9\.0, server 0\.5\.0 speaks \S+; update the MCP server$/),
    });
    expect((await ext.closed).code).toBe(4001);
  });

  it("refuses the upgrade when the origin is not the pinned extension", async () => {
    const bridge = track(await startBridge());
    await expect(openFakeExtension(bridge.port, "https://www.figma.com")).rejects.toThrow(/403/);
    expect(bridge.connected).toBe(false);
  });

  it("closes a socket that sends something other than hello first", async () => {
    const bridge = track(await startBridge());
    const ext = await openFakeExtension(bridge.port);
    ext.send({ type: "ping", t: 1 });
    expect(await ext.next((m) => m.type === "error")).toMatchObject({ code: "UNAUTHORIZED" });
    expect((await ext.closed).code).toBe(4003);
  });
});

describe("Bridge session", () => {
  it("answers pings, stores pushed tabs, and round-trips a request", async () => {
    const bridge = track(await startBridge());
    const ext = await pairFakeExtension(bridge.port);

    ext.send({ type: "ping", t: 42 });
    expect(await ext.next((m) => m.type === "pong")).toEqual({ type: "pong", t: 42 });

    ext.send({ type: "tabs", tabs: [sampleTab()] });
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.getTabs().tabs).toHaveLength(1);

    const pending = bridge.request("refresh_tabs");
    const request = await ext.next((m) => m.type === "request");
    expect(request).toMatchObject({ type: "request", op: "refresh_tabs" });
    ext.send({ type: "response", id: (request as { id: string }).id, ok: true, result: { tabs: [] } });
    expect(await pending).toEqual({ tabs: [] });
  });

  it("times out a request the extension never answers", async () => {
    const bridge = track(await startBridge());
    await pairFakeExtension(bridge.port);
    await expect(bridge.request("refresh_tabs", undefined, 50)).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("ignores a late answer to a timed-out request and a repeated answer to a newer one", async () => {
    const bridge = track(await startBridge());
    const ext = await pairFakeExtension(bridge.port);
    const requests: string[] = [];
    ext.ws.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { type: string; id: string };
      if (message.type === "request") requests.push(message.id);
    });
    await expect(bridge.request("refresh_tabs", undefined, 50)).rejects.toMatchObject({ code: "TIMEOUT" });
    const newer = bridge.request("refresh_tabs", undefined, 1_000);
    await new Promise((r) => setTimeout(r, 20));
    const [timedOut, current] = requests;
    ext.send({ type: "response", id: timedOut!, ok: true, result: { tabs: ["late"] } } as never);
    ext.send({ type: "response", id: current!, ok: true, result: { tabs: ["first"] } } as never);
    ext.send({ type: "response", id: current!, ok: true, result: { tabs: ["repeated"] } } as never);
    await expect(newer).resolves.toEqual({ tabs: ["first"] });
  });

  it("rejects requests while no extension is connected", async () => {
    const bridge = track(await startBridge());
    await expect(bridge.request("refresh_tabs")).rejects.toBeInstanceOf(BridgeError);
  });

  it("forgets tabs and records the disconnect when the extension goes away", async () => {
    const bridge = track(await startBridge());
    const ext = await pairFakeExtension(bridge.port);
    ext.send({ type: "tabs", tabs: [sampleTab()] });
    await new Promise((r) => setTimeout(r, 20));
    ext.ws.close();
    await ext.closed;
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.connected).toBe(false);
    expect(bridge.getTabs().tabs).toEqual([]);
    expect(bridge.lastDisconnectAt).not.toBeNull();
  });

  it("replaces the previous connection when a newer extension pairs", async () => {
    const bridge = track(await startBridge());
    const first = await pairFakeExtension(bridge.port);
    const second = await pairFakeExtension(bridge.port);
    expect((await first.closed).code).toBe(4000);
    expect(bridge.connected).toBe(true);
    second.ws.close();
  });
});

describe("Bridge listen errors", () => {
  it("reports a port that is already in use instead of crashing", async () => {
    const first = track(await startBridge());
    const second = track(await startBridge({ port: first.port }));
    expect(second.listening).toBe(false);
    expect(second.listenError).toMatch(/already in use/);
  });
});
