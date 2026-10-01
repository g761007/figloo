import { describe, expect, it } from "vitest";
import { parseFigmaUrl } from "../src/figma-url.js";

describe("parseFigmaUrl", () => {
  it("reads key, decoded name, and node id from a design URL", () => {
    const info = parseFigmaUrl("https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/Sample-App?node-id=338-4231&p=f&t=abc-0");
    expect(info).toEqual({ isDesignFile: true, fileKey: "AbCdEfGhIjKlMnOpQrStUv", fileName: "Sample-App", nodeId: "338:4231" });
  });

  it("accepts the legacy /file/ path and a missing node id", () => {
    const info = parseFigmaUrl("https://www.figma.com/file/abc123/My%20File");
    expect(info).toEqual({ isDesignFile: true, fileKey: "abc123", fileName: "My File", nodeId: null });
  });

  it("ignores non-design Figma pages and other hosts", () => {
    expect(parseFigmaUrl("https://www.figma.com/files/recent").isDesignFile).toBe(false);
    expect(parseFigmaUrl("https://example.com/design/abc/x").isDesignFile).toBe(false);
    expect(parseFigmaUrl("not a url").isDesignFile).toBe(false);
  });
});
