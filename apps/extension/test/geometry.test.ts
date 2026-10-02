import { describe, expect, it } from "vitest";
import { boundsInRoot, chooseZoom, place, placeSiblings, type Measured, type SnapshotMeasure } from "../src/adapter/geometry.js";

// A 100 x 40 button at (200, 300) on screen, with the canvas zoomed to 50%.
const button = { x: 200, y: 300, width: 100, height: 40 };
const zoom = 0.5;

describe("chooseZoom", () => {
  it("trusts the measured zoom over Figma's label, which is rounded to a whole percent", () => {
    // A 167 px wide layer drawn 8.83 px wide while the label reads 5%.
    expect(chooseZoom(8.83 / 167, 0.05)).toBeCloseTo(0.0529, 4);
    expect(chooseZoom(101.6 / 167, 0.61)).toBeCloseTo(0.6084, 4);
  });

  it("falls back to the label when rotation widened the box on screen, or nothing was measured", () => {
    expect(chooseZoom(0.72, 0.61)).toBe(0.61);
    expect(chooseZoom(null, 0.61)).toBe(0.61);
    expect(chooseZoom(Number.NaN, 0.61)).toBe(0.61);
    expect(chooseZoom(0.5, null)).toBe(0.5);
  });
});

describe("place", () => {
  it("finds a layer in the same row to the right, with the gap in design pixels", () => {
    expect(place(button, { x: 310, y: 305, width: 50, height: 30 }, zoom)).toEqual({
      side: "right",
      inLine: true,
      gap: 20,
      offset: { x: 220, y: 10 },
      size: { width: 100, height: 60 },
    });
  });

  it("finds a layer in the same column below and one above", () => {
    expect(place(button, { x: 220, y: 350, width: 40, height: 20 }, zoom)).toMatchObject({ side: "below", inLine: true, gap: 20 });
    expect(place(button, { x: 180, y: 250, width: 200, height: 40 }, zoom)).toMatchObject({ side: "above", inLine: true, gap: 20 });
  });

  it("calls a layer off to a corner by its larger distance, measured corner to corner", () => {
    const placed = place(button, { x: 330, y: 380, width: 20, height: 20 }, zoom);
    expect(placed).toMatchObject({ side: "below", inLine: false });
    expect(placed.gap).toBeCloseTo(Math.hypot(30, 40) / zoom, 1);
  });

  it("treats edges that meet as touching, and layers on top of each other as overlapping", () => {
    expect(place(button, { x: 300, y: 300, width: 30, height: 40 }, zoom)).toMatchObject({ side: "right", inLine: true, gap: 0 });
    expect(place(button, { x: 210, y: 310, width: 20, height: 10 }, zoom)).toMatchObject({ side: "overlaps", gap: 0 });
    // Auto layout siblings placed edge to edge can overlap by a fraction of a pixel on screen.
    expect(place(button, { x: 299.8, y: 300, width: 30, height: 40 }, zoom)).toMatchObject({ side: "right", inLine: true, gap: 0 });
  });

  it("keeps a decimal so sizes at odd zoom levels stay readable", () => {
    expect(place(button, { x: 434, y: 300, width: 84, height: 15 }, 0.61).size).toEqual({ width: 137.7, height: 24.6 });
  });
});

/**
 * Group 881 from the test file, in its frame's design pixels: an auto layout child at (25, 1) holding
 * the follow button, a spacer, and two text layers. Drawn here at 50% zoom with the frame at (400, 150).
 */
const zoomed = (x: number, y: number, width: number, height: number) => ({ x: 400 + x * 0.5, y: 150 + y * 0.5, width: width * 0.5, height: height * 0.5 });
const panel = (width: number, height: number, left?: number, top?: number) => ({ width, height, position: left === undefined ? null : { left, top: top! } });
const follow: Measured = { id: "follow", rect: zoomed(91, 3, 53, 34), box: panel(53, 34, 91, 3) };
const spacer: Measured = { id: "spacer", rect: zoomed(88, 3, 16, 34), box: null };
const name: Measured = { id: "name", rect: null, box: panel(27, 20, 25, 1) };
const stars: Measured = { id: "stars", rect: null, box: panel(63, 20, 25, 19) };
const byId = (result: ReturnType<typeof placeSiblings>) => Object.fromEntries(result.placed.map((p) => [p.id, p.placement]));

