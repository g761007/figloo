import { describe, expect, it } from "vitest";
import type { CanvasView } from "@figloo/protocol";
import { restoreView, sameView, type ViewControls } from "../src/adapter/view.js";

const CENTER = { x: 610.5, y: 464.5 };

/**
 * Figma's canvas as measured in Arc on 2026-10-03: ctrl+wheel zooms about the pointer, other wheel
 * input scrolls up to 120 px per input, and the mirror shows the origin rounded to the whole pixel
 * once the view settles. Other browsers may scroll or zoom at other rates per unit.
 */
class FakeCanvas implements ViewControls {
  readonly center = CENTER;
  inputs = 0;
  rounds = 0;
  /** Figma ignores input, as in a background tab. */
  ignoring = false;
  userSteppedIn = false;
  private shown: CanvasView;

  constructor(
    public view: CanvasView,
    private readonly rates: { pxPerUnit: number; unitsPerDoubling: number } = { pxPerUnit: 2, unitsPerDoubling: 50 },
    private readonly afterRound?: (canvas: FakeCanvas) => void,
  ) {
    this.shown = this.mirror();
  }

  /** The capture moves the view, and the mirror shows where it went. */
  moveTo(view: CanvasView): void {
    this.view = view;
    this.shown = this.mirror();
  }

  read(): CanvasView {
    return this.shown;
  }

  wheel(deltaX: number, deltaY: number, zoom: boolean): void {
    this.inputs += 1;
    if (this.ignoring) return;
    const { x, y, zoom: scale } = this.view;
    if (zoom) {
      const factor = 2 ** (-deltaY / this.rates.unitsPerDoubling);
      this.view = { x: CENTER.x + (x - CENTER.x) * factor, y: CENTER.y + (y - CENTER.y) * factor, zoom: scale * factor };
      return;
    }
    let [dx, dy] = [-deltaX * this.rates.pxPerUnit, -deltaY * this.rates.pxPerUnit];
    const length = Math.hypot(dx, dy);
    if (length > 120) [dx, dy] = [(dx * 120) / length, (dy * 120) / length];
    this.view = { x: x + dx, y: y + dy, zoom: scale };
  }

  async next(): Promise<CanvasView> {
    this.rounds += 1;
    this.shown = this.mirror();
    this.afterRound?.(this);
    return this.shown;
  }

  stopped(): boolean {
    return this.userSteppedIn;
  }

  private mirror(): CanvasView {
    return { x: Math.round(this.view.x), y: Math.round(this.view.y), zoom: Number(this.view.zoom.toPrecision(6)) };
  }
}

/** Starts at the user's view, takes what the mirror shows as the target, and moves away as a capture does. */
function captured(user: CanvasView, capture: CanvasView, canvas: FakeCanvas = new FakeCanvas(user)): { canvas: FakeCanvas; target: CanvasView } {
  const target = canvas.read();
  canvas.moveTo(capture);
  return { canvas, target };
}

function expectBack(canvas: FakeCanvas, user: CanvasView): void {
  expect(Math.abs(canvas.view.x - user.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(canvas.view.y - user.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(canvas.view.zoom / user.zoom - 1)).toBeLessThan(1e-4);
}

describe("restoreView", () => {
  // Views from the Arc runs: zoom to fit shows the page at 5.43%.
  const fit = { x: 442.3, y: 178.4, zoom: 0.0543119 };

  it("puts back a view the capture zoomed out to fit, in two rounds of input", async () => {
    const user = { x: 57249.3, y: -14172.6, zoom: 2.4476712 };
    const { canvas, target } = captured(user, fit);
    expect(await restoreView(target, canvas)).toBe(true);
    expectBack(canvas, user);
    expect(canvas.rounds).toBeLessThanOrEqual(2);
  });

  it("puts back a view the capture zoomed in on a layer", async () => {
    const user = { x: 23899.4, y: -5597.8, zoom: 1.0079412 };
    const { canvas, target } = captured(user, { x: 81811.2, y: -20707.1, zoom: 3.5098631 });
    expect(await restoreView(target, canvas)).toBe(true);
    expectBack(canvas, user);
    expect(canvas.rounds).toBeLessThanOrEqual(2);
  });

  it("scrolls back alone when the zoom did not change", async () => {
    const user = { x: 1882.2, y: 133.4, zoom: 0.0543119 };
    const { canvas, target } = captured(user, fit);
    expect(await restoreView(target, canvas)).toBe(true);
    expectBack(canvas, user);
    expect(canvas.rounds).toBe(1);
  });

  it("learns how far input goes where it scrolls and zooms at other rates", async () => {
    const user = { x: 57249.3, y: -14172.6, zoom: 2.4476712 };
    const slower = new FakeCanvas(user, { pxPerUnit: 1, unitsPerDoubling: 100 });
    const { canvas, target } = captured(user, fit, slower);
    expect(await restoreView(target, canvas)).toBe(true);
    expectBack(canvas, user);
    // The first round shows how far a unit goes, the second gets there, and the third mends the rounding.
    expect(canvas.rounds).toBeLessThanOrEqual(3);

    const faster = new FakeCanvas(user, { pxPerUnit: 3, unitsPerDoubling: 30 });
    const second = captured(user, fit, faster);
    expect(await restoreView(second.target, second.canvas)).toBe(true);
    expectBack(second.canvas, user);
    expect(second.canvas.rounds).toBeLessThanOrEqual(3);
  });

  it("sends nothing when the view is already in place", async () => {
    const user = { x: 610.2, y: 99.8, zoom: 1 };
    const { canvas, target } = captured(user, user);
    expect(await restoreView(target, canvas)).toBe(true);
    expect(canvas.inputs).toBe(0);
  });

  it("stops once the user steps in, leaving the view to them", async () => {
    const user = { x: 57249.3, y: -14172.6, zoom: 2.4476712 };
    const canvas = new FakeCanvas(user, undefined, (fake) => (fake.userSteppedIn = true));
    const { target } = captured(user, fit, canvas);
    expect(await restoreView(target, canvas)).toBe(false);
    const sent = canvas.inputs;
    expect(canvas.rounds).toBe(1);
    expect(sent).toBeGreaterThan(0);
  });

  it("gives up when Figma ignores the input", async () => {
    const user = { x: 57249.3, y: -14172.6, zoom: 2.4476712 };
    const { canvas, target } = captured(user, fit);
    canvas.ignoring = true;
    expect(await restoreView(target, canvas)).toBe(false);
    expect(canvas.rounds).toBe(1);

    const scrolled = captured({ x: 1882.2, y: 133.4, zoom: 0.0543119 }, fit);
    scrolled.canvas.ignoring = true;
    expect(await restoreView(scrolled.target, scrolled.canvas)).toBe(false);
    expect(scrolled.canvas.rounds).toBe(1);
  });

  it("cannot without the mirror", async () => {
    const none: ViewControls = { read: () => null, center: CENTER, wheel: () => undefined, next: async () => null, stopped: () => false };
    expect(await restoreView({ x: 0, y: 0, zoom: 1 }, none)).toBe(false);
  });

  it("counts a view as the same at the same pixel and zoom", () => {
    expect(sameView({ x: 10, y: 20, zoom: 1.5 }, { x: 10.4, y: 19.6, zoom: 1.50001 })).toBe(true);
    expect(sameView({ x: 10, y: 20, zoom: 1.5 }, { x: 11, y: 20, zoom: 1.5 })).toBe(false);
    expect(sameView({ x: 10, y: 20, zoom: 1.5 }, { x: 10, y: 20, zoom: 1.501 })).toBe(false);
  });
});
