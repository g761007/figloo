import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateConfig } from "../src/config.js";

const previous = process.env.FIGLOO_CONFIG_DIR;
let dir = "";
afterEach(() => {
  if (previous === undefined) delete process.env.FIGLOO_CONFIG_DIR;
  else process.env.FIGLOO_CONFIG_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

describe("loadOrCreateConfig", () => {
  it("reads the snapshot lifetime and keeps it when it fills in missing settings", () => {
    dir = mkdtempSync(join(tmpdir(), "figloo-config-"));
    process.env.FIGLOO_CONFIG_DIR = dir;
    writeFileSync(join(dir, "config.json"), JSON.stringify({ token: "t", snapshotTtlHours: 6 }));

    expect(loadOrCreateConfig()).toMatchObject({ token: "t", snapshotTtlHours: 6 });
    // The port and extension IDs were missing, so the file was written again with the lifetime kept.
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).toMatchObject({ token: "t", snapshotTtlHours: 6, port: 47129 });
  });

  it("uses 24 hours without a valid lifetime", () => {
    dir = mkdtempSync(join(tmpdir(), "figloo-config-"));
    process.env.FIGLOO_CONFIG_DIR = dir;
    writeFileSync(join(dir, "config.json"), JSON.stringify({ token: "t", snapshotTtlHours: -1 }));
    expect(loadOrCreateConfig().snapshotTtlHours).toBe(24);
  });
});
