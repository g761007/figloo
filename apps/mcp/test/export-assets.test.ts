import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { ExportAssetsOutputSchema, GetAnchorOutputSchema, type RequestMessage, type SnapshotLayer } from "@figloo/protocol";
import type { Bridge } from "../src/bridge.js";
import { createServer } from "../src/server.js";
import { SnapshotStore } from "../src/snapshots.js";
import { pairFakeExtension, startBridge } from "./helpers.js";

const identity = { pageId: "page-1", fileKey: "abc", page: "Page 1" };
const node = (ref: string) => ({ ref, name: "Icons", nameTruncated: false, type: "Frame", depth: 0, position: 1, siblingCount: 1, parentRef: null, hasChildren: true, childCount: null, insideInstance: false, link: null });
const svg = (ref: string) => `<svg data-ref="${ref}"/>`;

type Reply = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

/** What the tab hands back for one layer: Figma names the file after the layer. */
const exported = (name: string, ref: string): Reply => ({
  ok: true,
  result: {
    identity,
    source: "direct",
    files: [{ name, mimeType: "image/svg+xml", data: Buffer.from(svg(ref)).toString("base64"), downloadPath: null }],
    onlyFormat: null,
    usedExistingSettings: true,
    userSelectionRestored: true,
    elapsedMs: 900,
  },
});
const failure = (code: string): Reply => ({ ok: false, error: { code, message: `${code} for this layer` } });

function layer(ref: string, overrides: Partial<SnapshotLayer> = {}): SnapshotLayer {
  return {
    ref,
    name: "Icon",
    type: "Vector",
    depth: 1,
    parentRef: "9:1",
    position: 1,
    siblingCount: 1,
    hasChildren: false,
    hidden: false,
    bounds: { x: 0, y: 0, width: 16, height: 16, source: "mirror" },
    sections: [],
    exports: ["SVG 1x"],
    ...overrides,
  };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(reply: (ref: string, request: RequestMessage) => Reply, { exportMs = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "figloo-export-assets-"));
  const clock = { now: Date.parse("2026-10-02T09:00:00Z") };
  const store = new SnapshotStore(join(root, ".snapshots"), 24 * 3_600_000, () => clock.now);
  const bridge: Bridge = await startBridge();
  const ext = await pairFakeExtension(bridge.port);
  const requests: RequestMessage[] = [];
  ext.ws.on("message", (data) => {
    const message = JSON.parse(data.toString()) as RequestMessage;
    if (message.type !== "request") return;
    requests.push(message);
    if (message.op === "get_anchor") {
      ext.send({ type: "response", id: message.id, ok: true, result: { identity, selectionCount: 1, anchor: node("9:1"), anchors: [node("9:1")], uiOps: 1, elapsedMs: 5 } } as never);
      return;
    }
    // Each export takes exportMs on the server's clock.
    clock.now += exportMs;
    ext.send({ type: "response", id: message.id, ...reply(String(message.params!.ref), message) } as never);
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ bridge, version: "test", log: () => {}, root, snapshots: store, now: () => clock.now }).connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  cleanups.push(() => bridge.stop(), () => client.close(), () => rmSync(root, { recursive: true, force: true }));
  const { contextId } = GetAnchorOutputSchema.parse((await client.callTool({ name: "get_anchor", arguments: { tabId: 7 } })).structuredContent);
  const call = (args: Record<string, unknown>) => client.callTool({ name: "export_assets", arguments: { contextId, saveTo: "icons/", ...args } });
  const run = async (args: Record<string, unknown>) => ExportAssetsOutputSchema.parse((await call(args)).structuredContent);
  const errorOf = async (args: Record<string, unknown>) => JSON.parse(((await call(args)).content as { text: string }[])[0]!.text).error as { code: string; message: string };
  const exports = () => requests.filter((request) => request.op === "export_asset");
  const saveSnapshot = (layers: SnapshotLayer[], extra: { fileKey?: string; page?: string | null; rootPath?: string[] } = {}) =>
    store.write(
      {
        fileKey: extra.fileKey ?? "abc",
        page: extra.page === undefined ? "Page 1" : extra.page,
        rootRef: layers[0]!.ref,
        elapsedMs: 1,
        image: { alignment: "confirmed", width: 10, height: 10, rootInImage: null, scale: null },
        zoom: 1,
        ...(extra.rootPath ? { rootPath: extra.rootPath } : {}),
        layers,
      },
      Buffer.from("jpeg"),
    );
  return { root, clock, requests, call, run, errorOf, exports, saveSnapshot };
}

