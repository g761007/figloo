import type { ImageAlignment, Rect } from "@figloo/protocol";

/** Longest edge Claude takes in without downscaling; larger captures only cost bytes. */
export const MAX_IMAGE_EDGE = 1568;
/** Room around a captured layer, in CSS pixels, so its edges and shadows stay in the image. */
export const CAPTURE_MARGIN_PX = 12;
/** How far, in CSS pixels, a root may sit from where the mirror put it and still be found in the screenshot. */
const MAX_MIRROR_DRIFT_PX = 100;

export function inflate(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + 2 * by, height: rect.height + 2 * by };
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

export interface CropPlan {
  /** Source rectangle in image pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Output size after scaling to fit MAX_IMAGE_EDGE. */
  width: number;
  height: number;
  /** The viewport rectangle the source rectangle covers, in CSS pixels. */
  shown: Rect;
}

/**
 * Maps a crop in viewport CSS pixels onto the captured image, which is in device pixels, and scales
 * the result down to fit maxEdge.
 */
export function planCrop(crop: Rect, viewport: { width: number; height: number }, image: { width: number; height: number }, maxEdge = MAX_IMAGE_EDGE): CropPlan {
  const scale = image.width / viewport.width;
  const x = Math.max(0, Math.min(crop.x, viewport.width));
  const y = Math.max(0, Math.min(crop.y, viewport.height));
  const right = Math.max(x, Math.min(crop.x + crop.width, viewport.width));
  const bottom = Math.max(y, Math.min(crop.y + crop.height, viewport.height));
  const sx = Math.round(x * scale);
  const sy = Math.round(y * scale);
  const sw = Math.max(1, Math.min(image.width - sx, Math.round((right - x) * scale)));
  const sh = Math.max(1, Math.min(image.height - sy, Math.round((bottom - y) * scale)));
  const k = Math.min(1, maxEdge / Math.max(sw, sh));
  const shown = { x: sx / scale, y: sy / scale, width: sw / scale, height: sh / scale };
  return { sx, sy, sw, sh, width: Math.max(1, Math.round(sw * k)), height: Math.max(1, Math.round(sh * k)), shown };
}

/** Whether a rectangle in image pixels lies inside the image, give or take rounding. */
export function insideImage(rect: Rect, image: { width: number; height: number }): boolean {
  const slack = 2;
  return rect.x >= -slack && rect.y >= -slack && rect.x + rect.width <= image.width + slack && rect.y + rect.height <= image.height + slack;
}

/** Where a rectangle on screen lands in an image of `crop` scaled to `image`, in image pixels. */
export function placeInImage(rect: Rect, crop: Rect, image: { width: number; height: number }): Rect {
  const sx = image.width / crop.width;
  const sy = image.height / crop.height;
  return { x: (rect.x - crop.x) * sx, y: (rect.y - crop.y) * sy, width: rect.width * sx, height: rect.height * sy };
}

/** Checks where the root shows in a captured PNG; `root` and the result are in viewport CSS pixels. */
export async function alignCapture(dataUrl: string, root: Rect, viewport: { width: number; height: number }): Promise<{ root: Rect; alignment: ImageAlignment }> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = bitmap.width / viewport.width;
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d")!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const expected = { x: root.x * scale, y: root.y * scale, width: root.width * scale, height: root.height * scale };
  const { rect, alignment } = alignRoot(pixels, expected, MAX_MIRROR_DRIFT_PX * scale);
  return { root: { x: rect.x / scale, y: rect.y / scale, width: root.width, height: root.height }, alignment };
}

/** Crops and scales a captured PNG in the service worker and returns it as base64 JPEG, with the viewport rectangle it shows. */
export async function cropCapture(dataUrl: string, crop: Rect, viewport: { width: number; height: number }): Promise<{ data: string; width: number; height: number; crop: Rect }> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const plan = planCrop(crop, viewport, { width: bitmap.width, height: bitmap.height });
  const canvas = new OffscreenCanvas(plan.width, plan.height);
  canvas.getContext("2d")!.drawImage(bitmap, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.width, plan.height);
  bitmap.close();
  const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 })).arrayBuffer());
  let binary = "";
  for (let i = 0; i < jpeg.length; i += 0x8000) binary += String.fromCharCode(...jpeg.subarray(i, i + 0x8000));
  return { data: btoa(binary), width: plan.width, height: plan.height, crop: plan.shown };
}

