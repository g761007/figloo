import { describe, expect, it } from "vitest";
import { chooseZoom, place, placeSiblings, type Measured } from "../src/adapter/geometry.js";

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
