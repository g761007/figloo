import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { StatusReportSchema } from "@figloo/protocol";
import { Bridge } from "../src/bridge.js";
import { createServer } from "../src/server.js";
import { pairFakeExtension, sampleTab, startBridge } from "./helpers.js";

const bridges: Bridge[] = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
});

async function callGetStatus(bridge: Bridge, refreshTimeoutMs?: number) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ bridge, version: "test", refreshTimeoutMs }).connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  const result = await client.callTool({ name: "get_status" });
  await client.close();
  return StatusReportSchema.parse(result.structuredContent);
}

describe("get_status", () => {
  it("reports DISCONNECTED with a pairing hint while no extension is connected", async () => {
    const bridge = await startBridge();
    bridges.push(bridge);
    const report = await callGetStatus(bridge);
    expect(report.status).toBe("DISCONNECTED");
    expect(report.bridge).toEqual({ listening: true, port: bridge.port, error: null });
    expect(report.hint).toMatch(/figloo-mcp pair/);
  });

  it("asks the extension for fresh tabs and reports READY", async () => {
    const bridge = await startBridge();
    bridges.push(bridge);
    const ext = await pairFakeExtension(bridge.port);
    void ext.next((m) => m.type === "request").then((request) => {
      ext.send({ type: "response", id: (request as { id: string }).id, ok: true, result: { tabs: [sampleTab()] } });
    });

    const report = await callGetStatus(bridge);

    expect(report.status).toBe("READY");
    expect(report.tabsFresh).toBe(true);
    expect(report.tabs).toHaveLength(1);
    expect(report.tabs[0]?.fileKey).toBe("abc");
    expect(report.extension.connected).toBe(true);
    expect(report.hint).toBeNull();
    ext.ws.close();
  });

  it("falls back to the last pushed tabs when the refresh times out", async () => {
    const bridge = await startBridge();
    bridges.push(bridge);
    const ext = await pairFakeExtension(bridge.port);
    ext.send({ type: "tabs", tabs: [sampleTab({ readiness: "DEGRADED", detail: "guest session cannot select layers; sign in to Figma" })] });
    await new Promise((r) => setTimeout(r, 20));

    const report = await callGetStatus(bridge, 50);

    expect(report.status).toBe("DEGRADED");
    expect(report.tabsFresh).toBe(false);
    expect(report.extension.lastError).toMatch(/timed out/);
    expect(report.hint).toMatch(/guest session/);
    ext.ws.close();
  });

  it("reports NO_DESIGN_TAB when the extension is connected without Figma tabs", async () => {
    const bridge = await startBridge();
    bridges.push(bridge);
    const ext = await pairFakeExtension(bridge.port);
    void ext.next((m) => m.type === "request").then((request) => {
      ext.send({ type: "response", id: (request as { id: string }).id, ok: true, result: { tabs: [] } });
    });
    const report = await callGetStatus(bridge);
    expect(report.status).toBe("NO_DESIGN_TAB");
    expect(report.hint).toMatch(/Open a file/);
    ext.ws.close();
  });
});
