import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { GetAnchorOutputSchema, QuerySnapshotOutputSchema, SnapshotOutputSchema, SummarizeSnapshotOutputSchema, type LayerNode, type RequestMessage, type SnapshotLayer } from "@figloo/protocol";
import type { Bridge } from "../src/bridge.js";
import { MAX_OUTPUT_BYTES } from "../src/exploration.js";
import { createServer } from "../src/server.js";
import { SnapshotStore, outlineLine, parseSnapshotId, snapshotId } from "../src/snapshots.js";
import { pairFakeExtension, startBridge } from "./helpers.js";

const identity = { pageId: "page-1", fileKey: "abc", page: "Page 1" };
const HOUR = 3_600_000;

function layer(ref: string, overrides: Partial<SnapshotLayer> = {}): SnapshotLayer {
  return {
    ref,
    name: "Layer",
    type: "Frame",
    depth: 1,
    parentRef: "570:1",
    position: 1,
    siblingCount: 1,
    hasChildren: false,
    hidden: false,
    bounds: { x: 0, y: 0, width: 10, height: 10, source: "mirror" },
    sections: [],
    exports: [],
    ...overrides,
  };
}

const content = (text: string) => ({ kind: "content", group: "typography" as const, title: "Content", properties: [], colors: [], text });

/** A screen with a header holding a title and a button, a hidden group with a note, and a photo. */
const screen: SnapshotLayer[] = [
  layer("570:1", { name: "Screen", depth: 0, parentRef: null, hasChildren: true, bounds: { x: 0, y: 0, width: 393, height: 852, source: "mirror" } }),
  layer("570:2", { name: "Header", type: "Auto layout", hasChildren: true, bounds: { x: 0, y: 0, width: 393, height: 64, source: "mirror" } }),
  layer("570:3", { name: "Title", type: "Text", depth: 2, parentRef: "570:2", bounds: { x: null, y: null, width: 120, height: 24, source: "unknown" }, sections: [content("Welcome back")] }),
  layer("570:4", { name: "Button", type: "Instance", depth: 2, parentRef: "570:2", position: 2, hasChildren: true, bounds: { x: 297, y: 12, width: 80, height: 40, source: "mirror" } }),
  layer("570:5", { name: "Marks", type: "Group", position: 2, hasChildren: true, hidden: true, bounds: { x: 0, y: 100, width: 393, height: 200, source: "mirror" } }),
  layer("570:6", { name: "Note", type: "Text", depth: 2, parentRef: "570:5", hidden: true, bounds: { x: 10, y: 110, width: 50, height: 20, source: "panel" }, sections: [content("Note")] }),
  layer("570:7", { name: "Photo", type: "Image", position: 3, exports: ["PNG 2x", "SVG 1x"], bounds: { x: 0, y: 300, width: 393, height: 300, source: "mirror" } }),
];

const image = { data: Buffer.from("jpeg bytes").toString("base64"), mimeType: "image/jpeg", width: 748, height: 1568 };

function complete(layers: SnapshotLayer[]) {
  return {
    status: "complete",
    identity,
    layers,
    rootOnScreen: { x: 421.28, y: 40.27, width: 363.94, height: 788.99 },
    zoom: 0.926,
    walkMs: 5_600,
    userSelectionRestored: true,
    uiOps: 491,
    elapsedMs: 38_800,
    image,
    crop: { x: 409.28, y: 28.27, width: 387.94, height: 812.99 },
    rootInImage: { x: 23.137, y: 23.141, width: 701.67, height: 1521.68 },
    imageScale: 1.785_431,
    alignment: "corrected",
  };
}

const root: LayerNode = { ref: "570:1", name: "Screen", nameTruncated: false, type: "Frame", depth: 0, position: 1, siblingCount: 3, parentRef: null, hasChildren: true, childCount: null, insideInstance: false, link: null };

type Reply = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

