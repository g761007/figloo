import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  CaptureOutputSchema,
  ExplorePageOutputSchema,
  GetAnchorOutputSchema,
  VisualNeighborsOutputSchema,
  GetNeighborsOutputSchema,
  InspectNodesOutputSchema,
  type LayerNode,
  type RequestMessage,
} from "@figloo/protocol";
import type { Bridge } from "../src/bridge.js";
import { MAX_OUTPUT_BYTES } from "../src/exploration.js";
import { createServer } from "../src/server.js";
import { pairFakeExtension, startBridge, type FakeExtension } from "./helpers.js";

const identity = { pageId: "page-1", fileKey: "abc", page: "Page 1" };

function node(ref: string, overrides: Partial<LayerNode> = {}): LayerNode {
  return {
    ref,
    name: "Layer",
    nameTruncated: false,
    type: "Frame",
    depth: 2,
    position: 1,
    siblingCount: 1,
    parentRef: "1:1",
    hasChildren: false,
    childCount: 0,
    insideInstance: false,
    link: null,
    ...overrides,
  };
}

type Handler = (request: RequestMessage) => { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

/** Answers every request the bridge sends with `handler`, and records the requests. */
function serve(ext: FakeExtension, handler: Handler): RequestMessage[] {
  const seen: RequestMessage[] = [];
  ext.ws.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { type: string };
    if (message.type !== "request") return;
    const request = message as RequestMessage;
    seen.push(request);
    ext.send({ type: "response", id: request.id, ...handler(request) } as never);
  });
  return seen;
}

const button = node("3:3", { name: "Button", type: "Instance", depth: 3, parentRef: "2:2" });
const anchorResult = { identity, selectionCount: 1, anchor: button, anchors: [button], uiOps: 2, elapsedMs: 12 };

const bridges: Bridge[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
});

async function setup(handler: Handler) {
  const bridge = await startBridge();
  bridges.push(bridge);
  const ext = await pairFakeExtension(bridge.port);
  const requests = serve(ext, handler);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ bridge, version: "test", log: () => {} }).connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const errorOf = (result: Awaited<ReturnType<typeof call>>) => {
    expect(result.isError).toBe(true);
    return JSON.parse((result.content as { text: string }[])[0]!.text).error as { code: string; hint: string | null };
  };
  return { requests, call, errorOf };
}

describe("get_anchor", () => {
  it("creates a context pinned to the tab and page load of the selection", async () => {
    const { requests, call } = await setup(() => ({ ok: true, result: anchorResult }));
    const output = GetAnchorOutputSchema.parse((await call("get_anchor", { tabId: 7 })).structuredContent);
    expect(output).toMatchObject({ tabId: 7, fileKey: "abc", page: "Page 1", anchor: { ref: "3:3", name: "Button" } });
    expect(output.contextId).toMatch(/^ctx_/);
    expect(requests[0]).toMatchObject({ op: "get_anchor", tabId: 7 });
  });

  it("passes on why there is no anchor, with a next step for the agent", async () => {
    const { call, errorOf } = await setup(() => ({ ok: false, error: { code: "NO_SELECTION", message: "no layer is selected in Figma" } }));
    const error = errorOf(await call("get_anchor", { tabId: 7 }));
    expect(error.code).toBe("NO_SELECTION");
    expect(error.hint).toMatch(/select the layers to work on/);
  });
});