describe("placeSiblings", () => {
  it("places shapes from the screen and text layers from the panel in one frame", () => {
    const result = placeSiblings(follow, [spacer, name, stars], 0.5);
    const placed = byId(result);
    expect(result.zoom).toBe(0.5);
    expect(placed.name).toMatchObject({ side: "left", inLine: true, gap: 39, offset: { x: -66, y: -2 } });
    expect(placed.stars).toMatchObject({ side: "left", inLine: true, gap: 3, offset: { x: -66, y: 16 } });
    expect(placed.spacer).toMatchObject({ side: "overlaps", offset: { x: -3, y: 0 }, size: { width: 16, height: 34 } });
  });

  it("places shapes around a text reference through a layer the screen and the panel both place", () => {
    const result = placeSiblings(name, [follow, spacer, stars], 0.5);
    const placed = byId(result);
    expect(placed.follow).toMatchObject({ side: "right", gap: 39, offset: { x: 66, y: 2 } });
    expect(placed.spacer).toMatchObject({ side: "right", gap: 36, offset: { x: 63, y: 2 } });
    expect(placed.stars).toMatchObject({ side: "overlaps", offset: { x: 0, y: 18 } });
  });

  it("leaves a text layer that auto layout places unplaced, and gives up on a reference nothing places", () => {
    const label: Measured = { id: "label", rect: null, box: panel(40, 16) };
    expect(placeSiblings(follow, [label], 0.5).unplaced).toEqual(["label"]);
    expect(placeSiblings(label, [follow], 0.5).reference).toBeNull();
  });

  it("places by the screen alone when no layer has a panel position, and leaves text it cannot relate", () => {
    const first: Measured = { id: "first", rect: zoomed(0, 0, 100, 40), box: panel(100, 40) };
    const second: Measured = { id: "second", rect: zoomed(112, 0, 60, 40), box: null };
    const result = placeSiblings(first, [second, name], 0.51);
    expect(result.zoom).toBe(0.5);
    expect(byId(result).second).toMatchObject({ side: "right", gap: 12, offset: { x: 112, y: 0 } });
    expect(result.unplaced).toEqual(["name"]);
  });
});