const bridges: Bridge[] = [];
const clients: Client[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup({ layers = screen, snapshot }: { layers?: SnapshotLayer[]; snapshot?: (request: RequestMessage) => Reply } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "figloo-snapshots-"));
  dirs.push(dir);
  const clock = { now: Date.parse("2026-10-01T09:00:00Z") };
  const store = new SnapshotStore(join(dir, "snapshots"), 24 * HOUR, () => clock.now);
  const bridge = await startBridge();
  bridges.push(bridge);
  const ext = await pairFakeExtension(bridge.port);
  const requests: RequestMessage[] = [];
  const anchored = (ref: string) => ({ identity, selectionCount: 1, anchor: { ...root, ref }, anchors: [{ ...root, ref }], uiOps: 1, elapsedMs: 5 });
  let anchorRef = "570:1";
  ext.ws.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { type: string };
    if (message.type !== "request") return;
    const request = message as RequestMessage;
    requests.push(request);
    const reply: Reply =
      request.op === "get_anchor"
        ? { ok: true, result: anchored(anchorRef) }
        : request.op === "snapshot_layer"
          ? (snapshot?.(request) ?? { ok: true, result: complete(layers) })
          : { ok: true, result: { identity, nodes: [], userSelectionRestored: true, uiOps: 0, elapsedMs: 1 } };
    ext.send({ type: "response", id: request.id, ...reply } as never);
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ bridge, version: "test", log: () => {}, snapshots: store }).connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const errorOf = (result: Awaited<ReturnType<typeof call>>) => {
    expect(result.isError).toBe(true);
    return JSON.parse((result.content as { text: string }[])[0]!.text).error as { code: string; message: string; hint: string | null };
  };
  const anchor = async (ref = "570:1") => {
    anchorRef = ref;
    return GetAnchorOutputSchema.parse((await call("get_anchor", { tabId: 7 })).structuredContent).contextId;
  };
  const snap = async (args: Record<string, unknown>) => SnapshotOutputSchema.parse((await call("snapshot_layer", args)).structuredContent);
  const query = async (args: Record<string, unknown>) => QuerySnapshotOutputSchema.parse((await call("query_snapshot", args)).structuredContent);
  const snapshotsOf = () => requests.filter((request) => request.op === "snapshot_layer");
  return { dir: join(dir, "snapshots"), clock, requests, call, errorOf, anchor, snap, query, snapshotsOf };
}

describe("snapshot ids and files", () => {
  it("turns a root's colon into a dash so every system accepts the file name, and refuses anything else", () => {
    expect(snapshotId("AbCd", "570:14192")).toBe("AbCd/570-14192");
    expect(parseSnapshotId("AbCd/570-14192")).toEqual({ fileKey: "AbCd", ref: "570:14192" });
    expect(() => snapshotId("AbCd", "I570:4;1:2")).toThrow();
    expect(() => snapshotId("../etc", "570:1")).toThrow();
    for (const id of ["AbCd/../570-1", "../AbCd/570-1", "AbCd/570:1", "AbCd/570-1.json"]) expect(parseSnapshotId(id)).toBeNull();
  });

  it("writes one line per layer with its place, the start of differing text, and marks", () => {
    const lines = screen.map(outlineLine);
    expect(lines[0]).toBe('570:1 Frame "Screen" 0,0 393×852');
    expect(lines[2]).toBe('    570:3 Text "Title" ?,? 120×24 text "Welcome back"');
    expect(lines[3]).toBe('    570:4 Instance "Button" 297,12 80×40 [has layers]');
    // A text layer named after its content does not repeat it.
    expect(lines[5]).toBe('    570:6 Text "Note" 10,110 50×20 [hidden]');
    expect(lines[6]).toBe('  570:7 Image "Photo" 0,300 393×300 [export PNG 2x, SVG 1x]');
  });
});

