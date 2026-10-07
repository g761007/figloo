import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { StatusReportSchema, sessionLabel } from "@figloo/protocol";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Bridge } from "../src/bridge.js";
import { createServer } from "../src/server.js";
import { hello, openFakeExtension, pairFakeExtension, sampleTab, startBridge } from "./helpers.js";

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
    expect(report.bridge).toEqual({ listening: true, port: bridge.port, error: null, role: "holder", holder: bridge.session });
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

  it("says which side to update when the extension and the server speak different protocol versions", async () => {
    const bridge = await startBridge({ serverVersion: "0.5.0" });
    bridges.push(bridge);
    const older = await openFakeExtension(bridge.port);
    older.send(hello({ protocolVersion: "0.2.0", extensionVersion: "0.3.1" }));
    await older.closed;
    let report = await callGetStatus(bridge);
    expect(report.extension.rejected).toEqual({ reason: "protocol", extensionVersion: "0.3.1", protocolVersion: "0.2.0" });
    expect(report.hint).toMatch(/extension 0\.3\.1 speaks bridge protocol 0\.2\.0, and the server 0\.5\.0 speaks .*update the extension to 0\.5\.0/);

    const newer = await openFakeExtension(bridge.port);
    newer.send(hello({ protocolVersion: "9.0.0", extensionVersion: "9.1.0" }));
    await newer.closed;
    report = await callGetStatus(bridge);
    expect(report.hint).toMatch(/update the Figloo plugin or server to 9\.1\.0/);
  });

  it("asks to pair again when the extension offers a token the server does not accept, and forgets that once it connects", async () => {
    const bridge = await startBridge();
    bridges.push(bridge);
    const wrong = await openFakeExtension(bridge.port);
    wrong.send(hello({ token: "old-token" }));
    await wrong.closed;
    expect((await callGetStatus(bridge)).hint).toMatch(/pairing token this server does not accept.*figloo-mcp pair/);

    const ext = await pairFakeExtension(bridge.port);
    void ext.next((m) => m.type === "request").then((request) => {
      ext.send({ type: "response", id: (request as { id: string }).id, ok: true, result: { tabs: [] } });
    });
    expect((await callGetStatus(bridge)).extension.rejected).toBeNull();
    ext.ws.close();
  });

  it("names the holder while standing by, without taking the extension from it", async () => {
    const holder = await startBridge({ project: "alpha" });
    bridges.push(holder);
    const ext = await pairFakeExtension(holder.port);
    ext.send({ type: "tabs", tabs: [sampleTab()] });
    await new Promise((r) => setTimeout(r, 20));
    const standby = await startBridge({ port: holder.port, project: "beta" });
    bridges.push(standby);

    const report = await callGetStatus(standby);

    expect(report.bridge).toMatchObject({ listening: false, role: "standby", holder: holder.session, error: null });
    expect(report.hint).toContain(`Figloo is serving ${sessionLabel(holder.session)}`);
    // The holder's tabs give the agent a tabId to call a tool with, which then takes over.
    expect(report.tabs.map((tab) => tab.tabId)).toEqual([7]);
    expect(report.tabsFresh).toBe(false);
    expect(holder.connected).toBe(true);
    expect(ext.messages.filter((m) => m.type === "request")).toEqual([]);
    ext.ws.close();
  });

  it("asks for a restart while an older Figloo that cannot hand over holds the port", async () => {
    const old = createHttpServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => old.listen(0, "127.0.0.1", resolve));
    const standby = await startBridge({ port: (old.address() as AddressInfo).port });
    bridges.push(standby);

    const report = await callGetStatus(standby);

    expect(report.bridge).toMatchObject({ role: "standby", holder: null });
    expect(report.hint).toMatch(/older Figloo.*restart that session/);
    await new Promise((resolve) => old.close(resolve));
  });

  it("asks which file to use when several design tabs are open", async () => {
    const bridge = await startBridge();
    bridges.push(bridge);
    const ext = await pairFakeExtension(bridge.port);
    void ext.next((m) => m.type === "request").then((request) => {
      const tabs = [sampleTab(), sampleTab({ tabId: 8, fileKey: "def" }), sampleTab({ tabId: 9, readiness: "LOADING" })];
      ext.send({ type: "response", id: (request as { id: string }).id, ok: true, result: { tabs } });
    });

    const report = await callGetStatus(bridge);

    expect(report.status).toBe("READY");
    expect(report.hint).toBe("2 Figma design tabs are open: use the tabId in the prompt the user pasted, or ask the user which file to work on.");
    ext.ws.close();
  });

  it("lists what each tab cannot do, the tools that fail or do less there, and what the user can do", async () => {
    const bridge = await startBridge();
    bridges.push(bridge);
    const ext = await pairFakeExtension(bridge.port);
    const capabilities = sampleTab().capabilities;
    void ext.next((m) => m.type === "request").then((request) => {
      const tabs = [
        sampleTab({ readiness: "DEGRADED", access: "guest" }),
        sampleTab({ tabId: 8, readiness: "DEGRADED", access: "edit" }),
        sampleTab({ tabId: 9, uiLocale: "zh-TW", capabilities: { ...capabilities, mirrorDom: false } }),
        sampleTab({ tabId: 10, readiness: "DEGRADED", capabilities: { ...capabilities, layersPanel: false, uiCollapsed: true, mirrorDom: false } }),
        sampleTab({ tabId: 11 }),
        sampleTab({ tabId: 12, readiness: "LOADING", capabilities: { ...capabilities, mirrorDom: false } }),
        sampleTab({ tabId: 13, missingAnchors: ["rightSidebar", "pagesList"] }),
        sampleTab({ tabId: 14, readiness: "DEGRADED", access: "guest", missingAnchors: ["rightSidebar", "propertiesPanel"] }),
      ];
      ext.send({ type: "response", id: (request as { id: string }).id, ok: true, result: { tabs } });
    });

    const report = await callGetStatus(bridge);
    const codes = (tabId: number) => report.tabs.find((tab) => tab.tabId === tabId)!.limitations.map((limit) => limit.code);
    expect(codes(7)).toEqual(["GUEST"]);
    expect(codes(8)).toEqual(["EDIT_ACCESS"]);
    expect(codes(9)).toEqual(["NO_SCREEN_READER_MIRROR", "NOT_ENGLISH"]);
    // A minimized UI hides the rest, so nothing else is claimed for it.
    expect(codes(10)).toEqual(["UI_MINIMIZED"]);
    expect(codes(11)).toEqual([]);
    expect(codes(12)).toEqual([]);
    // A signed-in session without the right sidebar points at a change in Figma; a guest never has one.
    expect(codes(13)).toEqual(["UI_CHANGED"]);
    expect(report.tabs.find((tab) => tab.tabId === 13)!.limitations[0]!.detail).toMatch(/cannot find rightSidebar/);
    expect(codes(14)).toEqual(["GUEST"]);
    const guest = report.tabs[0]!.limitations[0]!;
    expect(guest.tools).toContain("inspect_nodes");
    expect(guest.tools).not.toContain("get_neighbors");
    expect(guest.fix).toMatch(/sign in/);
    expect(report.tabs[1]!.limitations[0]).toMatchObject({ tools: ["inspect_nodes", "snapshot_layer", "export_asset", "export_assets"], fix: null });
    ext.ws.close();
  });

  it("says what the one open file cannot do even when it is READY", async () => {
    const bridge = await startBridge();
    bridges.push(bridge);
    const ext = await pairFakeExtension(bridge.port);
    void ext.next((m) => m.type === "request").then((request) => {
      const tabs = [sampleTab({ capabilities: { ...sampleTab().capabilities, mirrorDom: false } })];
      ext.send({ type: "response", id: (request as { id: string }).id, ok: true, result: { tabs } });
    });

    const report = await callGetStatus(bridge);
    expect(report.status).toBe("READY");
    expect(report.hint).toMatch(/screen reader mirror is off.*get_visual_neighbors fails.*Adapt content for screen readers/);
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