const iconSheet = [
  layer("9:1", { name: "Icons", type: "Frame", depth: 0, parentRef: null, hasChildren: true, exports: [] }),
  layer("9:2", { name: "Close" }),
  layer("9:3", { name: "Hidden", hidden: true }),
  layer("9:4", { name: "Label", type: "Text", exports: [] }),
  layer("9:5", { name: "Tabs", type: "Frame", hasChildren: true, exports: [] }),
  layer("9:6", { name: "Home", depth: 2, parentRef: "9:5" }),
  layer("9:7", { name: "Search", depth: 2, parentRef: "9:5", exports: ["PNG 2x", "SVG 1x"] }),
];

describe("export_assets", () => {
  it("exports the refs it is given, once each, into the folder", async () => {
    const tools = await setup((ref) => exported("Icons.svg", ref));
    const output = await tools.run({ refs: ["9:1", "9:1"] });
    expect(output.saved).toEqual([
      { ref: "9:1", source: "direct", usedExistingSettings: true, files: [{ name: "Icons.svg", mimeType: "image/svg+xml", bytes: svg("9:1").length, savedTo: join(tools.root, "icons/Icons.svg"), downloadPath: null }] },
    ]);
    expect(readFileSync(join(tools.root, "icons/Icons.svg"), "utf8")).toBe(svg("9:1"));
    expect(tools.exports()).toHaveLength(1);
  });

  it("exports every layer a snapshot marks for export, in panel order, and skips the hidden ones", async () => {
    const tools = await setup((ref) => exported(ref === "9:7" ? "Search.svg" : `${ref.replace(":", "-")}.svg`, ref));
    const saved = await tools.saveSnapshot(iconSheet);
    const output = await tools.run({ snapshot: saved.id });
    expect(tools.exports().map((request) => request.params!.ref)).toEqual(["9:2", "9:6", "9:7"]);
    expect(output.saved.map((entry) => entry.ref)).toEqual(["9:2", "9:6", "9:7"]);
    expect(output.skipped).toEqual([{ ref: "9:3", reason: "hidden" }]);
    expect(output).toMatchObject({ failed: [], remaining: [], stoppedBy: null, userSelectionRestored: true });
    expect(readdirSync(join(tools.root, "icons")).sort()).toEqual(["9-2.svg", "9-6.svg", "Search.svg"]);

    const section = await tools.run({ snapshot: saved.id, under: "9:5", overwrite: true });
    expect(section.saved.map((entry) => entry.ref)).toEqual(["9:6", "9:7"]);
  });

  it("adds the layer's ref to a file name the call already wrote", async () => {
    const tools = await setup((ref) => exported("Vector.svg", ref));
    const saved = await tools.saveSnapshot(iconSheet);
    const output = await tools.run({ snapshot: saved.id });
    expect(output.saved.map((entry) => entry.files[0]!.name)).toEqual(["Vector.svg", "Vector-9-6.svg", "Vector-9-7.svg"]);
    expect(readFileSync(join(tools.root, "icons/Vector-9-6.svg"), "utf8")).toBe(svg("9:6"));
  });

  it("sends the tab the way down to each layer, so it finds them after the page reloaded", async () => {
    const tools = await setup((ref) => exported(`${ref.replace(":", "-")}.svg`, ref));
    const saved = await tools.saveSnapshot(iconSheet, { rootPath: ["1:1"] });
    await tools.run({ snapshot: saved.id, under: "9:5" });
    const known = (tools.exports()[0]!.params!.known as { ref: string; parentRef: string | null }[]).map((k) => `${k.ref}<${k.parentRef}`);
    expect(known).toEqual(["9:6<9:5", "9:5<9:1", "9:1<1:1", "1:1<null"]);
  });

  it("lists a layer that fails and goes on with the rest", async () => {
    const tools = await setup((ref) => (ref === "9:6" ? failure("NODE_NOT_FOUND") : exported(`${ref.replace(":", "-")}.svg`, ref)));
    const output = await tools.run({ snapshot: (await tools.saveSnapshot(iconSheet)).id });
    expect(output.saved.map((entry) => entry.ref)).toEqual(["9:2", "9:7"]);
    expect(output.failed).toEqual([{ ref: "9:6", code: "NODE_NOT_FOUND", message: "NODE_NOT_FOUND for this layer" }]);
    expect(output.stoppedBy).toBeNull();
  });

  it("goes on after a layer Figma hands no file over for, which is about that layer, not the rest", async () => {
    const tools = await setup((ref) => (ref === "9:2" ? failure("EXPORT_BLOCKED") : exported(`${ref.replace(":", "-")}.svg`, ref)));
    const output = await tools.run({ snapshot: (await tools.saveSnapshot(iconSheet)).id });
    expect(output.failed.map((f) => `${f.ref}:${f.code}`)).toEqual(["9:2:EXPORT_BLOCKED"]);
    expect(output.saved.map((entry) => entry.ref)).toEqual(["9:6", "9:7"]);
    expect(output.stoppedBy).toBeNull();
  });

  it("stops when the Figma tab goes to the background and hands back the layers it did not get to", async () => {
    const tools = await setup((ref) => (ref === "9:6" ? failure("TAB_IN_BACKGROUND") : exported(`${ref.replace(":", "-")}.svg`, ref)));
    const output = await tools.run({ snapshot: (await tools.saveSnapshot(iconSheet)).id });
    expect(output.saved.map((entry) => entry.ref)).toEqual(["9:2"]);
    expect(output).toMatchObject({ failed: [], remaining: ["9:6", "9:7"], stoppedBy: { code: "TAB_IN_BACKGROUND" } });
    expect(tools.exports()).toHaveLength(2);
  });

  it("writes nothing of a layer whose file is already there, unless overwrite is set", async () => {
    const tools = await setup((ref) => exported("Close.svg", ref));
    mkdirSync(join(tools.root, "icons"));
    writeFileSync(join(tools.root, "icons/Close.svg"), "mine");
    const snapshot = (await tools.saveSnapshot(iconSheet.slice(0, 2))).id;
    const kept = await tools.run({ snapshot });
    expect(kept.failed).toMatchObject([{ ref: "9:2", code: "SAVE_REFUSED" }]);
    expect(readFileSync(join(tools.root, "icons/Close.svg"), "utf8")).toBe("mine");

    const replaced = await tools.run({ snapshot, overwrite: true });
    expect(replaced.saved).toHaveLength(1);
    expect(readFileSync(join(tools.root, "icons/Close.svg"), "utf8")).toBe(svg("9:2"));
  });

  it("starts no export once its time budget is spent and returns the rest to continue with", async () => {
    const tools = await setup((ref) => exported(`${ref.replace(":", "-")}.svg`, ref), { exportMs: 60_000 });
    const many = [iconSheet[0]!, ...Array.from({ length: 5 }, (_, i) => layer(`8:${i + 1}`, { position: i + 1, siblingCount: 5 }))];
    const output = await tools.run({ snapshot: (await tools.saveSnapshot(many)).id });
    // Exports start at 0, 60, and 120 seconds; the fourth would start at 180.
    expect(output.saved.map((entry) => entry.ref)).toEqual(["8:1", "8:2", "8:3"]);
    expect(output.remaining).toEqual(["8:4", "8:5"]);
    expect(output.stoppedBy).toBeNull();
  });

  it("exports at most 50 layers in one call", async () => {
    const tools = await setup((ref) => exported(`${ref.replace(":", "-")}.svg`, ref));
    const many = [iconSheet[0]!, ...Array.from({ length: 55 }, (_, i) => layer(`8:${i + 1}`, { position: i + 1, siblingCount: 55 }))];
    const output = await tools.run({ snapshot: (await tools.saveSnapshot(many)).id });
    expect(output.saved).toHaveLength(50);
    expect(output.remaining).toEqual(["8:51", "8:52", "8:53", "8:54", "8:55"]);
  });

  it("refuses a snapshot of another file or page, unknown refs, and both kinds of input at once", async () => {
    const tools = await setup((ref) => exported("x.svg", ref));
    expect((await tools.errorOf({ snapshot: (await tools.saveSnapshot(iconSheet, { fileKey: "other" })).id })).code).toBe("INVALID_ARGUMENT");
    expect((await tools.errorOf({ snapshot: (await tools.saveSnapshot(iconSheet, { page: "Page 2" })).id })).message).toMatch(/explore_page/);
    expect((await tools.errorOf({ refs: ["9:9"] })).code).toBe("UNKNOWN_REF");
    expect((await tools.errorOf({ refs: ["9:1"], snapshot: "abc/9-1" })).code).toBe("INVALID_ARGUMENT");
    expect((await tools.errorOf({ snapshot: "abc/1-1" })).code).toBe("SNAPSHOT_NOT_FOUND");
    expect(tools.exports()).toHaveLength(0);
    expect(existsSync(join(tools.root, "icons"))).toBe(false);
  });
});