describe("snapshot_layer", () => {
  it("reads Figma once, saves the snapshot privately outside the project, and answers again from the file", async () => {
    const { dir, anchor, snap, snapshotsOf } = await setup();
    const contextId = await anchor();

    const first = await snap({ contextId, ref: "570:1" });
    expect(first).toMatchObject({ snapshot: "abc/570-1", fromCache: false, layerCount: 7, outlineLayers: 7, nextCursor: null, rootRef: "570:1" });
    expect(first.image).toEqual({ alignment: "corrected", width: 748, height: 1568, rootInImage: { x: 23.1, y: 23.1, width: 701.7, height: 1521.7 }, scale: 1.7854 });
    expect(first.outline.split("\n")).toHaveLength(7);
    expect(Date.parse(first.expiresAt) - Date.parse(first.createdAt)).toBe(24 * HOUR);
    expect(snapshotsOf()).toHaveLength(1);
    expect(snapshotsOf()[0]).toMatchObject({ params: { expect: identity, ref: "570:1" } });

    expect(readdirSync(join(dir, "abc")).sort()).toEqual(["570-1.jpg", "570-1.json"]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "abc")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "abc", "570-1.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "abc", "570-1.jpg")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "abc", "570-1.jpg")).toString()).toBe("jpeg bytes");

    const again = await snap({ contextId: await anchor(), ref: "570:1" });
    expect(again).toMatchObject({ fromCache: true, createdAt: first.createdAt, outline: first.outline });
    expect(snapshotsOf()).toHaveLength(1);
  });

  it("returns the screenshot along with the outline", async () => {
    const { anchor, call } = await setup();
    const result = await call("snapshot_layer", { contextId: await anchor(), ref: "570:1" });
    const parts = result.content as { type: string; data?: string; mimeType?: string }[];
    expect(parts[0]).toEqual({ type: "image", data: image.data, mimeType: "image/jpeg" });
    expect(parts[1]!.type).toBe("text");
  });

  it("lets the context use every ref of the snapshot, so a deep layer can be inspected or exported right away", async () => {
    const { anchor, snap, call } = await setup();
    const contextId = await anchor();
    await snap({ contextId, ref: "570:1" });
    const inspected = await call("inspect_nodes", { contextId, refs: ["570:6"] });
    expect(inspected.isError).toBeFalsy();
  });

  it("reads Figma again with refresh, and once the snapshot expired", async () => {
    const { clock, anchor, snap, snapshotsOf } = await setup();
    const contextId = await anchor();
    await snap({ contextId, ref: "570:1" });

    expect(await snap({ contextId, ref: "570:1", refresh: true })).toMatchObject({ fromCache: false });
    expect(snapshotsOf()).toHaveLength(2);

    clock.now += 24 * HOUR + 1;
    expect(await snap({ contextId, ref: "570:1" })).toMatchObject({ fromCache: false });
    expect(snapshotsOf()).toHaveLength(3);
  });

  it("treats a file of another format version as no snapshot", async () => {
    const { dir, anchor, snap, snapshotsOf } = await setup();
    const contextId = await anchor();
    await snap({ contextId, ref: "570:1" });
    const path = join(dir, "abc", "570-1.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), formatVersion: 1 }));

    expect(await snap({ contextId, ref: "570:1" })).toMatchObject({ fromCache: false });
    expect(snapshotsOf()).toHaveLength(2);
  });

  it("removes the expired snapshots of the same file when it saves a new one", async () => {
    const { dir, clock, anchor, snap } = await setup();
    await snap({ contextId: await anchor("570:1"), ref: "570:1" });
    clock.now += 23 * HOUR;
    await snap({ contextId: await anchor("570:2"), ref: "570:2" });
    clock.now += 2 * HOUR; // The first snapshot has expired, the second has not.
    await snap({ contextId: await anchor("570:7"), ref: "570:7" });
    expect(readdirSync(join(dir, "abc")).sort()).toEqual(["570-2.jpg", "570-2.json", "570-7.jpg", "570-7.json"]);
  });

  it("cuts a long outline to fit one result and continues it with query_snapshot", async () => {
    const many = [screen[0]!, ...Array.from({ length: 600 }, (_, i) => layer(`600:${i + 1}`, { name: `Row ${i + 1} with a fairly long layer name`, position: i + 1, siblingCount: 600 }))];
    const { anchor, snap, query, call } = await setup({ layers: many });
    const first = await snap({ contextId: await anchor(), ref: "570:1" });
    const result = await call("snapshot_layer", { contextId: await anchor(), ref: "570:1" });
    expect(Buffer.byteLength((result.content as { text?: string }[])[1]!.text!)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(first.outlineLayers).toBeLessThan(601);
    expect(first.nextCursor).not.toBeNull();

    const refs = first.outline.split("\n").map((line) => line.trim().split(" ")[0]);
    let cursor = first.nextCursor;
    for (let guard = 0; cursor && guard < 10; guard += 1) {
      const page = await query({ snapshot: first.snapshot, cursor });
      refs.push(...page.outline!.split("\n").map((line) => line.trim().split(" ")[0]));
      cursor = page.nextCursor;
    }
    expect(refs).toEqual(many.map((l) => l.ref));
  });

  it("reports a subtree that is too large with the root's children, which the context may then use", async () => {
    const children = [{ ...root, ref: "570:2", name: "Header", depth: 1, parentRef: "570:1" }, { ...root, ref: "570:5", name: "Marks", type: "Group", depth: 1, parentRef: "570:1" }];
    const { anchor, call, errorOf, snapshotsOf } = await setup({
      snapshot: () => ({ ok: true, result: { status: "too_large", identity, maxLayers: 400, children, childrenHasMore: false, userSelectionRestored: true, uiOps: 300, elapsedMs: 9_000 } }),
    });
    const contextId = await anchor();
    const error = errorOf(await call("snapshot_layer", { contextId, ref: "570:1" }));
    expect(error.code).toBe("SUBTREE_TOO_LARGE");
    expect(error.message).toContain('570:2 Frame "Header"; 570:5 Group "Marks"');
    expect(error.hint).toMatch(/smaller root/);
    // The child is known now, so the agent can snapshot it next.
    errorOf(await call("snapshot_layer", { contextId, ref: "570:5" }));
    expect(snapshotsOf().at(-1)).toMatchObject({ params: { ref: "570:5" } });
  });

  it("refuses a root inside an instance without asking Figma", async () => {
    const { anchor, call, errorOf, snapshotsOf } = await setup();
    const contextId = await anchor("I570:4;1:2");
    expect(errorOf(await call("snapshot_layer", { contextId, ref: "I570:4;1:2" })).code).toBe("INSIDE_INSTANCE");
    expect(snapshotsOf()).toHaveLength(0);
  });
});

describe("query_snapshot", () => {
  async function snapped() {
    const tools = await setup();
    const { snapshot } = await tools.snap({ contextId: await tools.anchor(), ref: "570:1" });
    return { ...tools, snapshot };
  }
  const refsOf = (outline: string | null) => (outline ? outline.split("\n").map((line) => line.trim().split(" ")[0]) : []);

  it("finds layers by name or text content regardless of case, by type, and inside a layer, and combines the filters", async () => {
    const { snapshot, query } = await snapped();
    expect(refsOf((await query({ snapshot, text: "welcome" })).outline)).toEqual(["570:3"]);
    expect(refsOf((await query({ snapshot, text: "NOTE" })).outline)).toEqual(["570:6"]);
    expect(refsOf((await query({ snapshot, type: "text" })).outline)).toEqual(["570:3", "570:6"]);
    expect(refsOf((await query({ snapshot, under: "570:2" })).outline)).toEqual(["570:3", "570:4"]);
    expect(refsOf((await query({ snapshot, under: "570:2", type: "Text" })).outline)).toEqual(["570:3"]);
    const none = await query({ snapshot, under: "570:7" });
    expect(none).toMatchObject({ matched: 0, from: 1, outline: "", hasMore: false });
  });

  it("returns requested layers in full and names the ones the snapshot does not have", async () => {
    const { snapshot, query, call, errorOf } = await snapped();
    const result = await query({ snapshot, refs: ["570:7", "999:1", "570:3"] });
    expect(result.layers!.map((l) => l.ref)).toEqual(["570:7", "570:3"]);
    expect(result.layers![0]).toMatchObject({ exports: ["PNG 2x", "SVG 1x"], bounds: { source: "mirror" } });
    expect(result.missing).toEqual(["999:1"]);
    expect(errorOf(await call("query_snapshot", { snapshot, refs: ["570:7"], type: "Text" })).code).toBe("INVALID_ARGUMENT");
  });

  it("returns matches in full with details, a page at a time, and refuses a cursor from another query", async () => {
    const { snapshot, query, call, errorOf } = await snapped();
    const detailed = await query({ snapshot, type: "Text", details: true });
    expect(detailed).toMatchObject({ outline: null, matched: 2 });
    expect(detailed.layers!.map((l) => l.sections[0]?.text)).toEqual(["Welcome back", "Note"]);

    const many = [screen[0]!, ...Array.from({ length: 50 }, (_, i) => layer(`600:${i + 1}`, { position: i + 1, siblingCount: 50 }))];
    const tools = await setup({ layers: many });
    const { snapshot: big } = await tools.snap({ contextId: await tools.anchor(), ref: "570:1" });
    const first = await tools.query({ snapshot: big, details: true });
    expect(first.layers).toHaveLength(20);
    expect(first.hasMore).toBe(true);
    const second = await tools.query({ snapshot: big, details: true, cursor: first.nextCursor });
    expect(second).toMatchObject({ from: 21 });
    expect(second.layers![0]!.ref).toBe(many[20]!.ref);
    expect(tools.errorOf(await tools.call("query_snapshot", { snapshot: big, type: "Frame", cursor: first.nextCursor })).code).toBe("INVALID_CURSOR");
    expect(errorOf(await call("query_snapshot", { snapshot, cursor: first.nextCursor })).code).toBe("INVALID_CURSOR");
  });

  it("works without Figma, and tells the agent to take a new snapshot once it expired", async () => {
    const { snapshot, query, call, errorOf, clock } = await snapped();
    expect((await query({ snapshot, under: "570:5" })).matched).toBe(1);
    clock.now += 24 * HOUR;
    const error = errorOf(await call("query_snapshot", { snapshot }));
    expect(error.code).toBe("SNAPSHOT_EXPIRED");
    expect(error.hint).toMatch(/snapshot_layer/);
    expect(errorOf(await call("query_snapshot", { snapshot: "abc/1-1" })).code).toBe("SNAPSHOT_NOT_FOUND");
    expect(errorOf(await call("query_snapshot", { snapshot: "../../etc/passwd" })).code).toBe("SNAPSHOT_NOT_FOUND");
    expect(errorOf(await call("query_snapshot", { snapshot, under: "999:1" })).code).toBe("SNAPSHOT_EXPIRED");
  });

  it("refuses an under ref the snapshot does not have", async () => {
    const { snapshot, call, errorOf } = await snapped();
    const error = errorOf(await call("query_snapshot", { snapshot, under: "999:1" }));
    expect(error.code).toBe("UNKNOWN_REF");
    expect(error.hint).toMatch(/outline/);
  });
});

describe("summarize_snapshot", () => {
  const colors = (value: string) => ({ kind: "colors", group: "appearance" as const, title: "Colors", properties: [], colors: [{ value, opacity: null }], text: null });
  const styled: SnapshotLayer[] = [
    screen[0]!,
    layer("570:2", { name: "Header", type: "Auto layout", hasChildren: true, sections: [colors("#FFFFFF")] }),
    layer("570:3", { name: "Title", type: "Text", depth: 2, parentRef: "570:2", sections: [colors("#111111")] }),
    layer("570:4", { name: "Button", type: "Instance", depth: 2, parentRef: "570:2", position: 2, hasChildren: true, sections: [colors("#0055FF")] }),
    layer("570:5", { name: "Marks", type: "Group", position: 2, hidden: true, sections: [colors("#FF0000")] }),
  ];
  const summarize = async (tools: Awaited<ReturnType<typeof setup>>, args: Record<string, unknown>) =>
    SummarizeSnapshotOutputSchema.parse((await tools.call("summarize_snapshot", args)).structuredContent);

  it("summarizes a saved snapshot without asking Figma, or one section of it with under", async () => {
    const tools = await setup({ layers: styled });
    const { snapshot } = await tools.snap({ contextId: await tools.anchor(), ref: "570:1" });
    const asked = tools.requests.length;

    const all = await summarize(tools, { snapshot });
    expect(all).toMatchObject({ snapshot, layers: 4, hiddenSkipped: 1, truncated: false });
    expect(all.colors.map((c) => [c.value, c.uses])).toEqual([
      ["#0055FF", ["fill"]],
      ["#111111", ["text"]],
      ["#FFFFFF", ["fill"]],
    ]);
    expect(all.components).toEqual([{ name: "Button", count: 1, refs: ["570:4"], variants: [] }]);

    // The section's own layer counts, as its background is part of the section.
    const header = await summarize(tools, { snapshot, under: "570:2" });
    expect(header.layers).toBe(3);
    expect(header.colors.map((c) => c.value)).toEqual(["#0055FF", "#111111", "#FFFFFF"]);
    expect(tools.requests.length).toBe(asked);
  });

  it("fits a large snapshot into one result, cutting the rarest values", async () => {
    const many = [screen[0]!, ...Array.from({ length: 600 }, (_, i) => layer(`600:${i + 1}`, { name: `Row ${i + 1}`, position: i + 1, siblingCount: 600, sections: [colors(`#${String(i).padStart(6, "0")}`)] }))];
    const tools = await setup({ layers: many });
    const { snapshot } = await tools.snap({ contextId: await tools.anchor(), ref: "570:1" });
    const result = await tools.call("summarize_snapshot", { snapshot });
    expect(Buffer.byteLength((result.content as { text: string }[])[0]!.text)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(SummarizeSnapshotOutputSchema.parse(result.structuredContent)).toMatchObject({ layers: 601, truncated: true });
  });

  it("refuses an unknown section, a missing snapshot, and an expired one", async () => {
    const tools = await setup({ layers: styled });
    const { snapshot } = await tools.snap({ contextId: await tools.anchor(), ref: "570:1" });
    const unknown = tools.errorOf(await tools.call("summarize_snapshot", { snapshot, under: "999:1" }));
    expect(unknown).toMatchObject({ code: "UNKNOWN_REF", hint: expect.stringMatching(/outline/) });
    expect(tools.errorOf(await tools.call("summarize_snapshot", { snapshot: "abc/1-1" })).code).toBe("SNAPSHOT_NOT_FOUND");
    tools.clock.now += 24 * HOUR;
    expect(tools.errorOf(await tools.call("summarize_snapshot", { snapshot })).code).toBe("SNAPSHOT_EXPIRED");
  });
});
