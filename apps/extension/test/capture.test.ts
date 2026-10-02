import { describe, expect, it } from "vitest";
import { alignRoot, insideImage, placeInImage, planCrop, type Pixels } from "../src/capture.js";

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

describe("insideImage", () => {
  it("accepts a root that fills the image up to rounding, and refuses one the crop missed", () => {
    expect(insideImage({ x: 23.1, y: 23.1, width: 701.7, height: 1521.7 }, { width: 748, height: 1568 })).toBe(true);
    expect(insideImage({ x: -0.6, y: 0, width: 108, height: 1568.4 }, { width: 107, height: 1568 })).toBe(true);
    // Arc on 2026-10-01: the crop followed the mirror's stale place and caught a neighbouring frame.
    expect(insideImage({ x: -766.6, y: -44.9, width: 660, height: 1431.9 }, { width: 107, height: 1568 })).toBe(false);
  });
});

describe("alignRoot", () => {
  const CANVAS: [number, number, number] = [229, 229, 229];
  // A 300 x 600 screen at (100, 150) of a 2x screenshot, its name above it, and a second screen 60 px to its right.
  const root = { x: 100, y: 150, width: 300, height: 600 };

  function screenshot({ shadow = false } = {}): Pixels {
    const width = 900;
    const height = 900;
    const data = new Uint8ClampedArray(width * height * 4);
    const paint = (x0: number, y0: number, w: number, h: number, color: (x: number, y: number) => [number, number, number]) => {
      for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y += 1) {
        for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x += 1) {
          const [r, g, b] = color(x, y);
          data.set([r, g, b, 255], (y * width + x) * 4);
        }
      }
    };
    paint(0, 0, width, height, () => CANVAS);
    if (shadow) {
      // Darker toward the screen's edges, as a drop shadow fades out.
      paint(root.x - 16, root.y - 16, root.width + 32, root.height + 32, (x, y) => {
        const distance = Math.max(root.x - x, x - (root.x + root.width - 1), root.y - y, y - (root.y + root.height - 1), 0);
        const shade = 229 - (16 - distance) * 4;
        return [shade, shade, shade];
      });
    }
    // Photo-like content that never matches the canvas.
    const content = (x: number, y: number): [number, number, number] => [40 + (y % 150), 80 + (x % 100), 150];
    paint(root.x, root.y, root.width, root.height, content);
    paint(root.x, root.y - 20, 110, 12, () => [120, 120, 120]);
    paint(root.x + root.width + 60, root.y, root.width, root.height, content);
    return { data, width, height };
  }

  it("confirms the mirror's place when the canvas surrounds it", () => {
    expect(alignRoot(screenshot(), root, 200)).toEqual({ rect: root, alignment: "confirmed" });
  });

  it("finds the root where the screenshot shows it when the mirror's place is stale", () => {
    // Arc on 2026-10-02: the mirror put the root 33 CSS pixels, 66 here, too high.
    expect(alignRoot(screenshot(), { ...root, y: root.y - 66 }, 200)).toEqual({ rect: root, alignment: "corrected" });
    expect(alignRoot(screenshot(), { ...root, x: root.x - 9, y: root.y + 5 }, 200)).toEqual({ rect: root, alignment: "corrected" });
  });

  it("does not take the neighbouring screen for the root", () => {
    expect(alignRoot(screenshot(), { ...root, x: root.x + 40 }, 200)).toEqual({ rect: root, alignment: "corrected" });
  });

  it("never moves a shadowed root anywhere but to where it is", () => {
    for (const expected of [root, { ...root, y: root.y - 66 }, { ...root, x: root.x + 40 }]) {
      const { rect, alignment } = alignRoot(screenshot({ shadow: true }), expected, 200);
      // Only the true place may be confirmed or corrected to, within one device pixel, half a CSS
      // pixel, as a fading shadow blurs the edge; otherwise the mirror's place stays.
      if (alignment === "unconfirmed") {
        expect(rect).toEqual(expected);
      } else {
        expect(Math.abs(rect.x - root.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(rect.y - root.y)).toBeLessThanOrEqual(1);
        if (alignment === "confirmed") expect(rect).toEqual(expected);
      }
    }
  });

  it("keeps the mirror's place when the screenshot shows no canvas around it", () => {
    const busy = screenshot();
    // Content everywhere, as when a root is zoomed far beyond the screen.
    for (let i = 0; i < busy.data.length; i += 4) (busy.data as Uint8ClampedArray).set([40 + ((i / 4) % 150), 90, 150], i);
    const stale = { ...root, y: root.y - 66 };
    expect(alignRoot(busy, stale, 200)).toEqual({ rect: stale, alignment: "unconfirmed" });
  });
});
