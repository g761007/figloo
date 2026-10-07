import type { CanvasView, LayerNode, NeighborsResult, PageIdentity } from "@figloo/protocol";
import { MAX_ANCHORS } from "@figloo/protocol";
import { parseFigmaUrl } from "../figma-url.js";
import { parseSelectedCount } from "../probe.js";
import { DomRowSource, synthesizeClick } from "./dom-source.js";
import { inspectionHeader, inspectionRoot, inspectionSignature, showsDesignPanel } from "./inspect.js";
import { DEFAULT_LIMITS, MAX_NAME_LENGTH, OpError, normalized, sleep, translate, watchForUser, type RunLimits, type UserSelection, type UserWatch } from "./operation.js";
import { layersPanel, type Row } from "./row.js";
import { LayerTree, StopExploration, type IndexEntry, type Page } from "./tree.js";
import { restoreView } from "./view.js";
import type { PendingCapture } from "./capture-ops.js";
import type { PendingExport } from "./export-ops.js";

/** Layers remembered per page load; several snapshots of up to 2,000 layers fit. */
const INDEX_LIMIT = 50_000;
/** The mirror shows a new view about 0.5 s after it stops changing (Arc, 2026-10-03). */
export const VIEW_UPDATE_TIMEOUT_MS = 1_500;
const EDIT_ACCESS_MESSAGE =
  "this session has edit access, where Figma shows the Design panel instead of the inspection panel Figloo reads, so Figloo cannot read properties or export settings in this file; layers and screenshots still work";

const STOPPED_MESSAGE = "the user stopped the read with Stop or Esc on Figloo's reading overlay; the layers panel and the selection were put back";
const BACKGROUND_TIMEOUT_MESSAGE =
  "the read ran out of time while the Figma tab was in the background; Figloo puts the layers panel and the selection back once the tab is on screen again, unless the user uses Figma first";

/**
 * What every operation shares: the page it runs in, what it learned about layers, one operation at a
 * time within its budgets, and putting the layers panel, the selection, and the view back. The
 * operations live in the *-ops modules, and Explorer in ops.ts offers them.
 */
export class ExplorerCore {
  readonly index = new Map<string, IndexEntry>();
  running = false;
  pendingCapture: PendingCapture | null = null;
  pendingExport: PendingExport | null = null;

  constructor(
    readonly pageId: string,
    readonly doc: Document,
    readonly win: Window,
  ) {}

  identity(): PageIdentity {
    const { fileKey } = parseFigmaUrl(this.win.location.href);
    if (!fileKey) throw new OpError("UI_NOT_READY", "this tab is not showing a Figma design file");
    const page = this.doc.querySelector('[data-testid="PagesRowWrapper"] button[aria-current="page"]')?.textContent?.trim() || null;
    return { pageId: this.pageId, fileKey, page };
  }

  /** Throws when a context no longer matches the page it was created for. */
  checkExpected(expect: PageIdentity): PageIdentity {
    const identity = this.identity();
    if (expect.pageId !== identity.pageId || expect.fileKey !== identity.fileKey) {
      throw new OpError("CONTEXT_EXPIRED", "the Figma tab was reloaded or switched files after the context was created");
    }
    if (expect.page !== null && identity.page !== null && expect.page !== identity.page) {
      throw new OpError("PAGE_CHANGED", `the Figma page changed from "${expect.page}" to "${identity.page}"`);
    }
    return identity;
  }

  /** Puts the user's view back, unless they used Figma since, the tab is in the background, or another operation runs. */
  async putViewBack(view: CanvasView | null, user: UserWatch): Promise<boolean> {
    if (!view || user.interrupted() || this.doc.hidden || this.running) return false;
    const source = new DomRowSource(this.doc);
    const canvas = source.canvasRect();
    if (!canvas) return false;
    const center = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
    this.running = true;
    try {
      return await restoreView(view, {
        read: () => source.canvasView(),
        center,
        wheel: (deltaX, deltaY, zoom) => source.wheel(deltaX, deltaY, zoom, center),
        next: async (before) => {
          const changed = () => {
            const now = source.canvasView();
            return now === null || now.x !== before.x || now.y !== before.y || now.zoom !== before.zoom;
          };
          await source.settle(changed, VIEW_UPDATE_TIMEOUT_MS);
          return source.canvasView();
        },
        stopped: () => user.interrupted() || this.doc.hidden,
      });
    } finally {
      this.running = false;
    }
  }

