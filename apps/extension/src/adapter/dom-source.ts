import type { Rect } from "@figloo/protocol";
import { layersPanel, readRenderedRows, rowElement, type Row } from "./row.js";
import type { Align, RowSource } from "./tree.js";
import type { BackgroundPause } from "./visibility.js";

const DEFAULT_ROW_HEIGHT = 32;
const RENDER_TIMEOUT_MS = 1_500;

/**
 * Figma applies caret clicks only while its tab is visible (seen in Arc on 2026-09-30); in a hidden
 * tab the click neither expands nor fails, so it is not sent at all.
 */
export class TabInBackground extends Error {
  constructor() {
    super("Figma only expands layers while its tab is visible");
    this.name = "TabInBackground";
  }
}

/**
 * The live Figma layers panel. Operates it only through scrolling and expand carets. With `pause`,
 * expanding and selecting wait while the tab is in the background instead of failing, and a click
 * that the tab went to the background during is made again once it is back.
 */
export class DomRowSource implements RowSource {
  /** Selections and key presses, which the tree's own UI operation count does not see. */
  actions = 0;
  private readonly initialScrollTop: number | null;

  constructor(
    private readonly doc: Document,
    private readonly pause?: BackgroundPause,
  ) {
    this.initialScrollTop = this.scroller()?.scrollTop ?? null;
  }

  rows(): Row[] {
    return readRenderedRows(this.doc);
  }

  rowCount(): number {
    // Rows are absolutely positioned inside a container sized to the whole flat list.
    const container = layersPanel(this.doc)?.querySelector('[role="row"][aria-rowindex]')?.parentElement;
    const height = container instanceof HTMLElement ? parseFloat(container.style.height) : Number.NaN;
    if (Number.isFinite(height)) return Math.round(height / this.rowHeight());
    const scroller = this.scroller();
    return scroller ? Math.floor(scroller.scrollHeight / this.rowHeight()) : 0;
  }

  async reveal(rowIndex: number, align: Align): Promise<Row[]> {
    const scroller = this.scroller();
    if (!scroller) return this.rows();
    const height = this.rowHeight();
    const top = (rowIndex - 1) * height;
    const target = align === "start" ? top : align === "end" ? top + height - scroller.clientHeight : top + height / 2 - scroller.clientHeight / 2;
    this.scrollTo(scroller, target);
    await this.waitFor(() => this.rows().some((row) => row.rowIndex === rowIndex));
    return this.rows();
  }

  async toggle(row: Row): Promise<Row[]> {
    const toggled = () => {
      const now = this.rows().find((r) => r.id === row.id);
      return now !== undefined && now.expanded !== row.expanded;
    };
    for (let attempt = 0; ; attempt += 1) {
      await this.whenVisible();
      // A click made just before the tab went to the background may have landed after all.
      if (attempt > 0 && toggled()) return this.rows();
      const mark = this.pause?.mark();
      const caret = rowElement(this.doc, row.id)?.querySelector('[data-testid="layers-panel-expand-caret"]');
      if (!caret) return this.rows();
      synthesizeClick(caret);
      if ((await this.waitFor(toggled)) || mark === undefined || !this.pause!.hidSince(mark)) return this.rows();
    }
  }

  /** Selects a layer the way a click in the layers panel does, and waits until Figma shows it selected. */
  /** Selects the row's layer; with `add`, adds it to the selection the way Cmd-click (Ctrl-click off macOS) does. */
  async select(row: Row, add = false): Promise<boolean> {
    const selected = () => this.rows().find((r) => r.id === row.id)?.selected === true;
    for (let attempt = 0; ; attempt += 1) {
      await this.whenVisible();
      // Checked before clicking again, since a Cmd-click on a selected layer would deselect it.
      if (attempt > 0 && selected()) return true;
      const mark = this.pause?.mark();
      const cell = rowElement(this.doc, row.id)?.querySelector('[role="gridcell"]:not([aria-hidden="true"])');
      if (!cell) return false;
      this.actions += 1;
      const mac = /Mac/.test(this.doc.defaultView?.navigator.platform ?? "");
      synthesizeClick(cell, add ? (mac ? { metaKey: true } : { ctrlKey: true }) : {});
      const done = await this.waitFor(selected);
      if (done || mark === undefined || !this.pause!.hidSince(mark)) return done;
    }
  }

