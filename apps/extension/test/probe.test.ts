import { describe, expect, it } from "vitest";
import { parseSelectedCount } from "../src/probe.js";

describe("parseSelectedCount", () => {
  it("reads the count Figma puts on the canvas keyboard target", () => {
    expect(parseSelectedCount("Figma Design, 1 item selected")).toBe(1);
    expect(parseSelectedCount("Figma Design, 3 items selected")).toBe(3);
  });

  it("treats the bare label as no selection and anything else as unknown", () => {
    expect(parseSelectedCount("Figma Design")).toBe(0);
    expect(parseSelectedCount("Something else")).toBeNull();
    expect(parseSelectedCount(null)).toBeNull();
  });
});