describe("get_neighbors", () => {
  it("only explores refs this context returned, without asking the tab", async () => {
    const { requests, call, errorOf } = await setup((request) => (request.op === "get_anchor" ? { ok: true, result: anchorResult } : { ok: true, result: {} }));
    const { contextId } = GetAnchorOutputSchema.parse((await call("get_anchor", { tabId: 7 })).structuredContent);

    const error = errorOf(await call("get_neighbors", { contextId, ref: "9:9", relation: "children" }));
    expect(error.code).toBe("UNKNOWN_REF");
    expect(requests.filter((request) => request.op === "list_neighbors")).toHaveLength(0);
  });

  it("accepts the anchor's parent right away, since get_anchor already confirmed it", async () => {
    const { call } = await setup((request) =>
      request.op === "get_anchor"
        ? { ok: true, result: anchorResult }
        : { ok: true, result: { identity, nodes: [node("3:3")], total: 1, from: 1, nextFrom: null, hasMore: false, stopReason: "complete", uiOps: 0, elapsedMs: 1 } },
    );
    const { contextId } = GetAnchorOutputSchema.parse((await call("get_anchor", { tabId: 7 })).structuredContent);
    const result = await call("get_neighbors", { contextId, ref: "2:2", relation: "children" });
    expect(result.isError).toBeFalsy();
  });

  it("takes every selected layer as an anchor, so each one and its parent can be explored", async () => {
    const card = node("4:4", { name: "Card", type: "Component", depth: 2, parentRef: "1:1" });
    const { call } = await setup((request) =>
      request.op === "get_anchor"
        ? { ok: true, result: { ...anchorResult, selectionCount: 2, anchors: [button, card] } }
        : { ok: true, result: { identity, nodes: [node("5:5")], total: 1, from: 1, nextFrom: null, hasMore: false, stopReason: "complete", uiOps: 0, elapsedMs: 1 } },
    );
    const output = GetAnchorOutputSchema.parse((await call("get_anchor", { tabId: 7 })).structuredContent);
    expect(output.anchor.ref).toBe("3:3");
    expect(output.anchors.map((anchor) => anchor.ref)).toEqual(["3:3", "4:4"]);
    for (const ref of ["4:4", "1:1"]) {
      expect((await call("get_neighbors", { contextId: output.contextId, ref, relation: "children" })).isError).toBeFalsy();
    }
  });

  it("pins every request to the context's page load and resumes pages from the cursor", async () => {
    const page = (from: number, count: number, total: number) =>
      Array.from({ length: count }, (_, i) => node(`5:${from + i}`, { position: from + i, siblingCount: total, parentRef: "3:3" }));
    const { requests, call } = await setup((request) => {
      if (request.op === "get_anchor") return { ok: true, result: anchorResult };
      const from = (request.params as { from: number }).from;
      const nodes = page(from, from === 1 ? 20 : 5, 25);
      const hasMore = from === 1;
      return { ok: true, result: { identity, nodes, total: 25, from, nextFrom: hasMore ? 21 : null, hasMore, stopReason: hasMore ? "limit" : "complete", uiOps: 1, elapsedMs: 5 } };
    });
    const { contextId } = GetAnchorOutputSchema.parse((await call("get_anchor", { tabId: 7 })).structuredContent);

    const first = GetNeighborsOutputSchema.parse((await call("get_neighbors", { contextId, ref: "3:3", relation: "children" })).structuredContent);
    expect(first).toMatchObject({ hasMore: true, stopReason: "limit", coverage: { fromPosition: 1, toPosition: 20, total: 25 } });
    expect(requests.at(-1)).toMatchObject({ op: "list_neighbors", tabId: 7, params: { expect: identity, ref: "3:3", relation: "children", from: 1, limit: 20 } });

    const second = GetNeighborsOutputSchema.parse((await call("get_neighbors", { contextId, ref: "3:3", relation: "children", cursor: first.nextCursor })).structuredContent);
    expect(requests.at(-1)).toMatchObject({ params: { from: 21, after: "5:20" } });
    expect(second).toMatchObject({ hasMore: false, nextCursor: null, coverage: { fromPosition: 21, toPosition: 25 } });

    // Layers from an earlier page are refs the agent may explore next.
    const deeper = await call("get_neighbors", { contextId, ref: "5:22", relation: "children" });
    expect(deeper.isError).toBeFalsy();
  });

  it("rejects a cursor issued for another ref or relation", async () => {
    const { call, errorOf } = await setup((request) =>
      request.op === "get_anchor"
        ? { ok: true, result: anchorResult }
        : { ok: true, result: { identity, nodes: [node("5:1", { siblingCount: 2 })], total: 2, from: 1, nextFrom: 2, hasMore: true, stopReason: "limit", uiOps: 1, elapsedMs: 5 } },
    );
    const { contextId } = GetAnchorOutputSchema.parse((await call("get_anchor", { tabId: 7 })).structuredContent);
    const first = GetNeighborsOutputSchema.parse((await call("get_neighbors", { contextId, ref: "3:3", relation: "children", limit: 1 })).structuredContent);

    expect(errorOf(await call("get_neighbors", { contextId, ref: "3:3", relation: "siblings", cursor: first.nextCursor })).code).toBe("INVALID_CURSOR");
    expect(errorOf(await call("get_neighbors", { contextId, ref: "3:3", relation: "children", cursor: "not-a-cursor" })).code).toBe("INVALID_CURSOR");
  });

  it("drops the context once the tab reports that the page was reloaded", async () => {
    const { call, errorOf } = await setup((request) =>
      request.op === "get_anchor" ? { ok: true, result: anchorResult } : { ok: false, error: { code: "CONTEXT_EXPIRED", message: "the Figma tab was reloaded" } },
    );
    const { contextId } = GetAnchorOutputSchema.parse((await call("get_anchor", { tabId: 7 })).structuredContent);

    expect(errorOf(await call("get_neighbors", { contextId, ref: "3:3", relation: "parent" })).code).toBe("CONTEXT_EXPIRED");
    expect(errorOf(await call("get_neighbors", { contextId, ref: "3:3", relation: "parent" })).code).toBe("CONTEXT_NOT_FOUND");
  });

  it("trims a page to the output budget and resumes at the first layer it dropped", async () => {
    const longName = "x".repeat(1_000);
    const nodes = Array.from({ length: 50 }, (_, i) => node(`6:${i + 1}`, { name: longName, position: i + 1, siblingCount: 60, parentRef: "3:3" }));
    const { call } = await setup((request) =>
      request.op === "get_anchor"
        ? { ok: true, result: anchorResult }
        : { ok: true, result: { identity, nodes, total: 60, from: 1, nextFrom: 51, hasMore: true, stopReason: "limit", uiOps: 3, elapsedMs: 40 } },
    );
    const { contextId } = GetAnchorOutputSchema.parse((await call("get_anchor", { tabId: 7 })).structuredContent);

    const result = await call("get_neighbors", { contextId, ref: "3:3", relation: "children", limit: 50 });
    const text = (result.content as { text: string }[])[0]!.text;
    const output = GetNeighborsOutputSchema.parse(result.structuredContent);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(output.nodes.length).toBeLessThan(50);
    expect(output).toMatchObject({ stopReason: "output_budget", hasMore: true });
    const kept = output.nodes.length;
    const cursor = JSON.parse(Buffer.from(output.nextCursor!, "base64url").toString("utf8"));
    expect(cursor).toMatchObject({ from: kept + 1, after: `6:${kept}` });
  });

  it("rejects a limit above the plan's maximum", async () => {
    const { call } = await setup(() => ({ ok: true, result: anchorResult }));
    const { contextId } = GetAnchorOutputSchema.parse((await call("get_anchor", { tabId: 7 })).structuredContent);
    const result = await call("get_neighbors", { contextId, ref: "3:3", relation: "children", limit: 51 });
    expect(result.isError).toBe(true);
  });
});

