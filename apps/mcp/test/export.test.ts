import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { ExportOutputSchema, GetAnchorOutputSchema, type RequestMessage } from "@figloo/protocol";
import type { Bridge } from "../src/bridge.js";
import { resolveSaveTarget } from "../src/export-asset.js";
import { createServer } from "../src/server.js";
import { pairFakeExtension, startBridge } from "./helpers.js";

const identity = { pageId: "page-1", fileKey: "abc", page: "Page 1" };
const anchorResult = {
  identity,
  selectionCount: 1,
  anchor: { ref: "3:3", name: "Close", nameTruncated: false, type: "Instance", depth: 2, position: 1, siblingCount: 1, parentRef: "2:2", hasChildren: false, childCount: 0, insideInstance: false, link: null },
  get anchors() {
    return [this.anchor];
  },
  uiOps: 1,
  elapsedMs: 5,
};
const SVG = '<svg width="16" height="16" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h16v16H0z"/></svg>';

/** The start of a PNG: enough for its size to be read. */
function pngHeader(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), ihdr]);
}

/** The start of a JPEG: a JFIF segment, then the start of frame that holds the size. */
function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

const PNG = pngHeader(32, 32);

// Written by Python's zipfile to an unseekable stream, so entries use data descriptors like browser
// ZIP libraries: an "icons/" folder, a deflated 關閉.svg (FIXTURE_SVG), and a stored 32x32 關閉@2x.png.
const ZIP = readFileSync(resolve(import.meta.dirname, "../../../tests/fixtures/export/figma-icon-export.zip"));
const FIXTURE_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">\n<path d="M4 4L12 12M12 4L4 12" stroke="#1F1F1F" stroke-width="1.5" stroke-linecap="round"/>\n</svg>\n';

type Reply = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(reply: (request: RequestMessage) => Reply, { rootFromEnv = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "figloo-export-root-"));
  if (rootFromEnv) {
    const previous = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = root;
    cleanups.push(() => {
      if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = previous;
    });
  }
  const bridge: Bridge = await startBridge();
  const ext = await pairFakeExtension(bridge.port);
  const requests: RequestMessage[] = [];
  ext.ws.on("message", (data) => {
    const message = JSON.parse(data.toString()) as RequestMessage;
    if (message.type !== "request") return;
    requests.push(message);
    ext.send({ type: "response", id: message.id, ...(message.op === "get_anchor" ? { ok: true, result: anchorResult } : reply(message)) } as never);
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ bridge, version: "test", log: () => {}, ...(rootFromEnv ? {} : { root }) }).connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  cleanups.push(() => bridge.stop(), () => client.close(), () => rmSync(root, { recursive: true, force: true }));
  const { contextId } = GetAnchorOutputSchema.parse((await client.callTool({ name: "get_anchor", arguments: { tabId: 7 } })).structuredContent);
  const exportAsset = (args: Record<string, unknown>) => client.callTool({ name: "export_asset", arguments: { contextId, ref: "3:3", ...args } });
  return { root, requests, exportAsset };
}

const direct = (files: { name: string; mimeType: string; data: Buffer }[], onlyFormat: string | null = null): Reply => ({
  ok: true,
  result: {
    identity,
    source: "direct",
    files: files.map((f) => ({ name: f.name, mimeType: f.mimeType, data: f.data.toString("base64"), downloadPath: null })),
    onlyFormat,
    usedExistingSettings: false,
    userSelectionRestored: true,
    elapsedMs: 900,
  },
});

