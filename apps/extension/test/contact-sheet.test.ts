import { describe, expect, it } from "vitest";
import { MAX_IMAGE_EDGE } from "../src/capture.js";
import { SHEET_COLUMNS, SHEET_ROWS, cellOf, fitIn, sheetHeight } from "../src/contact-sheet.js";

describe("contact sheet layout", () => {
  it("puts 12 frames in two rows of six, inside the largest image Claude takes in whole", () => {
    expect(SHEET_COLUMNS * SHEET_ROWS).toBe(12);
    const last = cellOf(SHEET_COLUMNS * SHEET_ROWS - 1);
    expect(last.box.x + last.box.width).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
    expect(last.box.y + last.box.height).toBeLessThanOrEqual(sheetHeight(12));
    expect(sheetHeight(12)).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
  });

  it("fills a row left to right, then starts the next under it, each picture below its label", () => {
    const first = cellOf(0);
    const second = cellOf(1);
    const seventh = cellOf(SHEET_COLUMNS);
    expect(second.box.x).toBeGreaterThan(first.box.x + first.box.width);
    expect(second.box.y).toBe(first.box.y);
    expect(seventh.box.x).toBe(first.box.x);
    expect(seventh.label.y).toBeGreaterThan(first.box.y + first.box.height);
    expect(first.box.y).toBeGreaterThan(first.label.y);
  });

  it("uses only the rows it needs", () => {
    expect(sheetHeight(1)).toBe(sheetHeight(SHEET_COLUMNS));
    expect(sheetHeight(SHEET_COLUMNS + 1)).toBeGreaterThan(sheetHeight(SHEET_COLUMNS));
  });

  it("shrinks a phone screen and a long page to fit, keeps their shape, and never enlarges a small icon", () => {
    const box = cellOf(0).box;
    const phone = fitIn({ width: 786, height: 1704 }, box);
    expect(phone.width).toBeLessThanOrEqual(box.width);
    expect(phone.height).toBeLessThanOrEqual(box.height);
    expect(phone.width / phone.height).toBeCloseTo(786 / 1704, 2);
    const long = fitIn({ width: 393, height: 2310 }, box);
    expect(long.height).toBe(box.height);
    expect(fitIn({ width: 48, height: 48 }, box)).toEqual({ width: 48, height: 48 });
  });
});