describe("release_context", () => {
  it("forgets the context so its refs can no longer be explored", async () => {
    const { call, errorOf } = await setup(() => ({ ok: true, result: anchorResult }));
    const { contextId } = GetAnchorOutputSchema.parse((await call("get_anchor", { tabId: 7 })).structuredContent);
    expect((await call("release_context", { contextId })).structuredContent).toEqual({ released: true });
    expect(errorOf(await call("get_neighbors", { contextId, ref: "3:3", relation: "parent" })).code).toBe("CONTEXT_NOT_FOUND");
    expect((await call("release_context", { contextId })).structuredContent).toEqual({ released: false });
  });
});

const topLevel = (count: number) => Array.from({ length: count }, (_, i) => node(`10:${i + 1}`, { depth: 0, position: i + 1, siblingCount: count, parentRef: null, hasChildren: true, childCount: null }));

describe("page entry point", () => {
  it("lists the file's pages", async () => {
    const { requests, call } = await setup(() => ({ ok: true, result: { fileKey: "abc", pages: [{ name: "Home", current: true }, { name: "Specs", current: false }], complete: false } }));
    const result = await call("list_pages", { tabId: 7 });
    expect(result.structuredContent).toEqual({ tabId: 7, fileKey: "abc", pages: [{ name: "Home", current: true }, { name: "Specs", current: false }], complete: false });
    expect(requests[0]).toMatchObject({ op: "list_pages", tabId: 7 });
  });

  it("opens a context from a page, without a selection, whose layers can be explored further", async () => {
    const { requests, call } = await setup((request) => {
      if (request.op === "explore_page") {
        return { ok: true, result: { identity: { ...identity, page: "Specs" }, nodes: topLevel(50), total: 60, from: 1, nextFrom: 51, hasMore: true, stopReason: "limit", uiOps: 3, elapsedMs: 30 } };
      }
      return { ok: true, result: { identity: { ...identity, page: "Specs" }, nodes: [], total: 0, from: 1, nextFrom: null, hasMore: false, stopReason: "complete", uiOps: 0, elapsedMs: 1 } };
    });
    const output = ExplorePageOutputSchema.parse((await call("explore_page", { tabId: 7, page: "Specs" })).structuredContent);
    expect(output).toMatchObject({ page: "Specs", total: 60, hasMore: true });
    expect(requests[0]).toMatchObject({ op: "explore_page", params: { page: "Specs", limit: 50 } });

    const children = await call("get_neighbors", { contextId: output.contextId, ref: "10:5", relation: "children" });
    expect(children.isError).toBeFalsy();
    const next = await call("get_neighbors", { contextId: output.contextId, ref: "10:1", relation: "siblings", cursor: output.nextCursor });
    expect(next.isError).toBeFalsy();
    expect(requests.at(-1)).toMatchObject({ op: "list_neighbors", params: { ref: "10:1", relation: "siblings", from: 51, after: "10:50", expect: { page: "Specs" } } });
  });
});

