import type {
  AnchorResult,
  CaptureParams,
  CapturePlan,
  ErrorCode,
  ExplorePageParams,
  ExplorePageResult,
  InspectGroup,
  InspectParams,
  InspectResult,
  InspectedNode,
  LayerNode,
  ListNeighborsParams,
  ListPagesResult,
  NeighborsResult,
  PageIdentity,
  Rect,
} from "@figloo/protocol";
import { parseFigmaUrl } from "../figma-url.js";
import { parseSelectedCount } from "../probe.js";
import { DomRowSource, TabInBackground, synthesizeClick } from "./dom-source.js";
import { inspectionHeader, inspectionRoot, inspectionSignature, readInspection } from "./inspect.js";
import { layersPanel, readRenderedRows, type Row } from "./row.js";
import { LayerTree, StopExploration, type IndexEntry, type Page } from "./tree.js";

/** Per-operation budgets from the plan: 15 s of UI work and a bounded number of UI operations. */
export const OP_TIME_BUDGET_MS = 15_000;
export const OP_MAX_UI_OPS = 300;
const MAX_NAME_LENGTH = 200;
const INDEX_LIMIT = 5_000;
const ALL_GROUPS: InspectGroup[] = ["layout", "appearance", "typography", "component"];
const PAGE_SWITCH_TIMEOUT_MS = 8_000;
/** A capture the worker never finished restores the user's selection on its own after this long. */
const PENDING_CAPTURE_TIMEOUT_MS = 10_000;
/** Room around a captured layer, in CSS pixels, so its edges and shadows stay in the image. */
const CAPTURE_MARGIN_PX = 12;
/** Wider margin when the crop is estimated from the layer's size instead of measured. */
const CAPTURE_FALLBACK_MARGIN_PX = 48;
const ZOOM_ANIMATION_MS = 500;
const TOAST_TIMEOUT_MS = 4_000;
const BACKGROUND_MESSAGE = "the Figma tab is in the background, where Figma does not apply selection, zoom, or page changes";

type UserSelection = { kind: "none" } | { kind: "layer"; id: string } | { kind: "multiple" };

interface PendingCapture {
  token: string;
  before: UserSelection;
  user: UserWatch;
  timer: ReturnType<typeof setTimeout>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const normalized = (text: string) => text.replace(/\s+/g, " ").trim();

export class OpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OpError";
  }
}

interface UserWatch {
  interrupted: () => boolean;
  dispose: () => void;
}

/** Any trusted pointer, key, or wheel input during an operation means the user took over. */
function watchForUser(win: Window): UserWatch {
  let interrupted = false;
  const onInput = (event: Event) => {
    if (event.isTrusted) interrupted = true;
  };
  const types = ["pointerdown", "keydown", "wheel"];
  for (const type of types) win.addEventListener(type, onInput, { capture: true, passive: true });
  return {
    interrupted: () => interrupted,
    dispose: () => {
      for (const type of types) win.removeEventListener(type, onInput, { capture: true });
    },
  };
}

/** Runs exploration requests inside one Figma page and remembers what it read about layers. */
export class Explorer {
  private readonly index = new Map<string, IndexEntry>();
  private running = false;
  private pendingCapture: PendingCapture | null = null;

  constructor(
    private readonly pageId: string,
    private readonly doc: Document,
    private readonly win: Window,
  ) {}

  identity(): PageIdentity {
    const { fileKey } = parseFigmaUrl(this.win.location.href);
    if (!fileKey) throw new OpError("UI_NOT_READY", "this tab is not showing a Figma design file");
    const page = this.doc.querySelector('[data-testid="PagesRowWrapper"] button[aria-current="page"]')?.textContent?.trim() || null;
    return { pageId: this.pageId, fileKey, page };
  }

  async getAnchor(): Promise<AnchorResult> {
    const identity = this.identity();
    const label = this.doc.querySelector("input.focus-target")?.getAttribute("aria-label") ?? null;
    const count = parseSelectedCount(label);
    if (count === 0) throw new OpError("NO_SELECTION", "no layer is selected in Figma");
    if (count !== null && count > 1) throw new OpError("MULTIPLE_SELECTION", `${count} layers are selected in Figma`);
    const { value, uiOps, elapsedMs } = await this.run(async (tree) => {
      const row = await tree.selectionRoot();
      if (!row) throw new OpError("NO_SELECTION", "the selected layer is not in the layers panel");
      await tree.climb(row);
      return row;
    });
    return { identity, selectionCount: count ?? 1, anchor: this.toNode(value), uiOps, elapsedMs };
  }

