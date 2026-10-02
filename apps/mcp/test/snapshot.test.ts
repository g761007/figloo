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
    readFrom: 0,
    walked: layers.map(({ ref, parentRef }) => ({ ref, parentRef })),
    restarted: false,
    // The screen sits right on the page.
    rootPath: [],
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
    const lines = screen.map((layer) => outlineLine(layer));
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

  it("sends the tab the way down to a snapshot's layers, so it finds them after the page reloaded", async () => {
    const nested = { ok: true as const, result: { ...complete(screen), rootPath: ["500:1", "500:2"] } };
    const { anchor, snap, call, requests } = await setup({ snapshot: () => nested });
    const contextId = await anchor();
    await snap({ contextId, ref: "570:1" });
    await call("inspect_nodes", { contextId, refs: ["570:6"] });
    const inspect = requests.find((request) => request.op === "inspect_nodes")!;
    expect(inspect.params).toMatchObject({ refs: ["570:6"] });
    expect(new Map((inspect.params!.known as { ref: string; parentRef: string | null }[]).map((k) => [k.ref, k.parentRef]))).toEqual(
      new Map([
        ["570:6", "570:5"],
        ["570:5", "570:1"],
        ["570:1", "500:2"],
        ["500:2", "500:1"],
        ["500:1", null],
      ]),
    );
  });

  it("takes the root of an earlier snapshot from a new context, as after a reload, and lets it use every ref", async () => {
    const { anchor, snap, call, errorOf, requests, snapshotsOf } = await setup();
    await snap({ contextId: await anchor("570:1"), ref: "570:1" });
    // The page reloaded: the new context starts from another layer and has never seen the screen.
    const fresh = await anchor("570:7");
    expect(await snap({ contextId: fresh, ref: "570:1" })).toMatchObject({ fromCache: true });
    expect(snapshotsOf()).toHaveLength(1);
    expect((await call("inspect_nodes", { contextId: fresh, refs: ["570:3"] })).isError).toBeFalsy();
    expect(requests.at(-1)!.params).toMatchObject({ known: expect.arrayContaining([{ ref: "570:3", parentRef: "570:2" }, { ref: "570:1", parentRef: null }]) });
    // A ref no snapshot vouches for is still refused.
    expect(errorOf(await call("snapshot_layer", { contextId: fresh, ref: "570:9" })).code).toBe("UNKNOWN_REF");
  });

  it("reads an expired snapshot's root again with the way down to it that the old file kept", async () => {
    const nested = { ok: true as const, result: { ...complete(screen), rootPath: ["500:1"] } };
    const { clock, anchor, snap, snapshotsOf } = await setup({ snapshot: () => nested });
    await snap({ contextId: await anchor("570:1"), ref: "570:1" });
    clock.now += 25 * HOUR;
    expect(await snap({ contextId: await anchor("570:7"), ref: "570:1" })).toMatchObject({ fromCache: false });
    expect(snapshotsOf().at(-1)!.params).toMatchObject({
      ref: "570:1",
      known: [
        { ref: "500:1", parentRef: null },
        { ref: "570:1", parentRef: "500:1" },
      ].reverse(),
    });
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

  it("keeps expired snapshots 30 days as baselines, then removes them when it saves a new one of the file", async () => {
    const { dir, clock, anchor, snap } = await setup();
    await snap({ contextId: await anchor("570:1"), ref: "570:1" });
    clock.now += 23 * HOUR;
    await snap({ contextId: await anchor("570:2"), ref: "570:2" });
    clock.now += 2 * HOUR; // The first snapshot has expired, the second has not.
    await snap({ contextId: await anchor("570:7"), ref: "570:7" });
    expect(readdirSync(join(dir, "abc")).sort()).toEqual(["570-1.jpg", "570-1.json", "570-2.jpg", "570-2.json", "570-7.jpg", "570-7.json"]);
    // 30 days after it expired, the first one goes; the others expired later and stay a little longer.
    clock.now += 30 * 24 * HOUR;
    await snap({ contextId: await anchor("570:7"), ref: "570:7", refresh: true });
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

describe("snapshot_layer over several calls", () => {
  const imageOf = (text: string) => ({ ...image, data: Buffer.from(text).toString("base64") });
  const walked = screen.map(({ ref, parentRef }) => ({ ref, parentRef }));
  /** What the tab answers when a call reads layers [from, to) of the screen. */
  function reply(status: "partial" | "complete", from: number, to: number, shot: string, restarted = false): Reply {
    return { ok: true, result: { ...complete(screen), status, layers: screen.slice(from, to), readFrom: from, walked, restarted, image: imageOf(shot) } };
  }

  it("goes on where the last call stopped, and keeps the first call's screenshot", async () => {
    const calls: { readFrom: number; structure: string[]; placed: { ref: string }[] }[] = [];
    const tools = await setup({
      snapshot: (request) => {
        const resume = request.params!.resume as (typeof calls)[number];
        calls.push(resume);
        return resume.readFrom === 0 ? reply("partial", 0, 3, "first shot") : reply("complete", resume.readFrom, screen.length, "second shot");
      },
    });
    const contextId = await tools.anchor();

    const first = await tools.call("snapshot_layer", { contextId, ref: "570:1" });
    const progress = SnapshotOutputSchema.parse(first.structuredContent);
    expect(progress).toMatchObject({ complete: false, progress: { read: 3, total: 7 }, outline: "", outlineLayers: 0, layerCount: 7 });
    // No screenshot until the snapshot is whole, so a long read does not fill the agent's context.
    expect((first.content as { type: string }[]).map((part) => part.type)).toEqual(["text"]);
    expect(readdirSync(join(tools.dir, "abc")).sort()).toEqual(["570-1.partial.jpg", "570-1.partial.json"]);

    const done = await tools.call("snapshot_layer", { contextId, ref: "570:1" });
    const whole = SnapshotOutputSchema.parse(done.structuredContent);
    expect(whole).toMatchObject({ complete: true, progress: { read: 7, total: 7 }, layerCount: 7, outlineLayers: 7, createdAt: progress.createdAt });
    expect((done.content as { data?: string }[])[0]!.data).toBe(imageOf("first shot").data);
    expect(readdirSync(join(tools.dir, "abc")).sort()).toEqual(["570-1.jpg", "570-1.json"]);

    expect(calls[1]).toMatchObject({ readFrom: 3, structure: screen.map(({ ref, parentRef }) => `${ref}|${parentRef}`) });
    // The layers left sit in the header and the screen, which the first call read; the hidden group was not read yet.
    expect(calls[1]!.placed.map((layer) => layer.ref).sort()).toEqual(["570:1", "570:2"]);
    expect((await tools.query({ snapshot: whole.snapshot })).matched).toBe(7);
  });

  it("starts over with the new walk and its screenshot when the design changed between calls", async () => {
    const tools = await setup({
      snapshot: (request) => ((request.params!.resume as { readFrom: number }).readFrom === 0 ? reply("partial", 0, 3, "old shot") : reply("complete", 0, screen.length, "new shot", true)),
    });
    const contextId = await tools.anchor();
    await tools.snap({ contextId, ref: "570:1" });
    const done = await tools.call("snapshot_layer", { contextId, ref: "570:1" });
    expect(SnapshotOutputSchema.parse(done.structuredContent)).toMatchObject({ complete: true, layerCount: 7 });
    expect((done.content as { data?: string }[])[0]!.data).toBe(imageOf("new shot").data);
  });

  it("goes on with a refresh read over several calls instead of answering from the older snapshot meanwhile", async () => {
    const resumes: number[] = [];
    let partial = false;
    const tools = await setup({
      snapshot: (request) => {
        const { readFrom } = request.params!.resume as { readFrom: number };
        resumes.push(readFrom);
        if (!partial) return { ok: true, result: complete(screen) };
        return readFrom === 0 ? reply("partial", 0, 3, "new shot") : reply("complete", readFrom, screen.length, "unused");
      },
    });
    const contextId = await tools.anchor();
    const { snapshot } = await tools.snap({ contextId, ref: "570:1" });
    partial = true;
    expect(await tools.snap({ contextId, ref: "570:1", refresh: true })).toMatchObject({ complete: false });
    // Until the new read is whole, the older snapshot is not handed out as if it were current.
    expect(tools.errorOf(await tools.call("query_snapshot", { snapshot })).code).toBe("SNAPSHOT_INCOMPLETE");
    expect(await tools.snap({ contextId, ref: "570:1" })).toMatchObject({ complete: true, fromCache: false });
    expect(resumes).toEqual([0, 0, 3]);
  });

  it("answers SNAPSHOT_INCOMPLETE for a snapshot still being read, and drops it on refresh", async () => {
    const resumes: number[] = [];
    const tools = await setup({
      snapshot: (request) => {
        resumes.push((request.params!.resume as { readFrom: number }).readFrom);
        return reply("partial", 0, 3, "shot");
      },
    });
    const contextId = await tools.anchor();
    const { snapshot } = await tools.snap({ contextId, ref: "570:1" });
    for (const name of ["query_snapshot", "summarize_snapshot"]) {
      const error = tools.errorOf(await tools.call(name, { snapshot }));
      expect(error).toMatchObject({ code: "SNAPSHOT_INCOMPLETE", message: expect.stringContaining("3 of 7") });
      expect(error.hint).toMatch(/snapshot_layer again/);
    }
    await tools.snap({ contextId, ref: "570:1", refresh: true });
    expect(resumes).toEqual([0, 0]);
  });

  it("lets a snapshot still being read expire like a finished one, and removes it then", async () => {
    let call = 0;
    const tools = await setup({ snapshot: (request) => (call++ === 0 ? reply("partial", 0, 3, "shot") : { ok: true, result: complete(screen) }) });
    await tools.snap({ contextId: await tools.anchor(), ref: "570:1" });
    tools.clock.now += 25 * HOUR;
    // Another root of the same file is snapshotted, which sweeps the expired files of the file.
    await tools.snap({ contextId: await tools.anchor("570:7"), ref: "570:7" });
    expect(readdirSync(join(tools.dir, "abc")).sort()).toEqual(["570-7.jpg", "570-7.json"]);
  });
});

describe("snapshot changes", () => {
  /** The screen again after the designer worked on it: new title text, the photo gone, a new badge. */
  const revised: SnapshotLayer[] = [
    ...screen.slice(0, 2),
    { ...screen[2]!, sections: [content("Welcome back, Ann")] },
    ...screen.slice(3, 6),
    layer("570:8", { name: "Badge", position: 3 }),
  ];

  it("has none for a root snapshotted the first time", async () => {
    const tools = await setup();
    expect(await tools.snap({ contextId: await tools.anchor(), ref: "570:1" })).toMatchObject({ changes: null });
  });

  it("finds none when the design did not change", async () => {
    const tools = await setup();
    const contextId = await tools.anchor();
    await tools.snap({ contextId, ref: "570:1" });
    expect(await tools.snap({ contextId, ref: "570:1", refresh: true })).toMatchObject({ changes: { added: 0, changed: 0, removed: 0, removedLayers: [] } });
  });

  it("reports what changed since the previous snapshot, marks it in the outline, and lists it with query_snapshot", async () => {
    let layers = screen;
    const tools = await setup({ snapshot: () => ({ ok: true, result: complete(layers) }) });
    const contextId = await tools.anchor();
    const first = await tools.snap({ contextId, ref: "570:1" });
    layers = revised;
    const second = await tools.snap({ contextId, ref: "570:1", refresh: true });
    expect(second.changes).toEqual({ since: first.createdAt, added: 1, changed: 1, removed: 1, removedLayers: [{ ref: "570:7", name: "Photo", type: "Image" }] });
    const lines = second.outline.split("\n");
    expect(lines.find((line) => line.includes("570:3"))).toMatch(/\[changed: content\]$/);
    expect(lines.find((line) => line.includes("570:8"))).toMatch(/\[new\]$/);
    expect(lines.filter((line) => line.includes("[changed") || line.includes("[new]"))).toHaveLength(2);

    const listed = await tools.query({ snapshot: second.snapshot, changed: true });
    expect(listed.outline!.split("\n").map((line) => line.trim().split(" ")[0])).toEqual(["570:3", "570:8"]);
    // The changes stay with the snapshot, so a later call from the cache reports them too.
    expect(await tools.snap({ contextId, ref: "570:1" })).toMatchObject({ fromCache: true, changes: { added: 1, changed: 1, removed: 1 } });
  });

  it("compares with an expired snapshot within 30 days, and with none after that", async () => {
    let layers = screen;
    const tools = await setup({ snapshot: () => ({ ok: true, result: complete(layers) }) });
    await tools.snap({ contextId: await tools.anchor(), ref: "570:1" });
    tools.clock.now += 10 * 24 * HOUR;
    layers = revised;
    expect(await tools.snap({ contextId: await tools.anchor(), ref: "570:1" })).toMatchObject({ fromCache: false, changes: { added: 1, removed: 1 } });

    tools.clock.now += 32 * 24 * HOUR;
    // Saving another root of the file sweeps the old snapshot first.
    await tools.snap({ contextId: await tools.anchor("570:2"), ref: "570:2" });
    expect(await tools.snap({ contextId: await tools.anchor(), ref: "570:1" })).toMatchObject({ changes: null });
  });
});
