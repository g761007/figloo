import { describe, expect, it } from "vitest";
import type { InspectedSection, SnapshotLayer } from "@figloo/protocol";
import { changeMarks, diffSnapshots } from "../src/snapshot-diff.js";

function layer(ref: string, overrides: Partial<SnapshotLayer> = {}): SnapshotLayer {
  return {
    ref,
    name: "Layer",
    type: "Frame",
    depth: 1,
    parentRef: "1:1",
    position: 1,
    siblingCount: 1,
    hasChildren: false,
    hidden: false,
    bounds: { x: 0, y: 0, width: 100, height: 40, source: "mirror" },
    sections: [],
    exports: [],
    ...overrides,
  };
}
const section = (kind: string, group: InspectedSection["group"], value: string, title = "Title"): InspectedSection => ({ kind, group, title, properties: [{ group: null, name: "Value", value }], colors: [], text: kind === "content" ? value : null });
const root = layer("1:1", { depth: 0, parentRef: null });
const SINCE = "2026-10-01T09:00:00.000Z";

describe("diffSnapshots", () => {
  it("finds nothing when the design did not change, even with fractions of a pixel between reads", () => {
    const before = [root, layer("1:2", { bounds: { x: 20.3, y: 40, width: 100, height: 40, source: "mirror" } })];
    const after = [root, layer("1:2", { bounds: { x: 20.9, y: 40.4, width: 100.2, height: 40, source: "panel" } })];
    expect(diffSnapshots(before, after, SINCE)).toEqual({ since: SINCE, added: [], removed: [], changed: [] });
  });

  it("lists new and removed layers, and what changed about the others", () => {
    const before = [
      root,
      layer("1:2", { name: "Title", sections: [section("content", "typography", "Hello"), section("colors", "appearance", "#111111")] }),
      layer("1:3", { name: "Badge" }),
      layer("1:4", { name: "Card", bounds: { x: 0, y: 100, width: 300, height: 80, source: "mirror" } }),
    ];
    const after = [
      root,
      layer("1:2", { name: "Title", sections: [section("content", "typography", "Hello again"), section("colors", "appearance", "#111111")] }),
      layer("1:4", { name: "Card", bounds: { x: 0, y: 120, width: 300, height: 80, source: "mirror" }, hidden: true }),
      layer("1:5", { name: "New badge", parentRef: "1:4" }),
    ];
    expect(diffSnapshots(before, after, SINCE)).toEqual({
      since: SINCE,
      added: ["1:5"],
      removed: [{ ref: "1:3", name: "Badge", type: "Frame", parentRef: "1:1" }],
      changed: [
        { ref: "1:2", aspects: ["content"] },
        { ref: "1:4", aspects: ["hidden", "bounds"] },
      ],
    });
  });

  it("names the panel group that changed, and ignores section titles, which repeat a style run's text", () => {
    const before = [root, layer("1:2", { sections: [section("properties", "layout", "16px"), section("typography1", "typography", "500", "Span (Hello)")] })];
    const after = [root, layer("1:2", { sections: [section("properties", "layout", "24px"), section("typography1", "typography", "500", "Span (Hi)")] })];
    expect(diffSnapshots(before, after, SINCE).changed).toEqual([{ ref: "1:2", aspects: ["layout"] }]);
  });

  it("counts a layer moved to another parent, a renamed one, and changed export settings, but not unconfirmed ones", () => {
    const before = [root, layer("1:2"), layer("1:3", { exports: ["PNG 2x"] }), layer("1:4", { exports: ["SVG 1x"] })];
    const after = [root, layer("1:2", { parentRef: "1:4", name: "Renamed" }), layer("1:3", { exports: ["PNG 3x"] }), layer("1:4", { exports: null })];
    expect(diffSnapshots(before, after, SINCE).changed).toEqual([
      { ref: "1:2", aspects: ["name", "moved"] },
      { ref: "1:3", aspects: ["exports"] },
    ]);
  });

  it("marks new and changed layers for the outline", () => {
    const marks = changeMarks({ since: SINCE, added: ["1:5"], removed: [], changed: [{ ref: "1:2", aspects: ["layout", "content"] }] });
    expect(Object.fromEntries(marks)).toEqual({ "1:5": "[new]", "1:2": "[changed: layout, content]" });
    expect(changeMarks(undefined).size).toBe(0);
  });
});
