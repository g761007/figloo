import { describe, expect, it } from "vitest";
import {
  ConnectionStatusSchema,
  ExtensionMessageSchema,
  LayerNodeSchema,
  ListNeighborsParamsSchema,
  MAX_NEIGHBOR_LIMIT,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  SnapshotResultSchema,
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
    visible: true,
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

describe("exploration schemas", () => {
  const node = {
    ref: "338:4231",
    name: "Button",
    nameTruncated: false,
    type: "Instance",
    depth: 3,
    position: 2,
    siblingCount: 4,
    parentRef: "338:4200",
    hasChildren: true,
    childCount: null,
    insideInstance: false,
    link: "https://www.figma.com/design/abc/Name?node-id=338-4231",
  };

  it("accepts an op error code in a bridge response", () => {
    const parsed = ExtensionMessageSchema.parse({ type: "response", id: "r", ok: false, error: { code: "NO_SELECTION", message: "select a layer" } });
    expect(parsed.type).toBe("response");
  });

  it("caps list_neighbors at the plan's per-call limit", () => {
    const params = { expect: { pageId: "p", fileKey: "abc", page: null }, ref: "1:2", relation: "children", from: 1 };
    expect(ListNeighborsParamsSchema.safeParse({ ...params, limit: MAX_NEIGHBOR_LIMIT }).success).toBe(true);
    expect(ListNeighborsParamsSchema.safeParse({ ...params, limit: MAX_NEIGHBOR_LIMIT + 1 }).success).toBe(false);
  });

  it("rejects a layer summary without a position among its siblings", () => {
    expect(LayerNodeSchema.safeParse(node).success).toBe(true);
    expect(LayerNodeSchema.safeParse({ ...node, position: 0 }).success).toBe(false);
  });
});

describe("snapshot schemas", () => {
  const identity = { pageId: "p", fileKey: "abc", page: null };
  const counts = { userSelectionRestored: true, uiOps: 120, elapsedMs: 61_000 };
  const layer = {
    ref: "1:3",
    name: "Title",
    type: "Text",
    depth: 1,
    parentRef: "1:2",
    position: 1,
    siblingCount: 2,
    hasChildren: false,
    hidden: false,
    bounds: { x: null, y: null, width: 120, height: 24, source: "unknown" },
    sections: [],
    exports: [],
  };

  it("keeps the size of a layer Figma shows no position for", () => {
    const image = { data: "", mimeType: "image/jpeg", width: 748, height: 1568 };
    const complete = { status: "complete", identity, layers: [layer], rootOnScreen: null, zoom: null, walkMs: 4_000, ...counts, image, crop: { x: 1, y: 2, width: 388, height: 813 }, rootInImage: null, imageScale: null };
    const parsed = SnapshotResultSchema.parse(complete);
    expect(parsed.status === "complete" && parsed.layers[0]!.bounds).toEqual({ x: null, y: null, width: 120, height: 24, source: "unknown" });
    expect(SnapshotResultSchema.safeParse({ ...complete, layers: [{ ...layer, bounds: { ...layer.bounds, source: "guess" } }] }).success).toBe(false);
  });

  it("reports a subtree that is too large with the root's children instead of layers", () => {
    const tooLarge = { status: "too_large", identity, maxLayers: 400, children: [], childrenHasMore: false, ...counts };
    expect(SnapshotResultSchema.safeParse(tooLarge).success).toBe(true);
    // A too-large result never carries layers that would look like a partial snapshot.
    expect(SnapshotResultSchema.parse({ ...tooLarge, layers: [layer] })).not.toHaveProperty("layers");
  });
});