const errorOf = (result: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((result.content as { text: string }[])[0]!.text).error;

describe("export_asset", () => {
  it("hands SVG markup straight to the agent when the page captured the file", async () => {
    const { requests, exportAsset } = await setup(() => direct([{ name: "Close.svg", mimeType: "image/svg+xml", data: Buffer.from(SVG) }]));
    const result = await exportAsset({ format: "svg" });
    const output = ExportOutputSchema.parse(result.structuredContent);
    expect(output).toMatchObject({ source: "direct", userSelectionRestored: true });
    expect(output.files[0]).toMatchObject({ name: "Close.svg", svg: SVG, savedTo: null, downloadPath: null, bytes: SVG.length });
    expect(requests.at(-1)).toMatchObject({ op: "export_asset", tabId: 7, params: { expect: identity, ref: "3:3", format: "svg" } });
  });

  it("shows PNG exports to the agent as images", async () => {
    const { exportAsset } = await setup(() => direct([{ name: "Close@2x.png", mimeType: "image/png", data: PNG }]));
    const result = await exportAsset({ format: "png", scale: "2x" });
    const content = result.content as { type: string; mimeType?: string }[];
    expect(content.some((block) => block.type === "image" && block.mimeType === "image/png")).toBe(true);
    expect(ExportOutputSchema.parse(result.structuredContent).files[0]?.svg).toBeNull();
  });

  it("writes the file into the project with saveTo, keeping Figma's name for a directory", async () => {
    const { root, exportAsset } = await setup(() => direct([{ name: "Close.svg", mimeType: "image/svg+xml", data: Buffer.from(SVG) }]));
    const output = ExportOutputSchema.parse((await exportAsset({ saveTo: "src/assets/icons/" })).structuredContent);
    expect(output.files[0]?.savedTo).toBe(join(root, "src/assets/icons/Close.svg"));
    expect(readFileSync(join(root, "src/assets/icons/Close.svg"), "utf8")).toBe(SVG);
  });

  it("saves into the project Claude Code names, not the server's working directory", async () => {
    const { root, exportAsset } = await setup(() => direct([{ name: "Close.svg", mimeType: "image/svg+xml", data: Buffer.from(SVG) }]), { rootFromEnv: true });
    const output = ExportOutputSchema.parse((await exportAsset({ saveTo: "icons/close.svg" })).structuredContent);
    expect(root).not.toBe(process.cwd());
    expect(output.files[0]?.savedTo).toBe(join(root, "icons/close.svg"));
    expect(readFileSync(join(root, "icons/close.svg"), "utf8")).toBe(SVG);
  });

  it("refuses to replace an existing file unless asked, and never writes outside the project", async () => {
    const { root, exportAsset } = await setup(() => direct([{ name: "Close.svg", mimeType: "image/svg+xml", data: Buffer.from(SVG) }]));
    writeFileSync(join(root, "close.svg"), "old");
    const refused = await exportAsset({ saveTo: "close.svg" });
    expect(refused.isError).toBe(true);
    expect(JSON.parse((refused.content as { text: string }[])[0]!.text).error.code).toBe("SAVE_REFUSED");
    expect(readFileSync(join(root, "close.svg"), "utf8")).toBe("old");

    const replaced = await exportAsset({ saveTo: "close.svg", overwrite: true });
    expect(replaced.isError).toBeFalsy();
    expect(readFileSync(join(root, "close.svg"), "utf8")).toBe(SVG);

    const outside = await exportAsset({ saveTo: "../escape.svg" });
    expect(JSON.parse((outside.content as { text: string }[])[0]!.text).error.code).toBe("SAVE_REFUSED");
  });

  it("falls back to the browser's download and reads the file from where it was saved", async () => {
    const downloads = mkdtempSync(join(tmpdir(), "figloo-downloads-"));
    cleanups.push(() => rmSync(downloads, { recursive: true, force: true }));
    const path = join(downloads, "Sample App Close.svg");
    writeFileSync(path, SVG);
    const { exportAsset } = await setup(() => ({
      ok: true,
      result: { identity, source: "download", files: [{ name: "Sample App Close.svg", mimeType: "image/svg+xml", data: null, downloadPath: path }], onlyFormat: null, usedExistingSettings: true, userSelectionRestored: true, elapsedMs: 3000 },
    }));
    const output = ExportOutputSchema.parse((await exportAsset({})).structuredContent);
    expect(output).toMatchObject({ source: "download", usedExistingSettings: true });
    expect(output.files[0]).toMatchObject({ svg: SVG, downloadPath: path });
  });

  it("opens the ZIP Figma packs files into and hands over each file", async () => {
    const { root, exportAsset } = await setup(() => direct([{ name: "Sample App.zip", mimeType: "application/zip", data: ZIP }]));
    const result = await exportAsset({ saveTo: "src/assets/" });
    const output = ExportOutputSchema.parse(result.structuredContent);
    expect(output.files.map((f) => [f.name, f.mimeType])).toEqual([
      ["關閉.svg", "image/svg+xml"],
      ["關閉@2x.png", "image/png"],
    ]);
    expect(output.files[0]?.svg).toBe(FIXTURE_SVG);
    expect(readFileSync(join(root, "src/assets/關閉.svg"), "utf8")).toBe(FIXTURE_SVG);
    const png = readFileSync(join(root, "src/assets/關閉@2x.png"));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([32, 32]);
    const images = (result.content as { type: string; data?: string }[]).filter((block) => block.type === "image");
    expect(images.map((block) => Buffer.from(block.data!, "base64").equals(png))).toEqual([true]);
  });

  it("keeps only the requested format when the designer's own settings were exported too", async () => {
    const { exportAsset } = await setup(() => direct([{ name: "Sample App.zip", mimeType: "application/zip", data: ZIP }], "svg"));
    const output = ExportOutputSchema.parse((await exportAsset({ format: "svg" })).structuredContent);
    expect(output.files.map((f) => f.name)).toEqual(["關閉.svg"]);

    const { exportAsset: exportPdf } = await setup(() => direct([{ name: "Sample App.zip", mimeType: "application/zip", data: ZIP }], "pdf"));
    const missing = await exportPdf({ format: "pdf" });
    expect(missing.isError).toBe(true);
    expect(errorOf(missing).message).toMatch(/exported 關閉\.svg, 關閉@2x\.png, but no pdf file/);
  });

  it("shows only images small enough to view, and still saves the large ones", async () => {
    const wide = pngHeader(4000, 10);
    const { root, exportAsset } = await setup(() =>
      direct([
        { name: "Banner@4x.png", mimeType: "image/png", data: wide },
        { name: "Avatar.jpg", mimeType: "image/jpeg", data: jpegHeader(96, 96) },
      ]),
    );
    const result = await exportAsset({ saveTo: "out/" });
    const images = (result.content as { type: string; mimeType?: string }[]).filter((block) => block.type === "image");
    expect(images.map((block) => block.mimeType)).toEqual(["image/jpeg"]);
    expect(readFileSync(join(root, "out/Banner@4x.png")).equals(wide)).toBe(true);
  });

  it("explains a blocked export and refuses refs the context never returned", async () => {
    const { requests, exportAsset } = await setup(() => ({ ok: false, error: { code: "EXPORT_BLOCKED", message: "no file" } }));
    const blocked = JSON.parse(((await exportAsset({})).content as { text: string }[])[0]!.text).error;
    expect(blocked.code).toBe("EXPORT_BLOCKED");
    expect(blocked.hint).toMatch(/allow them in the site settings/);

    const before = requests.length;
    const unknown = await exportAsset({ ref: "9:9" });
    expect(JSON.parse((unknown.content as { text: string }[])[0]!.text).error.code).toBe("UNKNOWN_REF");
    expect(requests.length).toBe(before);
  });
});

describe("resolveSaveTarget", () => {
  it("keeps paths inside the root and treats several files as a directory", () => {
    expect(resolveSaveTarget("/project", "icons/close.svg", "Close.svg", false)).toBe("/project/icons/close.svg");
    expect(resolveSaveTarget("/project", "icons", "Close.svg", true)).toBe("/project/icons/Close.svg");
    expect(() => resolveSaveTarget("/project", "/etc/passwd", "x", false)).toThrow(/outside the project/);
    expect(() => resolveSaveTarget("/project", "", "x", false)).toThrow(/outside the project/);
  });
});