/** RGBA pixels, four bytes each, row by row, as ImageData holds them. */
export interface Pixels {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

type Color = [number, number, number];

/** Samples sit this many pixels outside and inside each edge, clear of the edge's antialiasing. */
const EDGE_GAP = 3;
const SAMPLES_PER_EDGE = 48;
/** Share of the samples outside the edges that must be canvas background, and of those inside that must not be. */
const OUTSIDE_MIN = 0.9;
const INSIDE_MIN = 0.6;

function colorAt(pixels: Pixels, x: number, y: number): Color | null {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= pixels.width || py >= pixels.height) return null;
  const i = (py * pixels.width + px) * 4;
  return [pixels.data[i]!, pixels.data[i + 1]!, pixels.data[i + 2]!];
}

/** Points along the four edges of `rect`, `gap` pixels outside it, or inside it for a negative gap. */
function edgePoints(rect: Rect, gap: number): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 0; i < SAMPLES_PER_EDGE; i += 1) {
    const t = (i + 0.5) / SAMPLES_PER_EDGE;
    const x = rect.x + t * (rect.width - 1);
    const y = rect.y + t * (rect.height - 1);
    points.push([x, rect.y - gap], [x, rect.y + rect.height - 1 + gap], [rect.x - gap, y], [rect.x + rect.width - 1 + gap, y]);
  }
  return points;
}

/**
 * Checks where the root shows in a screenshot. `expected` is where the mirror placed it, in the
 * screenshot's pixels. Just outside the root's edges is the canvas, one flat color, and just inside
 * them is not. When the canvas does not surround `expected`, the root is looked for up to `maxShift`
 * pixels away, as the mirror can keep a stale place (Arc on 2026-10-02, 33 CSS pixels too high).
 * Without a clear answer, for example around a root with a shadow, the mirror's place stays.
 * `tolerance` is the largest channel difference between pixels of the same color.
 */
export function alignRoot(pixels: Pixels, expected: Rect, maxShift: number, tolerance = 4): { rect: Rect; alignment: ImageAlignment } {
  const same = (a: Color, b: Color) => Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance && Math.abs(a[2] - b[2]) <= tolerance;
  // The canvas is the color most samples around the expected place share.
  const counts: { color: Color; n: number }[] = [];
  for (const [x, y] of edgePoints(expected, EDGE_GAP)) {
    const color = colorAt(pixels, x, y);
    if (!color) continue;
    const known = counts.find((entry) => same(entry.color, color));
    if (known) known.n += 1;
    else counts.push({ color, n: 1 });
  }
  const canvas = counts.sort((a, b) => b.n - a.n)[0]?.color;
  if (!canvas) return { rect: expected, alignment: "unconfirmed" };
  const share = (rect: Rect, gap: number, wantCanvas: boolean) => {
    let n = 0;
    let hits = 0;
    for (const [x, y] of edgePoints(rect, gap)) {
      const color = colorAt(pixels, x, y);
      if (!color) continue;
      n += 1;
      if (same(color, canvas) === wantCanvas) hits += 1;
    }
    return n === 0 ? 0 : hits / n;
  };
  const at = (dx: number, dy: number): Rect => ({ ...expected, x: expected.x + dx, y: expected.y + dy });
  if (share(expected, EDGE_GAP, true) >= OUTSIDE_MIN) return { rect: expected, alignment: "confirmed" };
  let best: { dx: number; dy: number; score: number } | null = null;
  const consider = (dx: number, dy: number) => {
    const rect = at(dx, dy);
    const outside = share(rect, EDGE_GAP, true);
    if (outside < OUTSIDE_MIN) return;
    const inside = share(rect, -EDGE_GAP, false);
    if (inside < INSIDE_MIN) return;
    // Places up to two pixels off pass too; samples closer to the edges single out the exact one.
    let score = outside + inside;
    for (const gap of [1, 2]) score += share(rect, gap, true) + share(rect, -gap, false);
    // Equal fits go to the smaller move.
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && Math.hypot(dx, dy) < Math.hypot(best.dx, best.dy))) best = { dx, dy, score };
  };
  const limit = Math.round(maxShift);
  for (let dy = -limit; dy <= limit; dy += 2) for (let dx = -limit; dx <= limit; dx += 2) consider(dx, dy);
  if (!best) return { rect: expected, alignment: "unconfirmed" };
  const coarse: { dx: number; dy: number } = best;
  for (let dy = coarse.dy - 1; dy <= coarse.dy + 1; dy += 1) for (let dx = coarse.dx - 1; dx <= coarse.dx + 1; dx += 1) consider(dx, dy);
  const found: { dx: number; dy: number } = best;
  return { rect: at(found.dx, found.dy), alignment: "corrected" };
}
