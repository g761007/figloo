import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXTENSION_ID } from "@figloo/protocol";
import { DEFAULT_TITLE, ICONS } from "../src/action.js";

interface Manifest {
  key: string;
  icons: Record<string, string>;
  action: { default_icon: Record<string, string>; default_title: string };
}

const STATIC_DIR = new URL("../static/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", STATIC_DIR), "utf8")) as Manifest;

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): [number, number] {
  const bytes = readFileSync(new URL(path, STATIC_DIR));
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe("manifest", () => {
  it("pins the extension ID the bridge allows", () => {
    const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
    const id = [...digest].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
    expect(id).toBe(EXTENSION_ID);
  });

  it("ships every icon the manifest and the service worker refer to, at its declared size", () => {
    for (const set of [manifest.icons, manifest.action.default_icon, ICONS.color, ICONS.gray]) {
      for (const [size, path] of Object.entries(set)) {
        expect(existsSync(new URL(path, STATIC_DIR)), path).toBe(true);
        expect(pngSize(path), path).toEqual([Number(size), Number(size)]);
      }
    }
  });

  it("defaults to the same gray icon and title the service worker restores", () => {
    expect(manifest.action.default_icon).toEqual(ICONS.gray);
    expect(manifest.action.default_title).toBe(DEFAULT_TITLE);
  });
});