  /** Throws when a context no longer matches the page it was created for. */
  private checkExpected(expect: PageIdentity): PageIdentity {
    const identity = this.identity();
    if (expect.pageId !== identity.pageId || expect.fileKey !== identity.fileKey) {
      throw new OpError("CONTEXT_EXPIRED", "the Figma tab was reloaded or switched files after the context was created");
    }
    if (expect.page !== null && identity.page !== null && expect.page !== identity.page) {
      throw new OpError("PAGE_CHANGED", `the Figma page changed from "${expect.page}" to "${identity.page}"`);
    }
    return identity;
  }

  listPages(): ListPagesResult {
    const { fileKey } = this.identity();
    const pages = [...this.doc.querySelectorAll('[data-testid="PagesRowWrapper"]')]
      .map((wrapper) => wrapper.querySelector("button"))
      .filter((button): button is HTMLButtonElement => button !== null)
      .map((button) => ({ name: button.textContent?.trim() ?? "", current: button.getAttribute("aria-current") === "page" }))
      .filter((page) => page.name.length > 0);
    if (pages.length === 0) throw new OpError("UI_NOT_READY", "the pages list is not shown in Figma's left sidebar");
    return { fileKey, pages };
  }

  async explorePage(params: ExplorePageParams): Promise<ExplorePageResult> {
    let identity = this.identity();
    if (params.page !== undefined && params.page !== identity.page) {
      await this.switchPage(params.page);
      identity = this.identity();
    }
    const { value, uiOps, elapsedMs } = await this.run((tree) => tree.topLevelPage(1, params.limit));
    return { identity, ...this.pageResult(value), uiOps, elapsedMs };
  }

