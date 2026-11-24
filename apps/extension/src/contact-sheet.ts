import type { Rect } from "@figloo/protocol";
import { MAX_IMAGE_EDGE, jpegBase64, planCrop } from "./capture.js";

/** A sheet as wide as Claude takes in without downscaling: 12 frames in 2 rows of 6. */
export const SHEET_COLUMNS = 6;
export const SHEET_ROWS = 2;
const SHEET_WIDTH = MAX_IMAGE_EDGE;
const GAP = 8;
const LABEL_HEIGHT = 28;
const CELL_WIDTH = Math.floor((SHEET_WIDTH - GAP * (SHEET_COLUMNS + 1)) / SHEET_COLUMNS);
const CELL_HEIGHT = Math.floor((MAX_IMAGE_EDGE - GAP * (SHEET_ROWS + 1)) / SHEET_ROWS);

/** Where the frame at `index` of a sheet goes: its label and the box its picture fits in, in sheet pixels. */
export function cellOf(index: number): { label: { x: number; y: number }; box: Rect } {
  const column = index % SHEET_COLUMNS;
  const row = Math.floor(index / SHEET_COLUMNS);
  const x = GAP + column * (CELL_WIDTH + GAP);
  const y = GAP + row * (CELL_HEIGHT + GAP);
  return { label: { x, y }, box: { x, y: y + LABEL_HEIGHT, width: CELL_WIDTH, height: CELL_HEIGHT - LABEL_HEIGHT } };
}

/** The size a picture of `size` takes in `box`: as large as fits, never larger than the picture itself. */
export function fitIn(size: { width: number; height: number }, box: { width: number; height: number }): { width: number; height: number } {
  const k = Math.min(1, box.width / size.width, box.height / size.height);
  return { width: Math.max(1, Math.round(size.width * k)), height: Math.max(1, Math.round(size.height * k)) };
}

/** A sheet's height for `count` frames: only the rows it uses. */
export function sheetHeight(count: number): number {
  const rows = Math.min(SHEET_ROWS, Math.max(1, Math.ceil(count / SHEET_COLUMNS)));
  return GAP + rows * (CELL_HEIGHT + GAP);
}

/**
 * Contact sheets of frame screenshots, drawn in the service worker: each frame's picture under its
 * number, SHEET_COLUMNS × SHEET_ROWS to a sheet. A full sheet is encoded at once, so only one is
 * held as pixels.
 */
export class ContactSheets {
  readonly sheets: { image: { data: string; mimeType: "image/jpeg"; width: number; height: number }; frames: number[] }[] = [];
  private canvas: OffscreenCanvas | null = null;
  private frames: number[] = [];

  /** Adds the part of a captured PNG that `crop`, in viewport CSS pixels, shows, labeled `#n`. */
  async add(n: number, dataUrl: string, crop: Rect, viewport: { width: number; height: number }): Promise<void> {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const source = planCrop(crop, viewport, { width: bitmap.width, height: bitmap.height }, Number.POSITIVE_INFINITY);
    this.canvas ??= this.blank();
    const context = this.canvas.getContext("2d")!;
    const { label, box } = cellOf(this.frames.length);
    const size = fitIn({ width: source.sw, height: source.sh }, box);
    const x = box.x + Math.round((box.width - size.width) / 2);
    context.drawImage(bitmap, source.sx, source.sy, source.sw, source.sh, x, box.y, size.width, size.height);
    bitmap.close();
    context.strokeStyle = "#9ca3af";
    context.lineWidth = 1;
    context.strokeRect(x - 0.5, box.y - 0.5, size.width + 1, size.height + 1);
    context.fillStyle = "#111827";
    context.font = "bold 20px system-ui, -apple-system, sans-serif";
    context.textBaseline = "top";
    context.fillText(`#${n}`, label.x, label.y + 2);
    this.frames.push(n);
    if (this.frames.length === SHEET_COLUMNS * SHEET_ROWS) await this.flush();
  }

  /** Encodes the sheet still being filled, if any, and returns every sheet. */
  async finish(): Promise<ContactSheets["sheets"]> {
    if (this.frames.length > 0) await this.flush();
    return this.sheets;
  }

  private blank(): OffscreenCanvas {
    const canvas = new OffscreenCanvas(SHEET_WIDTH, sheetHeight(SHEET_COLUMNS * SHEET_ROWS));
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#f3f4f6";
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas;
  }

  private async flush(): Promise<void> {
    const full = this.canvas!;
    const height = sheetHeight(this.frames.length);
    const used = new OffscreenCanvas(SHEET_WIDTH, height);
    used.getContext("2d")!.drawImage(full, 0, 0, SHEET_WIDTH, height, 0, 0, SHEET_WIDTH, height);
    this.sheets.push({ image: { data: await jpegBase64(used), mimeType: "image/jpeg", width: SHEET_WIDTH, height }, frames: this.frames });
    this.canvas = null;
    this.frames = [];
  }
}
