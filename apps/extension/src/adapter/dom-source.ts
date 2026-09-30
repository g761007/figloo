import { layersPanel, readRenderedRows, rowElement, type Row } from "./row.js";
import type { Align, RowSource } from "./tree.js";

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

/** The live Figma layers panel. Operates it only through scrolling and expand carets. */
export class DomRowSource implements RowSource {
  private readonly initialScrollTop: number | null;

  constructor(private readonly doc: Document) {
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
    if (this.doc.hidden) throw new TabInBackground();
    const caret = rowElement(this.doc, row.id)?.querySelector('[data-testid="layers-panel-expand-caret"]');
    if (!caret) return this.rows();
    synthesizeClick(caret);
    await this.waitFor(() => {
      const now = this.rows().find((r) => r.id === row.id);
      return now !== undefined && now.expanded !== row.expanded;
    });
    return this.rows();
  }

  restoreScroll(): void {
    const scroller = this.scroller();
    if (scroller && this.initialScrollTop !== null) this.scrollTo(scroller, this.initialScrollTop);
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

  private async waitFor(condition: () => boolean): Promise<boolean> {
    const deadline = Date.now() + RENDER_TIMEOUT_MS;
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
export function synthesizeClick(target: Element): void {
  const rect = target.getBoundingClientRect();
  const init = {
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