  private async switchPage(name: string): Promise<void> {
    if (this.doc.hidden) throw new OpError("TAB_IN_BACKGROUND", BACKGROUND_MESSAGE);
    const button = [...this.doc.querySelectorAll('[data-testid="PagesRowWrapper"]')]
      .map((wrapper) => wrapper.querySelector("button"))
      .find((candidate) => candidate?.textContent?.trim() === name);
    if (!button) throw new OpError("NODE_NOT_FOUND", `there is no page named "${name}"`);
    const firstRowBefore = readRenderedRows(this.doc)[0]?.id;
    synthesizeClick(button);
    // The pages list marks the new page first; the layers panel follows once Figma has loaded it.
    const deadline = Date.now() + PAGE_SWITCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.identity().page === name && readRenderedRows(this.doc)[0]?.id !== firstRowBefore) return;
      await sleep(50);
    }
    throw new OpError("UI_NOT_READY", `the layers panel did not show page "${name}" in time`);
  }

  async inspectNodes(params: InspectParams): Promise<InspectResult> {
    const identity = this.checkExpected(params.expect);
    if (this.doc.hidden) throw new OpError("TAB_IN_BACKGROUND", BACKGROUND_MESSAGE);
    await this.showPropertiesTab();
    const groups = params.groups ?? ALL_GROUPS;
    let before: UserSelection = { kind: "none" };
    let restored = false;
    const { value, uiOps, elapsedMs } = await this.run(
      async (tree, source) => {
        before = await this.userSelection(tree);
        const nodes: InspectedNode[] = [];
        for (const ref of params.refs) {
          tree.check();
          const row = await tree.find(ref);
          if (!row) throw new OpError("NODE_NOT_FOUND", `layer ${ref} is no longer in the layers panel`);
          const previous = inspectionSignature(this.doc);
          if (!(await source.select(row))) throw new OpError("UI_NOT_READY", `Figma did not select layer ${ref}; guest sessions cannot select layers`);
          await this.waitForPanel(row, previous, source);
          const sections = readInspection(inspectionRoot(this.doc) ?? this.doc).filter((section) =>
            section.group === "other" ? params.groups === undefined : groups.includes(section.group),
          );
          const shown = new Set(sections.map((section) => section.group));
          nodes.push({ ref, name: row.name.slice(0, MAX_NAME_LENGTH), type: row.type, sections, notShown: groups.filter((group) => !shown.has(group)) });
        }
        return nodes;
      },
      async (tree, source) => {
        restored = await this.restoreSelection(tree, source, before);
      },
    );
    return { identity, nodes: value, userSelectionRestored: restored, uiOps, elapsedMs };
  }

  /**
   * Moves the view so the worker can capture it: zooms to the layer (or fits the page), then clears
   * the selection so no outline shows. The user's selection comes back in finishCapture.
   */
  async prepareCapture(params: CaptureParams): Promise<CapturePlan> {
    const identity = this.checkExpected(params.expect);
    if (this.doc.hidden) throw new OpError("TAB_IN_BACKGROUND", BACKGROUND_MESSAGE);
    if (this.pendingCapture) await this.finishCapture(this.pendingCapture.token);
    let before: UserSelection = { kind: "none" };
    const { value } = await this.run(async (tree, source) => {
      before = await this.userSelection(tree);
      const canvas = source.canvasRect();
      if (!canvas) throw new OpError("UI_NOT_READY", "the Figma canvas is not visible");
      let crop: Rect = canvas;
      let cropSource: "layer" | "canvas" = "canvas";
      const zoomBefore = source.zoomLabel();
      if (params.ref !== null) {
        const row = await tree.find(params.ref);
        if (!row) throw new OpError("NODE_NOT_FOUND", `layer ${params.ref} is no longer in the layers panel`);
        const previous = inspectionSignature(this.doc);
        if (!(await source.select(row))) throw new OpError("UI_NOT_READY", `Figma did not select layer ${params.ref}; guest sessions cannot select layers`);
        // The panel's size tells how large the layer should look once zoomed, which checks the bounds below.
        const size = inspectionRoot(this.doc) ? await this.waitForPanel(row, previous, source).then(() => layerSize(this.doc)).catch(() => null) : null;
        source.pressKey("@", "Digit2", 50, true); // Shift+2: zoom to selection
        await source.settle(() => source.zoomLabel() !== zoomBefore);
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
      await source.settle(() => !(this.doc.querySelector('[data-testid="visual-bell-message"]')?.textContent?.trim()), TOAST_TIMEOUT_MS);
      return { crop, cropSource, zoom: source.zoomLabel() };
    });
    const token = crypto.randomUUID();
    const pending: PendingCapture = {
      token,
      before,
      user: watchForUser(this.win),
      timer: setTimeout(() => void this.finishCapture(token), PENDING_CAPTURE_TIMEOUT_MS),
    };
    this.pendingCapture = pending;
    return { identity, token, ...value, viewport: { width: this.win.innerWidth, height: this.win.innerHeight } };
  }

  async finishCapture(token: string): Promise<{ userSelectionRestored: boolean }> {
    const pending = this.pendingCapture;
    if (!pending || pending.token !== token) return { userSelectionRestored: false };
    this.pendingCapture = null;
    clearTimeout(pending.timer);
    pending.user.dispose();
    // If the user clicked or typed while the capture ran, their new selection wins.
    if (pending.user.interrupted()) return { userSelectionRestored: false };
    let restored = false;
    await this.run(
      async () => undefined,
      async (tree, source) => {
        restored = await this.restoreSelection(tree, source, pending.before);
      },
    );
    return { userSelectionRestored: restored };
  }

  /** The inspection panel lives in the Properties tab of the right sidebar, which guests do not have. */
  private async showPropertiesTab(): Promise<void> {
    const sidebar = inspectionRoot(this.doc);
    if (!sidebar) throw new OpError("UI_NOT_READY", "Figma is not showing the inspection panel; guest sessions have none, so sign in to Figma");
    const tab = [...sidebar.querySelectorAll('[role="tab"]')].find((el) => /Properties/.test(el.textContent ?? ""));
    if (!tab || tab.getAttribute("aria-selected") === "true") return;
    synthesizeClick(tab);
    for (let i = 0; i < 30 && tab.getAttribute("aria-selected") !== "true"; i += 1) await sleep(50);
  }

  /** What the user had selected before Figloo changes the selection. */
  private async userSelection(tree: LayerTree): Promise<UserSelection> {
    const count = parseSelectedCount(this.doc.querySelector("input.focus-target")?.getAttribute("aria-label") ?? null);
    if (count === 0) return { kind: "none" };
    if (count !== null && count > 1) return { kind: "multiple" };
    const root = await tree.selectionRoot();
    if (!root) return { kind: "none" };
    // Knowing its ancestors lets find() reveal it again after other selections collapse its branch.
    await tree.climb(root);
    return { kind: "layer", id: root.id };
  }

  /** Puts the user's selection back; several selected layers cannot be restored, so they are cleared. */
  private async restoreSelection(tree: LayerTree, source: DomRowSource, before: UserSelection): Promise<boolean> {
    if (before.kind === "layer") {
      const row = await tree.find(before.id);
      if (row && (await source.select(row))) return true;
    }
    source.pressKey("Escape", "Escape", 27);
    return before.kind === "none";
  }

  /** Waits until the inspection panel shows `row` rather than the previous selection. */
  private async waitForPanel(row: Row, previous: string, source: DomRowSource): Promise<void> {
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

  private pageResult(value: Page): Omit<NeighborsResult, "identity" | "uiOps" | "elapsedMs"> {
    return { nodes: value.rows.map((row) => this.toNode(row)), total: value.total, from: value.from, nextFrom: value.nextFrom, hasMore: value.hasMore, stopReason: value.stopReason };
  }

  async listNeighbors(params: ListNeighborsParams): Promise<NeighborsResult> {
    const identity = this.checkExpected(params.expect);
    const { value, uiOps, elapsedMs } = await this.run(async (tree): Promise<Page> => {
      const row = await tree.find(params.ref);
      if (!row) throw new OpError("NODE_NOT_FOUND", `layer ${params.ref} is no longer in the layers panel`);
      switch (params.relation) {
        case "parent":
          return tree.parentPage(row);
        case "ancestors":
          return tree.ancestorsPage(row, params.from, params.limit);
        case "siblings":
          return tree.siblingsPage(row, params.from, params.limit, params.after);
        case "children":
          return (params.depth ?? 1) > 1 ? tree.subtreePage(row, params.depth!, params.limit) : tree.childrenPage(row, params.from, params.limit, params.after);
      }
    });
    return { identity, ...this.pageResult(value), uiOps, elapsedMs };
  }

  private async run<T>(
    work: (tree: LayerTree, source: DomRowSource) => Promise<T>,
    finish?: (tree: LayerTree, source: DomRowSource) => Promise<void>,
  ): Promise<{ value: T; uiOps: number; elapsedMs: number }> {
    if (this.running) throw new OpError("BUSY", "another Figloo operation is running in this tab");
    if (!layersPanel(this.doc)) throw new OpError("UI_NOT_READY", "the layers panel is not rendered; expand the Figma UI");
    this.running = true;
    const started = Date.now();
    const user = watchForUser(this.win);
    const source = new DomRowSource(this.doc);
    const tree = new LayerTree(source, this.index, {
      deadline: started + OP_TIME_BUDGET_MS,
      maxUiOps: OP_MAX_UI_OPS,
      now: Date.now,
      interrupted: user.interrupted,
    });
    try {
      let value: T;
      try {
        value = await work(tree, source);
        // Rows read after the user stepped in may already describe a different state.
        if (user.interrupted()) throw new StopExploration("user_interrupted");
      } catch (error) {
        if (!user.interrupted()) await this.putBack(tree, source, finish);
        throw translate(error);
      }
      await this.putBack(tree, source, finish);
      return { value, uiOps: tree.uiOps + source.actions, elapsedMs: Date.now() - started };
    } finally {
      user.dispose();
      this.running = false;
      if (this.index.size > INDEX_LIMIT) this.index.clear();
    }
  }

  /** Best effort: once the user takes over, the panel is left as it is. */
  private async putBack(tree: LayerTree, source: DomRowSource, finish?: (tree: LayerTree, source: DomRowSource) => Promise<void>): Promise<void> {
    try {
      await tree.restore();
      if (finish) await finish(tree, source);
      source.restoreScroll();
    } catch {
      // Interrupted while restoring; the user's own actions win.
    }
  }

  private toNode(row: Row): LayerNode {
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

  private linkFor(ref: string): string | null {
    if (!/^\d+:\d+$/.test(ref)) return null;
    const url = new URL(this.win.location.href);
    return `${url.origin}${url.pathname}?node-id=${ref.replace(":", "-")}`;
  }
}

/** Width and height from the inspection panel, for example "393px", "Hug (317px)", or "1,064px". */
function layerSize(doc: Document): { width: number; height: number } | null {
  const root = inspectionRoot(doc);
  const layout = root ? readInspection(root).find((section) => section.kind === "properties") : undefined;
  const px = (name: string) => {
    const value = layout?.properties.find((p) => p.group === null && p.name === name)?.value;
    const match = value ? /([\d,.]+)px\)?$/.exec(value) : null;
    return match ? Number(match[1]!.replace(/,/g, "")) : Number.NaN;
  };
  const width = px("Width");
  const height = px("Height");
  return width > 0 && height > 0 ? { width, height } : null;
}

function parseZoom(label: string | null): number | null {
  const match = label ? /^([\d.]+)%$/.exec(label) : null;
  return match ? Number(match[1]) / 100 : null;
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

/** Zoom to selection centers the layer, so its size alone places it roughly in the canvas. */
function centered(canvas: Rect, size: { width: number; height: number }, margin: number): Rect {
  return {
    x: canvas.x + (canvas.width - size.width) / 2 - margin,
    y: canvas.y + (canvas.height - size.height) / 2 - margin,
    width: size.width + 2 * margin,
    height: size.height + 2 * margin,
  };
}

function inflate(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + 2 * by, height: rect.height + 2 * by };
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function translate(error: unknown): unknown {
  if (error instanceof TabInBackground) {
    return new OpError("TAB_IN_BACKGROUND", "the Figma tab is in the background, where Figma does not expand layers");
  }
  if (!(error instanceof StopExploration)) return error;
  if (error.cause === "user_interrupted") return new OpError("USER_INTERRUPTED", "the user interacted with Figma during the operation");
  if (error.cause === "ui_timeout") return new OpError("UI_NOT_READY", "the layers panel did not respond in time");
  return new OpError("BUDGET_EXCEEDED", `stopped by the ${error.cause.replace("_", " ")}`);
}
