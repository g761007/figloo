import type { CanvasView, CaptureParams, CapturePlan, Rect } from "@figloo/protocol";
import { CAPTURE_MARGIN_PX, inflate, intersect } from "../capture.js";
import { DomRowSource } from "./dom-source.js";
import { VIEW_UPDATE_TIMEOUT_MS, type ExplorerCore } from "./explorer-core.js";
import { inspectionRoot, inspectionSignature, layerSize } from "./inspect.js";
import { BACKGROUND_MESSAGE, OpError, parseZoom, sleep, watchForUser, type UserSelection, type UserWatch } from "./operation.js";
import { learnParents } from "./tree.js";

/** A capture the worker never finished restores the user's selection and view on its own after this long. */
const PENDING_CAPTURE_TIMEOUT_MS = 10_000;
/** Wider margin when the crop is estimated from the layer's size instead of measured. */
const CAPTURE_FALLBACK_MARGIN_PX = 48;
const ZOOM_ANIMATION_MS = 500;
const TOAST_TIMEOUT_MS = 4_000;

export interface PendingCapture {
  token: string;
  before: UserSelection;
  /** The user's view before the capture moved it. */
  view: CanvasView | null;
  user: UserWatch;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Moves the view so the worker can capture it: zooms to the layer (or fits the page), then clears
 * the selection so no outline shows. The user's selection comes back in finishCapture.
 */
export async function prepareCapture(core: ExplorerCore, params: CaptureParams): Promise<CapturePlan> {
  const identity = core.checkExpected(params.expect);
  learnParents(core.index, params.known ?? []);
  if (core.doc.hidden) throw new OpError("TAB_IN_BACKGROUND", BACKGROUND_MESSAGE);
  if (core.pendingCapture) await finishCapture(core, core.pendingCapture.token);
  let before: UserSelection = { kind: "none" };
  const { value } = await core.run(async (tree, source) => {
    before = await core.userSelection(tree);
    const canvas = source.canvasRect();
    if (!canvas) throw new OpError("UI_NOT_READY", "the Figma canvas is not visible");
    let crop: Rect = canvas;
    let cropSource: "layer" | "canvas" = "canvas";
    const zoomBefore = source.zoomLabel();
    const view = await userView(source);
    if (params.ref !== null) {
      const row = await tree.find(params.ref);
      if (!row) throw new OpError("NODE_NOT_FOUND", `layer ${params.ref} is no longer in the layers panel`);
      const previous = inspectionSignature(core.doc);
      if (!(await source.select(row))) throw new OpError("UI_NOT_READY", `Figma did not select layer ${params.ref}; guest sessions cannot select layers`);
      // The panel's size tells how large the layer should look once zoomed, which checks the bounds below.
      const size = inspectionRoot(core.doc) ? await core.waitForPanel(row, previous, source).then(() => layerSize(core.doc)).catch(() => null) : null;
      // The mirror keeps the layer's old place until the zoom ends, about 0.5 s later, and then moves it in one
      // step (Arc on 2026-10-01). A zoom close to the old one, or a pan alone, keeps about the expected size,
      // so only a move shows that the place is new. When the layer is in place already, nothing moves.
      const shownBefore = source.mirrorRect(params.ref);
      source.pressKey("@", "Digit2", 50, true); // Shift+2: zoom to selection
      await source.settle(() => (shownBefore ? moved(source.mirrorRect(params.ref!), shownBefore) : source.zoomLabel() !== zoomBefore));
      const zoom = parseZoom(source.zoomLabel());
      const expected = size && zoom ? { width: size.width * zoom, height: size.height * zoom } : null;
      // Figma animates the zoom and updates the mirror as it goes, so wait for the bounds to settle.
      const bounds = await stableRect(() => source.mirrorRect(params.ref!), expected);
      const fitted = bounds ? intersect(inflate(bounds, CAPTURE_MARGIN_PX), canvas) : expected ? intersect(centered(canvas, expected, CAPTURE_FALLBACK_MARGIN_PX), canvas) : null;
      if (fitted) {
        crop = fitted;
        cropSource = "layer";
      }
    } else {
      source.pressKey("!", "Digit1", 49, true); // Shift+1: zoom to fit
      await source.settle(() => source.zoomLabel() !== zoomBefore);
      await sleep(ZOOM_ANIMATION_MS);
    }
    source.pressKey("Escape", "Escape", 27);
    await sleep(200);
    // Zooming shows a toast such as "Zoom to selection" for about three seconds; keep it out of the image.
    await source.settle(() => !(core.doc.querySelector('[data-testid="visual-bell-message"]')?.textContent?.trim()), TOAST_TIMEOUT_MS);
    return { crop, cropSource, canvas, zoom: source.zoomLabel(), view };
  });
  const token = crypto.randomUUID();
  const pending: PendingCapture = {
    token,
    before,
    view: value.view,
    user: watchForUser(core.win),
    timer: setTimeout(() => void finishCapture(core, token), PENDING_CAPTURE_TIMEOUT_MS),
  };
  core.pendingCapture = pending;
  return { identity, token, ...value, viewport: { width: core.win.innerWidth, height: core.win.innerHeight } };
}

/**
 * Puts the user's selection back, and their view unless `keepView`: a snapshot reads at the
 * capture's view and puts the view back once it is done.
 */
export async function finishCapture(core: ExplorerCore, token: string, keepView = false): Promise<{ userSelectionRestored: boolean; viewRestored: boolean; interrupted: boolean }> {
  const pending = core.pendingCapture;
  if (!pending || pending.token !== token) return { userSelectionRestored: false, viewRestored: false, interrupted: false };
  core.pendingCapture = null;
  clearTimeout(pending.timer);
  try {
    // If the user clicked or typed while the capture ran, their new selection and view win.
    if (pending.user.interrupted()) return { userSelectionRestored: false, viewRestored: false, interrupted: true };
    let restored = false;
    await core.run(
      async () => undefined,
      async (tree, source) => {
        restored = await core.restoreSelection(tree, source, pending.before);
      },
    );
    const viewRestored = keepView ? false : await core.putViewBack(pending.view, pending.user);
    return { userSelectionRestored: restored, viewRestored, interrupted: false };
  } finally {
    pending.user.dispose();
  }
}

/**
 * The user's view, once the mirror has caught up with it: the zoom label follows a zoom at once and
 * the mirror about 0.5 s later. Null without the mirror, or when it does not catch up in time.
 */
async function userView(source: DomRowSource): Promise<CanvasView | null> {
  if (!source.canvasView()) return null;
  const caughtUp = () => {
    const view = source.canvasView();
    const shown = parseZoom(source.zoomLabel());
    // The label rounds the zoom to the whole percent.
    return view !== null && (shown === null || Math.abs(view.zoom - shown) <= 0.005 + 1e-9);
  };
  return (await source.settle(caughtUp, VIEW_UPDATE_TIMEOUT_MS)) ? source.canvasView() : null;
}

/** Samples a rectangle until two reads agree and, when known, it has the expected size. */
async function stableRect(read: () => Rect | null, expected: { width: number; height: number } | null): Promise<Rect | null> {
  const deadline = Date.now() + 2_500;
  let last: Rect | null = null;
  let misses = 0;
  while (Date.now() < deadline) {
    await sleep(100);
    const rect = read();
    if (!rect) {
      // No screen reader mirror: the setting is off, so there are no bounds to wait for.
      if (++misses >= 3) return null;
      continue;
    }
    const steady = last !== null && Math.abs(rect.x - last.x) < 1 && Math.abs(rect.y - last.y) < 1 && Math.abs(rect.width - last.width) < 1;
    const sized = !expected || (Math.abs(rect.width - expected.width) / expected.width < 0.1 && Math.abs(rect.height - expected.height) / expected.height < 0.1);
    if (steady && sized) return rect;
    last = rect;
  }
  return null;
}

function moved(rect: Rect | null, from: Rect): boolean {
  return rect !== null && (Math.abs(rect.x - from.x) > 0.5 || Math.abs(rect.y - from.y) > 0.5 || Math.abs(rect.width - from.width) > 0.5);
}

/** Zoom to selection centers the layer, so its size alone places it roughly in the canvas. */
function centered(canvas: Rect, size: { width: number; height: number }, margin: number): Rect {
  return {
    x: canvas.x + (canvas.width - size.width) / 2 - margin,
    y: canvas.y + (canvas.height - size.height) / 2 - margin,
    width: size.width + 2 * margin,
    height: size.height + 2 * margin,
  };
}