  /** The inspection panel lives in the Properties tab of the right sidebar, which guests do not have. */
  async showPropertiesTab(): Promise<void> {
    const sidebar = inspectionRoot(this.doc);
    if (!sidebar) throw new OpError("UI_NOT_READY", "Figma is not showing the inspection panel; guest sessions have none, so sign in to Figma");
    const tab = [...sidebar.querySelectorAll('[role="tab"]')].find((el) => /Properties/.test(el.textContent ?? ""));
    if (!tab || tab.getAttribute("aria-selected") === "true") return;
    synthesizeClick(tab);
    for (let i = 0; i < 30 && tab.getAttribute("aria-selected") !== "true"; i += 1) await sleep(50);
  }

  /** The Properties tab for operations that read the inspection panel, which editors do not get. */
  async showInspectionPanel(): Promise<void> {
    await this.showPropertiesTab();
    if (showsDesignPanel(this.doc)) throw new OpError("UI_NOT_READY", EDIT_ACCESS_MESSAGE);
  }

  /** What the user had selected before Figloo changes the selection. */
  async userSelection(tree: LayerTree): Promise<UserSelection> {
    const count = parseSelectedCount(this.doc.querySelector("input.focus-target")?.getAttribute("aria-label") ?? null);
    if (count === 0) return { kind: "none" };
    if (count !== null && count > 1) {
      const roots = count <= MAX_ANCHORS ? await tree.selectionRoots(count) : [];
      if (roots.length !== count) return { kind: "multiple" };
      for (const root of roots) await tree.climb(root);
      return { kind: "layers", ids: roots.map((root) => root.id) };
    }
    const root = await tree.selectionRoot();
    if (!root) return { kind: "none" };
    // Knowing its ancestors lets find() reveal it again after other selections collapse its branch.
    await tree.climb(root);
    return { kind: "layer", id: root.id };
  }

  /** Puts the user's selection back; several layers come back one by one, as Cmd-click adds them. */
  async restoreSelection(tree: LayerTree, source: DomRowSource, before: UserSelection): Promise<boolean> {
    const ids = before.kind === "layer" ? [before.id] : before.kind === "layers" ? before.ids : [];
    if (ids.length > 0) {
      let restored = true;
      for (const [index, id] of ids.entries()) {
        const row = await tree.find(id);
        restored = row !== null && (await source.select(row, index > 0)) && restored;
      }
      if (restored && [null, ids.length].includes(this.selectedCount())) return true;
    }
    source.pressKey("Escape", "Escape", 27);
    // Report the selection as cleared only once Figma shows that it is.
    const cleared = await source.settle(() => this.selectedCount() === 0);
    return before.kind === "none" && cleared;
  }

  selectedCount(): number | null {
    return parseSelectedCount(this.doc.querySelector("input.focus-target")?.getAttribute("aria-label") ?? null);
  }

  /** Waits until the inspection panel shows `row` rather than the previous selection. */
  async waitForPanel(row: Row, previous: string, source: DomRowSource): Promise<void> {
    const name = normalized(row.name).slice(0, 16);
    const started = Date.now();
    const ready = await source.settle(() => {
      const named = name.length === 0 || normalized(inspectionHeader(this.doc) ?? "").includes(name);
      const changed = inspectionSignature(this.doc) !== previous;
      const elapsed = Date.now() - started;
      // Some headers show something else, such as an image's file name; identical neighbours do not change the panel.
      return (changed && (named || elapsed > 500)) || (named && elapsed > 400);
    });
    if (!ready) throw new OpError("UI_NOT_READY", `the inspection panel did not show layer ${row.id}`);
  }

  pageResult(value: Page): Omit<NeighborsResult, "identity" | "uiOps" | "elapsedMs"> {
    return { nodes: value.rows.map((row) => this.toNode(row)), total: value.total, from: value.from, nextFrom: value.nextFrom, hasMore: value.hasMore, stopReason: value.stopReason };
  }

