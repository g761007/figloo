import type { CanvasView } from "@figloo/protocol";

/**
 * Puts the user's view of the canvas back after a capture moved it, with wheel input as a trackpad
 * sends it. Measured in Arc on 2026-10-03: wheel input with ctrlKey zooms by 2^(-deltaY / 50) about
 * the pointer; other wheel input scrolls 2 CSS pixels per unit, at most 120 px per input along its
 * direction; Figma's screen reader mirror shows the new view about 0.5 s after it stops changing,
 * with the origin to the whole pixel. Each round sends input, waits for the mirror, and corrects
 * what is left, learning how far one unit goes, which other browsers may do differently.
 */

/** What putting the view back needs from the page. */
export interface ViewControls {
  /** The view the mirror shows now; null without the mirror. */
  read(): CanvasView | null;
  /** Where zoom input points: the one place on screen a zoom does not move. */
  readonly center: { x: number; y: number };
  /** One wheel input: with `zoom`, deltaY zooms; otherwise deltaX and deltaY scroll. */
  wheel(deltaX: number, deltaY: number, zoom: boolean): void;
  /** The view once the mirror shows one other than `before`; the view as it is when that takes too long. */
  next(before: CanvasView): Promise<CanvasView | null>;
  /** True once the user uses Figma, or the tab is in the background, where Figma ignores the input. */
  stopped(): boolean;
}

const ZOOM_UNITS_PER_DOUBLING = 50;
const SCROLL_PX_PER_UNIT = 2;
const MAX_ZOOM_STEP_UNITS = 40;
/** Well below the 120 px one input moves at most, so each input moves as far as it asks, even where a unit goes further. */
const MAX_SCROLL_STEP_PX = 50;
/** The mirror places the origin to the whole pixel, so the view is back once it shows the same pixel. */
const POSITION_TOLERANCE_PX = 0.5;
/** The mirror gives the zoom to six digits or so. */
const ZOOM_TOLERANCE = 1e-4;
const MAX_ROUNDS = 5;
/** Smaller moves say little next to the mirror's rounding about how far one unit goes. */
const MIN_LEARNING_SCROLL_PX = 20;
const MIN_LEARNING_DOUBLINGS = 0.05;

export function sameView(a: CanvasView, b: CanvasView): boolean {
  return Math.abs(a.x - b.x) <= POSITION_TOLERANCE_PX && Math.abs(a.y - b.y) <= POSITION_TOLERANCE_PX && Math.abs(a.zoom / b.zoom - 1) <= ZOOM_TOLERANCE;
}

/** Moves the view to `target`; true once the mirror shows it there. */
export async function restoreView(target: CanvasView, controls: ViewControls): Promise<boolean> {
  let pxPerUnit = SCROLL_PX_PER_UNIT;
  let unitsPerDoubling = ZOOM_UNITS_PER_DOUBLING;
  let now = controls.read();
  for (let round = 0; now !== null && round < MAX_ROUNDS; round += 1) {
    if (sameView(now, target)) return true;
    if (controls.stopped()) return false;
    const { x: cx, y: cy } = controls.center;
    const doublings = Math.abs(target.zoom / now.zoom - 1) > ZOOM_TOLERANCE ? Math.log2(target.zoom / now.zoom) : 0;
    const ratio = 2 ** doublings;
    // The same place is fewer pixels away at the smaller zoom, so the scroll goes before zooming in and after zooming out.
    const scrollFirst = ratio > 1;
    const goal = scrollFirst ? { x: cx + (target.x - cx) / ratio, y: cy + (target.y - cy) / ratio } : target;
    const from = scrollFirst ? now : { x: cx + (now.x - cx) * ratio, y: cy + (now.y - cy) * ratio };
    const scroll = { x: goal.x - from.x, y: goal.y - from.y };
    if (scrollFirst) scrollBy(controls, scroll, pxPerUnit);
    if (doublings !== 0) zoomBy(controls, doublings, unitsPerDoubling);
    if (!scrollFirst) scrollBy(controls, scroll, pxPerUnit);
    const after = await controls.next(now);
    if (after === null) return false;
    const achieved = after.zoom / now.zoom;
    if (doublings !== 0) {
      // Figma ignored the zoom, or zoomed the other way.
      if (Math.log2(achieved) * doublings <= 0) return false;
      if (Math.abs(doublings) >= MIN_LEARNING_DOUBLINGS) unitsPerDoubling *= doublings / Math.log2(achieved);
    }
    // Where the zoom took the origin is known, so what is left is how far the scroll went.
    const scrolled = scrollFirst
      ? { x: (after.x - cx) / achieved + cx - now.x, y: (after.y - cy) / achieved + cy - now.y }
      : { x: after.x - cx - (now.x - cx) * achieved, y: after.y - cy - (now.y - cy) * achieved };
    const distance = Math.hypot(scroll.x, scroll.y);
    if (distance >= MIN_LEARNING_SCROLL_PX) {
      const moved = (scrolled.x * scroll.x + scrolled.y * scroll.y) / distance;
      // Figma ignored the scroll, or scrolled the other way.
      if (moved <= 0) return false;
      pxPerUnit *= moved / distance;
    }
    now = after;
  }
  return now !== null && sameView(now, target);
}

/** Scrolls the origin by `px`, in inputs short enough that each moves as far as it asks. */
function scrollBy(controls: ViewControls, px: { x: number; y: number }, pxPerUnit: number): void {
  const steps = Math.ceil(Math.hypot(px.x, px.y) / MAX_SCROLL_STEP_PX);
  // Scrolling down moves the page up, so the delta points against the move.
  for (let i = 0; i < steps; i += 1) controls.wheel(-px.x / steps / pxPerUnit, -px.y / steps / pxPerUnit, false);
}

function zoomBy(controls: ViewControls, doublings: number, unitsPerDoubling: number): void {
  // A negative delta zooms in.
  const units = -doublings * unitsPerDoubling;
  const steps = Math.ceil(Math.abs(units) / MAX_ZOOM_STEP_UNITS);
  for (let i = 0; i < steps; i += 1) controls.wheel(0, units / steps, true);
}