describe("get_visual_neighbors", () => {
  const placed = (ref: string, side: string, gap: number) => ({ ...node(ref, { parentRef: "2:2" }), side, inLine: true, gap, offset: { x: gap + 100, y: 0 }, size: { width: 40, height: 20 } });
  const visual = {
    identity,
    reference: { width: 100, height: 20 },
    zoom: 0.61,
    neighbors: [placed("3:4", "right", 8), placed("3:5", "right", 24)],
    compared: 4,
    unplaced: ["3:9"],
    siblingsHasMore: false,
    userSelectionRestored: true,
    uiOps: 3,
    elapsedMs: 900,
  };

  it("asks for the nearest ten by default, and lets the agent read the layers it returns", async () => {
    const { requests, call } = await setup((request) =>
      request.op === "get_anchor"
        ? { ok: true, result: anchorResult }
        : request.op === "visual_neighbors"
          ? { ok: true, result: visual }
          : { ok: true, result: { identity, nodes: [], userSelectionRestored: true, uiOps: 1, elapsedMs: 5 } },
    );
    const { contextId } = GetAnchorOutputSchema.parse((await call("get_anchor", { tabId: 7 })).structuredContent);
    const output = VisualNeighborsOutputSchema.parse((await call("get_visual_neighbors", { contextId, ref: "3:3" })).structuredContent);
    expect(requests.find((request) => request.op === "visual_neighbors")?.params).toMatchObject({ expect: identity, ref: "3:3", direction: "nearest", limit: 10 });
    expect(output.neighbors.map((neighbor) => [neighbor.ref, neighbor.side, neighbor.gap])).toEqual([
      ["3:4", "right", 8],
      ["3:5", "right", 24],
    ]);
    expect(output).toMatchObject({ compared: 4, unplaced: ["3:9"], zoom: 0.61 });
    expect((await call("inspect_nodes", { contextId, refs: ["3:4", "3:5"] })).isError).toBeFalsy();
  });

  it("refuses refs the context did not return, without asking the tab", async () => {
    const { requests, call, errorOf } = await setup((request) => (request.op === "get_anchor" ? { ok: true, result: anchorResult } : { ok: true, result: visual }));
    const { contextId } = GetAnchorOutputSchema.parse((await call("get_anchor", { tabId: 7 })).structuredContent);
    expect(errorOf(await call("get_visual_neighbors", { contextId, ref: "9:9", direction: "below" })).code).toBe("UNKNOWN_REF");
    expect(requests.some((request) => request.op === "visual_neighbors")).toBe(false);
  });
});