describe("boundsInRoot", () => {
  // A 393 x 852 screen at (500, 100) on screen, zoomed to 50%.
  const screen: SnapshotMeasure = { id: "screen", parentId: null, type: "Frame", rect: { x: 500, y: 100, width: 196.5, height: 426 }, box: { width: 393, height: 852, position: null } };
  const card: SnapshotMeasure = { id: "card", parentId: "screen", type: "Frame", rect: { x: 510, y: 200, width: 176.5, height: 100 }, box: null };
  const text = (id: string, parentId: string, position: { left: number; top: number } | null): SnapshotMeasure => ({
    id,
    parentId,
    type: "Text",
    rect: null,
    box: { width: 120, height: 24, position },
  });

  it("measures layers the mirror shows on screen, in design pixels from the root's corner", () => {
    const bounds = boundsInRoot([screen, card], 0.5);
    expect(bounds.get("screen")).toEqual({ x: 0, y: 0, width: 393, height: 852, source: "mirror" });
    expect(bounds.get("card")).toEqual({ x: 20, y: 200, width: 353, height: 200, source: "mirror" });
  });

  it("rounds away the error of a fractional zoom", () => {
    const zoomed = { ...screen, rect: { x: 500, y: 100, width: 365.49, height: 792.36 } };
    const child = { ...card, rect: { x: 500 + 18.6, y: 100 + 186, width: 111.6, height: 22.32 } };
    expect(boundsInRoot([zoomed, child], 0.93).get("card")).toEqual({ x: 20, y: 200, width: 120, height: 24, source: "mirror" });
  });

  it("places text from the panel's Top and Left inside its frame, which a group does not count as", () => {
    const group: SnapshotMeasure = { id: "group", parentId: "card", type: "Group", rect: { x: 515, y: 250, width: 50, height: 20 }, box: null };
    const bounds = boundsInRoot([screen, card, text("title", "card", { left: 16, top: 12 }), group, text("label", "group", { left: 40, top: 110 })], 0.5);
    expect(bounds.get("title")).toEqual({ x: 36, y: 212, width: 120, height: 24, source: "panel" });
    expect(bounds.get("group")).toMatchObject({ x: 30, y: 300, source: "mirror" });
    // 40 and 110 are measured from the card, not from the group at (30, 300).
    expect(bounds.get("label")).toEqual({ x: 60, y: 310, width: 120, height: 24, source: "panel" });
  });

  it("places text inside frames an earlier call of the snapshot placed, through groups it placed too", () => {
    // The card and its group were read by an earlier call; this call read the root again and two text layers.
    const placed = [
      { ref: "card", parentRef: "screen", type: "Frame", bounds: { x: 20, y: 200, width: 353, height: 200, source: "mirror" as const } },
      { ref: "group", parentRef: "card", type: "Group", bounds: { x: 30, y: 300, width: 100, height: 40, source: "mirror" as const } },
    ];
    const bounds = boundsInRoot([screen, text("title", "card", { left: 16, top: 12 }), text("label", "group", { left: 40, top: 110 })], 0.5, placed);
    expect(bounds.get("title")).toEqual({ x: 36, y: 212, width: 120, height: 24, source: "panel" });
    expect(bounds.get("label")).toEqual({ x: 60, y: 310, width: 120, height: 24, source: "panel" });
  });

  it("measures the root again in every call instead of taking an earlier call's place for it", () => {
    const placed = [{ ref: "screen", parentRef: null, type: "Frame", bounds: { x: 5, y: 5, width: 1, height: 1, source: "panel" as const } }];
    expect(boundsInRoot([screen, card], 0.5, placed).get("screen")).toEqual({ x: 0, y: 0, width: 393, height: 852, source: "mirror" });
  });

  it("measures a line, which has no height on screen", () => {
    const line: SnapshotMeasure = { id: "line", parentId: "screen", type: "Line", rect: { x: 592.5, y: 203, width: 65, height: 0 }, box: { width: 130, height: 0, position: { left: 185, top: 206 } } };
    expect(boundsInRoot([screen, line], 0.5).get("line")).toEqual({ x: 185, y: 206, width: 130, height: 0, source: "mirror" });
  });

  it("keeps only the size of text placed by auto layout, and of layers in a frame with no known place", () => {
    const row: SnapshotMeasure = { id: "row", parentId: "screen", type: "Auto layout", rect: null, box: { width: 200, height: 40, position: null } };
    const bounds = boundsInRoot([screen, row, text("auto", "screen", null), text("lost", "row", { left: 4, top: 8 })], 0.5);
    expect(bounds.get("auto")).toEqual({ x: null, y: null, width: 120, height: 24, source: "unknown" });
    expect(bounds.get("row")).toEqual({ x: null, y: null, width: 200, height: 40, source: "unknown" });
    expect(bounds.get("lost")).toMatchObject({ x: null, y: null, source: "unknown" });
  });

  it("works from the panel alone without the mirror, and measures a group root's children from the group's own place", () => {
    const plain = boundsInRoot([{ ...screen, rect: null }, text("title", "screen", { left: 24, top: 64 })], null);
    expect(plain.get("screen")).toEqual({ x: 0, y: 0, width: 393, height: 852, source: "panel" });
    expect(plain.get("title")).toMatchObject({ x: 24, y: 64, source: "panel" });

    const groupRoot: SnapshotMeasure = { id: "g", parentId: null, type: "Group", rect: null, box: { width: 200, height: 100, position: { left: 100, top: 50 } } };
    expect(boundsInRoot([groupRoot, text("t", "g", { left: 110, top: 70 })], null).get("t")).toMatchObject({ x: 10, y: 20, source: "panel" });
  });
});
