import { describe, expect, it } from "vitest";
import { placeInImage, planCrop } from "../src/capture.js";

describe("planCrop", () => {
  it("maps a layer's CSS pixel bounds onto a 2x capture", () => {
    const plan = planCrop({ x: 531, y: 28, width: 388, height: 813 }, { width: 1492, height: 929 }, { width: 2984, height: 1858 });
    expect(plan).toMatchObject({ sx: 1062, sy: 56, sw: 776, sh: 1626 });
    // 1626 device pixels tall is above the limit, so the output is scaled to 1568 on its long edge.
    expect(plan.height).toBe(1568);
    expect(plan.width).toBe(Math.round(776 * (1568 / 1626)));
  });

  it("keeps small crops at full resolution", () => {
    const plan = planCrop({ x: 10, y: 10, width: 100, height: 50 }, { width: 1000, height: 800 }, { width: 1000, height: 800 });
    expect(plan).toEqual({ sx: 10, sy: 10, sw: 100, sh: 50, width: 100, height: 50, shown: { x: 10, y: 10, width: 100, height: 50 } });
  });

  it("clips a crop that reaches past the viewport", () => {
    const plan = planCrop({ x: 900, y: -20, width: 300, height: 100 }, { width: 1000, height: 800 }, { width: 1000, height: 800 });
    expect(plan).toMatchObject({ sx: 900, sy: 0, sw: 100, sh: 80 });
    // The image shows only the part inside the viewport, which is what positions in it are measured from.
    expect(plan.shown).toEqual({ x: 900, y: 0, width: 100, height: 80 });
  });

  it("reports the viewport rectangle a 2x capture shows, in CSS pixels", () => {
    const plan = planCrop({ x: 531.3, y: 28, width: 388, height: 813 }, { width: 1492, height: 929 }, { width: 2984, height: 1858 });
    expect(plan.shown).toEqual({ x: 531.5, y: 28, width: 388, height: 813 });
  });
});

describe("placeInImage", () => {
  it("places a layer measured on screen in the scaled-down image of its crop", () => {
    // A 388 x 813 crop at (531, 28), scaled to 748 x 1568; the layer sits 12 px inside the crop.
    const placed = placeInImage({ x: 543, y: 40, width: 364, height: 789 }, { x: 531, y: 28, width: 388, height: 813 }, { width: 748, height: 1568 });
    expect(placed.x).toBeCloseTo(12 * (748 / 388), 6);
    expect(placed.y).toBeCloseTo(12 * (1568 / 813), 6);
    expect(placed.width).toBeCloseTo(364 * (748 / 388), 6);
    expect(placed.height).toBeCloseTo(789 * (1568 / 813), 6);
  });
});