  /** Sends a shortcut to the canvas keyboard target, for example Shift+2 to zoom to the selection. */
  pressKey(key: string, code: string, keyCode: number, shiftKey = false): void {
    if (this.doc.hidden) throw new TabInBackground();
    const target = this.doc.querySelector<HTMLElement>("input.focus-target");
    if (!target) return;
    this.actions += 1;
    target.focus();
    const init = { key, code, keyCode, which: keyCode, shiftKey, bubbles: true, cancelable: true, composed: true };
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  /** The part of the canvas no panel covers, in viewport CSS pixels. */
  canvasRect(): Rect | null {
    const canvas = this.doc.querySelector("canvas")?.getBoundingClientRect();
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) return null;
    let left = canvas.left;
    let right = canvas.right;
    const leftPanel = this.doc.querySelector('[data-testid="leftPanelContainer.resizablePanel"]')?.getBoundingClientRect();
    if (leftPanel && leftPanel.width > 0 && leftPanel.right > left && leftPanel.left <= left + 1) left = leftPanel.right;
    const rightPanel = this.doc.querySelector('[data-testid="propertiesPanelContainer.resizablePanel"]')?.getBoundingClientRect();
    if (rightPanel && rightPanel.width > 0 && rightPanel.left < right && rightPanel.right >= right - 1) right = rightPanel.left;
    return right > left ? { x: left, y: canvas.top, width: right - left, height: canvas.height } : null;
  }

  /** Screen bounds of a layer from the screen reader mirror, which covers the selection's neighborhood. */
  /** Whether Figma renders its screen reader mirror, which needs "Adapt content for screen readers". */
  hasMirror(): boolean {
    return this.doc.querySelector('#hidden-input-activedescendant[role="main"]') !== null;
  }

  /**
   * Every layer the mirror currently places on screen. It holds only a few layers around the
   * selection. A line has no height, or no width once rotated a quarter turn, and still counts.
   */
  mirrorRects(): Map<string, Rect> {
    const rects = new Map<string, Rect>();
    for (const el of this.doc.querySelectorAll('[role="main"] [data-nodeid]')) {
      const rect = el.getBoundingClientRect();
      const id = el.getAttribute("data-nodeid");
      if (id && (rect.width > 0 || rect.height > 0)) rects.set(id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }
    return rects;
  }

  mirrorRect(id: string): Rect | null {
    const el = this.doc.querySelector(`[role="main"] [data-nodeid="${id}"]`);
    const rect = el?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
  }

  zoomLabel(): string | null {
    const label = this.doc.querySelector('button[aria-label$="zoom and view options"]')?.getAttribute("aria-label");
    return label ? label.split(",")[0]!.trim() : null;
  }

  async settle(condition: () => boolean, timeoutMs = RENDER_TIMEOUT_MS): Promise<boolean> {
    return this.waitFor(condition, timeoutMs);
  }

  restoreScroll(): void {
    const scroller = this.scroller();
    if (scroller && this.initialScrollTop !== null) this.scrollTo(scroller, this.initialScrollTop);
  }

  /** In the background, waits for the tab with a pause and fails without one. */
  private async whenVisible(): Promise<void> {
    if (!this.doc.hidden) return;
    if (!this.pause) throw new TabInBackground();
    await this.pause.untilVisible();
  }

  private scroller(): HTMLElement | null {
    let el = layersPanel(this.doc);
    const view = this.doc.defaultView;
    while (el && view) {
      if (el instanceof HTMLElement && /auto|scroll/.test(view.getComputedStyle(el).overflowY)) return el;
      el = el.parentElement;
    }
    return null;
  }

  private scrollTo(scroller: HTMLElement, top: number): void {
    scroller.scrollTop = Math.max(0, top);
    // Hidden tabs skip the scroll steps of rendering, so the virtualized list is told directly.
    scroller.dispatchEvent(new Event("scroll"));
  }

  private rowHeight(): number {
    const row = layersPanel(this.doc)?.querySelector('[role="row"][aria-rowindex]');
    const height = row instanceof HTMLElement ? parseFloat(row.style.getPropertyValue("--fpl-tree-grid-row-height")) || row.offsetHeight : 0;
    return height > 0 ? height : DEFAULT_ROW_HEIGHT;
  }

  private async waitFor(condition: () => boolean, timeoutMs = RENDER_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() >= deadline) return false;
      // Timers are throttled in hidden tabs but message tasks are not; a visible tab gets short sleeps.
      await (this.doc.hidden ? nextTask() : sleep(8));
    }
    return true;
  }
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Figma's layers panel accepts untrusted pointer and mouse events (verified in M0). */
/** Modifier keys held during a synthesized click. */
export interface ClickModifiers {
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

export function synthesizeClick(target: Element, modifiers: ClickModifiers = {}): void {
  const rect = target.getBoundingClientRect();
  const init = {
    ...modifiers,
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.x + rect.width / 2,
    clientY: rect.y + rect.height / 2,
    button: 0,
    buttons: 1,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  };
  target.dispatchEvent(new PointerEvent("pointerdown", init));
  target.dispatchEvent(new MouseEvent("mousedown", init));
  target.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
  target.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
  target.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0 }));
}
