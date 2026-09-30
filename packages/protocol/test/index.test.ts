import { describe, expect, it } from "vitest";
import {
  ConnectionStatusSchema,
  ExtensionMessageSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  TabStatusSchema,
  protocolCompatible,
} from "../src/index.js";

describe("ConnectionStatusSchema", () => {
  it("accepts a status defined by the plan", () => {
    expect(ConnectionStatusSchema.parse("READY")).toBe("READY");
  });

  it("rejects a value outside the enum", () => {
    expect(ConnectionStatusSchema.safeParse("CONNECTED").success).toBe(false);
  });
});

describe("protocolCompatible", () => {
  it("requires the same minor while the protocol is 0.x", () => {
    expect(protocolCompatible("0.1.0", "0.1.5")).toBe(true);
    expect(protocolCompatible("0.1.0", "0.2.0")).toBe(false);
  });

  it("only requires the same major from 1.x on", () => {
    expect(protocolCompatible("1.0.0", "1.4.0")).toBe(true);
    expect(protocolCompatible("1.0.0", "2.0.0")).toBe(false);
  });
});

describe("bridge messages", () => {
  const tab = {
    tabId: 1,
    windowId: 1,
    url: "https://www.figma.com/design/abc/Name?node-id=1-2",
    title: "Name – Figma",
    fileKey: "abc",
    fileName: "Name",
    nodeIdFromUrl: "1:2",
    readiness: "READY",
    access: "view",
    uiLocale: "en",
    capabilities: { layersPanel: true, focusTarget: true, propertiesPanel: false, mirrorDom: false, uiCollapsed: false },
    layerRowCount: 42,
    probedAt: 1,
    detail: null,
  };

  it("parses a hello message from the extension", () => {
    const parsed = ExtensionMessageSchema.parse({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      token: "t",
      extensionVersion: "0.0.1",
      userAgent: "ua",
    });
    expect(parsed.type).toBe("hello");
  });

  it("rejects a server-only message coming from the extension", () => {
    expect(ExtensionMessageSchema.safeParse({ type: "welcome", protocolVersion: "0.1.0", serverVersion: "0", heartbeatIntervalMs: 1 }).success).toBe(false);
  });

  it("parses a tabs message and a request round trip", () => {
    expect(ExtensionMessageSchema.parse({ type: "tabs", tabs: [tab] }).type).toBe("tabs");
    expect(ServerMessageSchema.parse({ type: "request", id: "r1", op: "refresh_tabs" }).type).toBe("request");
    expect(ExtensionMessageSchema.parse({ type: "response", id: "r1", ok: true, result: { tabs: [tab] } }).type).toBe("response");
  });

  it("rejects a tab status with an unknown readiness", () => {
    expect(TabStatusSchema.safeParse({ ...tab, readiness: "CONNECTED" }).success).toBe(false);
  });
});