describe("inspect_nodes", () => {
  const inspected = { ref: "3:3", name: "Button", type: "Instance", sections: [{ kind: "properties", group: "layout", title: "Layout", properties: [{ group: null, name: "Width", value: "16px" }], colors: [], text: null }], notShown: ["typography"] };

  it("reads only layers this context returned and passes the requested groups", async () => {
    const { requests, call, errorOf } = await setup((request) =>
      request.op === "get_anchor" ? { ok: true, result: anchorResult } : { ok: true, result: { identity, nodes: [inspected], userSelectionRestored: true, uiOps: 2, elapsedMs: 300 } },
    );
    const { contextId } = GetAnchorOutputSchema.parse((await call("get_anchor", { tabId: 7 })).structuredContent);

    expect(errorOf(await call("inspect_nodes", { contextId, refs: ["3:3", "9:9"] })).code).toBe("UNKNOWN_REF");
    expect(requests.filter((request) => request.op === "inspect_nodes")).toHaveLength(0);

    const output = InspectNodesOutputSchema.parse((await call("inspect_nodes", { contextId, refs: ["3:3"], groups: ["layout", "typography"] })).structuredContent);
    expect(output.nodes[0]).toMatchObject({ ref: "3:3", notShown: ["typography"] });
    expect(output.userSelectionRestored).toBe(true);
    expect(requests.at(-1)).toMatchObject({ op: "inspect_nodes", tabId: 7, params: { expect: identity, refs: ["3:3"], groups: ["layout", "typography"] } });
  });

  it("caps a call at five layers", async () => {
    const { call } = await setup(() => ({ ok: true, result: anchorResult }));
    const { contextId } = GetAnchorOutputSchema.parse((await call("get_anchor", { tabId: 7 })).structuredContent);
    const result = await call("inspect_nodes", { contextId, refs: ["1", "2", "3", "4", "5", "6"] });
    expect(result.isError).toBe(true);
  });

  it("tells the agent to ask for the Figma tab to be brought forward", async () => {
    const { call, errorOf } = await setup((request) =>
      request.op === "get_anchor" ? { ok: true, result: anchorResult } : { ok: false, error: { code: "TAB_IN_BACKGROUND", message: "the Figma tab is in the background" } },
    );
    const { contextId } = GetAnchorOutputSchema.parse((await call("get_anchor", { tabId: 7 })).structuredContent);
    const error = errorOf(await call("inspect_nodes", { contextId, refs: ["3:3"] }));
    expect(error.code).toBe("TAB_IN_BACKGROUND");
    expect(error.hint).toMatch(/bring the Figma tab to the front/);
  });
});

describe("capture", () => {
  const captured = { identity, image: { data: Buffer.from("jpeg bytes").toString("base64"), mimeType: "image/jpeg", width: 364, height: 789 }, crop: { x: 531, y: 28, width: 388, height: 813 }, cropSource: "layer", zoom: "93%", userSelectionRestored: true, elapsedMs: 900 };

  it("returns the image to the agent along with how it was cropped", async () => {
    const { requests, call } = await setup((request) => (request.op === "get_anchor" ? { ok: true, result: anchorResult } : { ok: true, result: captured }));
    const { contextId } = GetAnchorOutputSchema.parse((await call("get_anchor", { tabId: 7 })).structuredContent);

    const result = await call("capture", { contextId, ref: "3:3" });
    const content = result.content as { type: string; data?: string; mimeType?: string }[];
    expect(content[0]).toEqual({ type: "image", data: captured.image.data, mimeType: "image/jpeg" });
    expect(CaptureOutputSchema.parse(result.structuredContent)).toMatchObject({ ref: "3:3", width: 364, height: 789, cropSource: "layer", userSelectionRestored: true });
    expect(requests.at(-1)).toMatchObject({ op: "capture", params: { expect: identity, ref: "3:3" } });

    await call("capture", { contextId });
    expect(requests.at(-1)).toMatchObject({ op: "capture", params: { ref: null } });
  });

  it("refuses refs the context did not return", async () => {
    const { call, errorOf } = await setup(() => ({ ok: true, result: anchorResult }));
    const { contextId } = GetAnchorOutputSchema.parse((await call("get_anchor", { tabId: 7 })).structuredContent);
    expect(errorOf(await call("capture", { contextId, ref: "9:9" })).code).toBe("UNKNOWN_REF");
  });
});

describe("get_neighbors depth", () => {
  it("passes depth for children and refuses it for other relations", async () => {
    const { requests, call, errorOf } = await setup((request) =>
      request.op === "get_anchor"
        ? { ok: true, result: anchorResult }
        : { ok: true, result: { identity, nodes: [], total: 0, from: 1, nextFrom: null, hasMore: false, stopReason: "complete", uiOps: 0, elapsedMs: 1 } },
    );
    const { contextId } = GetAnchorOutputSchema.parse((await call("get_anchor", { tabId: 7 })).structuredContent);

    await call("get_neighbors", { contextId, ref: "3:3", relation: "children", depth: 3 });
    expect(requests.at(-1)).toMatchObject({ params: { relation: "children", depth: 3 } });
    expect(errorOf(await call("get_neighbors", { contextId, ref: "3:3", relation: "siblings", depth: 2 })).code).toBe("INVALID_ARGUMENT");
    expect((await call("get_neighbors", { contextId, ref: "3:3", relation: "children", depth: 4 })).isError).toBe(true);
  });
});
