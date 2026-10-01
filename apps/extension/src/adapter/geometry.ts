import type { Rect } from "@figloo/protocol";

export type Side = "right" | "left" | "below" | "above" | "overlaps";

/** Where a layer sits relative to the reference layer, in design pixels. */
export interface Placement {
  side: Side;
  /** Whether it shares a row (left or right) or a column (above or below) with the reference. */
  inLine: boolean;
  /** Edge-to-edge distance; corner to corner for layers off to a diagonal; 0 when touching or overlapping. */
  gap: number;
  /** Its top-left corner relative to the reference's. */
  offset: { x: number; y: number };
  size: { width: number; height: number };
}

/**
 * The zoom to convert screen pixels with. `measured` is the reference layer's width on screen over
 * its width in the inspection panel, which is exact unless rotation widened the box on screen.
 * Figma's zoom label is rounded to a whole percent, so it can be off by half a point, which is a
 * tenth at 5%; it only checks the measurement, and stands in when there is none.
 */
export function chooseZoom(measured: number | null, label: number | null): number | null {
  if (measured === null || !Number.isFinite(measured) || measured <= 0) return label;
  if (label === null) return measured;
  return Math.abs(measured - label) <= 0.006 + 0.03 * label ? measured : label;
}

/**
 * A layer's size, and its position in its nearest frame, from Figma's inspection panel, in design
 * pixels. The panel leaves out a zero Top or Left, and both for children of an auto layout, so the
 * position is null when it shows neither.
 */
export interface LayerBox {
  width: number;
  height: number;
  position: { left: number; top: number } | null;
}

/** What was measured for one layer: where the mirror shows it on screen, and what the panel says. */
export interface Measured {
  id: string;
  /** Text layers are not in the screen reader mirror, so they have none. */
  rect: Rect | null;
  /** Only for layers that were selected. */
  box: LayerBox | null;
}

export interface Placed {
  id: string;
  placement: Placement;
}

export interface SiblingPlacement {
  /** The reference layer in design pixels, null when nothing places it. */
  reference: Rect | null;
  placed: Placed[];
  unplaced: string[];
  /** The zoom used to turn screen pixels into design pixels; null when none were converted. */
  zoom: number | null;
}

const boxRect = (box: LayerBox): Rect => ({ x: box.position!.left, y: box.position!.top, width: box.width, height: box.height });

/**
 * Places siblings relative to a reference layer in design pixels. Panel positions are exact and share
 * the siblings' nearest frame. Screen positions join them through a layer that has both, which ties
 * screen pixels to that frame; without one, they are placed relative to the reference on screen.
 */
export function placeSiblings(reference: Measured, siblings: Measured[], zoomLabel: number | null): SiblingPlacement {
  const bridge = [reference, ...siblings].find((layer) => layer.rect && layer.box?.position) ?? null;
  let zoom: number | null = null;
  let designOf: (layer: Measured) => Rect | null;
  if (bridge) {
    zoom = chooseZoom(bridge.rect!.width / bridge.box!.width, zoomLabel);
    const scale = zoom;
    const origin = bridge.box!.position!;
    designOf = (layer) =>
      layer.box?.position
        ? boxRect(layer.box)
        : layer.rect && scale
          ? {
              x: origin.left + (layer.rect.x - bridge.rect!.x) / scale,
              y: origin.top + (layer.rect.y - bridge.rect!.y) / scale,
              width: layer.rect.width / scale,
              height: layer.rect.height / scale,
            }
          : null;
  } else if (reference.rect) {
    zoom = chooseZoom(reference.box ? reference.rect.width / reference.box.width : null, zoomLabel);
    const scale = zoom;
    const origin = reference.rect;
    designOf = (layer) =>
      layer.rect && scale
        ? { x: (layer.rect.x - origin.x) / scale, y: (layer.rect.y - origin.y) / scale, width: layer.rect.width / scale, height: layer.rect.height / scale }
        : null;
  } else {
    designOf = (layer) => (layer.box?.position ? boxRect(layer.box) : null);
  }
  const referenceRect = designOf(reference);
  const placed: Placed[] = [];
  const unplaced: string[] = [];
  for (const sibling of siblings) {
    const rect = referenceRect ? designOf(sibling) : null;
    if (rect && referenceRect) placed.push({ id: sibling.id, placement: place(referenceRect, rect, 1) });
    else unplaced.push(sibling.id);
  }
  return { reference: referenceRect, placed, unplaced, zoom };
}

/** Screen pixels closer than this count as touching. */
const TOUCHING_PX = 0.5;

const round = (value: number) => Math.round(value * 10) / 10;

/** Places `other` relative to `reference`, both on screen; `scale` is screen pixels per design pixel, the zoom. */
export function place(reference: Rect, other: Rect, scale: number): Placement {
  const right = other.x - (reference.x + reference.width);
  const left = reference.x - (other.x + other.width);
  const below = other.y - (reference.y + reference.height);
  const above = reference.y - (other.y + other.height);
  // Positive when apart along that axis, negative when the two overlap on it, and 0 when they touch,
  // which absorbs the sub-pixel overlap of layers placed edge to edge.
  const snap = (value: number) => (Math.abs(value) < TOUCHING_PX ? 0 : value);
  const apartX = snap(Math.max(right, left));
  const apartY = snap(Math.max(below, above));
  const sideX: Side = right >= left ? "right" : "left";
  const sideY: Side = below >= above ? "below" : "above";
  let side: Side;
  let inLine = true;
  let gap: number;
  if (apartX < 0 && apartY < 0) {
    side = "overlaps";
    gap = 0;
  } else if (apartY <= 0) {
    side = sideX;
    gap = apartX;
  } else if (apartX <= 0) {
    side = sideY;
    gap = apartY;
  } else {
    side = apartX >= apartY ? sideX : sideY;
    inLine = false;
    gap = Math.hypot(apartX, apartY);
  }
  return {
    side,
    inLine,
    gap: round(gap / scale),
    offset: { x: round((other.x - reference.x) / scale), y: round((other.y - reference.y) / scale) },
    size: { width: round(other.width / scale), height: round(other.height / scale) },
  };
}