  async run<T>(
    work: (tree: LayerTree, source: DomRowSource) => Promise<T>,
    finish?: (tree: LayerTree, source: DomRowSource) => Promise<void>,
    limits: RunLimits = DEFAULT_LIMITS,
  ): Promise<{ value: T; uiOps: number; elapsedMs: number }> {
    if (this.running) throw new OpError("BUSY", "another Figloo operation is running in this tab");
    if (!layersPanel(this.doc)) throw new OpError("UI_NOT_READY", "the layers panel is not rendered; expand the Figma UI");
    this.running = true;
    const started = Date.now();
    const user = watchForUser(this.win, limits.overlay);
    let stopped = () => user.interrupted() || limits.overlay?.stopRequested === true;
    const source = new DomRowSource(this.doc, limits.pause);
    const tree = new LayerTree(source, this.index, {
      deadline: started + limits.timeBudgetMs,
      maxUiOps: limits.maxUiOps,
      now: Date.now,
      interrupted: () => stopped(),
    });
    try {
      let value: T;
      try {
        value = await work(tree, source);
        // Rows read after the user stepped in may already describe a different state.
        if (user.interrupted()) throw new StopExploration("user_interrupted");
      } catch (error) {
        if (!user.interrupted()) {
          // A Stop on the overlay changed nothing in Figma, so everything is put back; only the user's own input stops that.
          stopped = user.interrupted;
          if (limits.pause && this.doc.hidden) {
            this.putBackLater(tree, source, finish, (watch) => (stopped = watch.interrupted));
            throw error instanceof StopExploration && error.cause === "time_budget" ? new OpError("BUDGET_EXCEEDED", BACKGROUND_TIMEOUT_MESSAGE) : translate(error);
          }
          await this.putBack(tree, source, finish);
          if (limits.overlay?.stopRequested && !user.interrupted()) throw new OpError("USER_INTERRUPTED", STOPPED_MESSAGE);
        } else if (limits.collapseAfterInterrupt) {
          // The user's new selection and scroll position stay; only what this operation opened closes.
          const seen = user.inputs();
          stopped = () => user.inputs() > seen;
          await tree.restore().catch(() => undefined);
        }
        throw translate(error);
      }
      stopped = user.interrupted;
      if (limits.pause && this.doc.hidden) {
        // Figma ignores clicks in the background, so a read that ends there puts the panel back once the tab is on screen.
        this.putBackLater(tree, source, finish, (watch) => (stopped = watch.interrupted));
        return { value, uiOps: tree.uiOps + source.actions, elapsedMs: Date.now() - started };
      }
      await this.putBack(tree, source, finish);
      return { value, uiOps: tree.uiOps + source.actions, elapsedMs: Date.now() - started };
    } finally {
      user.dispose();
      this.running = false;
      if (this.index.size > INDEX_LIMIT) this.index.clear();
    }
  }

  /**
   * Puts the panel back once the tab is on screen again, since Figma ignores clicks in the background.
   * Gives up when the user uses Figma first, the page changes, or another operation is running then.
   * `watchWith` hands the new watch to the tree, so user input also stops the put-back itself.
   */
  putBackLater(
    tree: LayerTree,
    source: DomRowSource,
    finish: ((tree: LayerTree, source: DomRowSource) => Promise<void>) | undefined,
    watchWith: (watch: UserWatch) => void,
  ): void {
    const watch = watchForUser(this.win);
    watchWith(watch);
    const page = JSON.stringify(this.identity());
    const onVisibility = () => {
      if (this.doc.hidden) return;
      this.doc.removeEventListener("visibilitychange", onVisibility);
      if (watch.interrupted() || this.running || JSON.stringify(this.identity()) !== page) {
        watch.dispose();
        return;
      }
      this.running = true;
      void this.putBack(tree, source, finish).finally(() => {
        watch.dispose();
        this.running = false;
      });
    };
    this.doc.addEventListener("visibilitychange", onVisibility);
  }

  /** Best effort: once the user takes over, the panel is left as it is. */
  async putBack(tree: LayerTree, source: DomRowSource, finish?: (tree: LayerTree, source: DomRowSource) => Promise<void>): Promise<void> {
    try {
      await tree.restore();
      // A read that ran out of time or UI operations still finds the user's layers to select them again.
      if (finish) await tree.whileRestoring(() => finish(tree, source));
      source.restoreScroll();
    } catch {
      // Interrupted while restoring; the user's own actions win.
    }
  }

  toNode(row: Row): LayerNode {
    const entry = this.index.get(row.id);
    const insideInstance = row.level === 0 ? false : (entry?.insideInstance ?? null);
    const name = row.name.slice(0, MAX_NAME_LENGTH);
    return {
      ref: row.id,
      name,
      nameTruncated: name.length < row.name.length,
      type: row.type,
      depth: row.level,
      position: row.position,
      siblingCount: row.setSize,
      parentRef: row.level === 0 ? null : (entry?.parentRef ?? null),
      hasChildren: row.hasChildren,
      childCount: row.hasChildren ? (entry?.childCount ?? null) : 0,
      insideInstance,
      link: insideInstance === false ? this.linkFor(row.id) : null,
    };
  }

  linkFor(ref: string): string | null {
    if (!/^\d+:\d+$/.test(ref)) return null;
    const url = new URL(this.win.location.href);
    return `${url.origin}${url.pathname}?node-id=${ref.replace(":", "-")}`;
  }
}
