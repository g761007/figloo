import type {
  AnchorResult,
  CanvasView,
  CapturedFile,
  CaptureParams,
  ExportParams,
  ExportPlan,
  CapturePlan,
  ErrorCode,
  ExplorePageParams,
  ExplorePageResult,
  InspectGroup,
  InspectParams,
  InspectResult,
  InspectedNode,
  InspectedSection,
  LayerNode,
  ListNeighborsParams,
  ListPagesResult,
  NeighborsResult,
  PageIdentity,
  ReadSubtreeParams,
  Rect,
  SnapshotLayer,
  SnapshotReadResult,
  VisualNeighbor,
  VisualNeighborsParams,
  VisualNeighborsResult,
} from "@figloo/protocol";
import { MAX_ANCHORS, MAX_NEIGHBOR_LIMIT } from "@figloo/protocol";
import { CAPTURE_MARGIN_PX, inflate, intersect } from "../capture.js";
import { parseFigmaUrl } from "../figma-url.js";
import { parseSelectedCount } from "../probe.js";
import { DomRowSource, TabInBackground, nextTask, synthesizeClick } from "./dom-source.js";
import { addTemporarySetting, exportButton, exportRows, exportSection, exportSettings, exportsLayer, removeTemporarySetting } from "./export.js";
import { boundsInRoot, chooseZoom, placeSiblings, type LayerBox, type Measured } from "./geometry.js";
import { inspectionHeader, inspectionRoot, inspectionSignature, readInspection } from "./inspect.js";
import { ReadingOverlay, estimateRemainingMs } from "./overlay.js";
import { readPagesList } from "./pages.js";
import { layersPanel, readRenderedRows, type Row } from "./row.js";
import { readInTurn, resumePoint } from "./resume.js";
import { LayerTree, StopExploration, hiddenLayers, learnParents, type IndexEntry, type Page } from "./tree.js";
import { restoreView } from "./view.js";
import { BackgroundPause } from "./visibility.js";

/** Per-operation budgets from the plan: 15 s of UI work and a bounded number of UI operations. */
export const OP_TIME_BUDGET_MS = 15_000;
export const OP_MAX_UI_OPS = 300;
const MAX_NAME_LENGTH = 200;
/** Layers remembered per page load; several snapshots of up to 2,000 layers fit. */
const INDEX_LIMIT = 50_000;
const ALL_GROUPS: InspectGroup[] = ["layout", "appearance", "typography", "component"];
const PAGE_SWITCH_TIMEOUT_MS = 8_000;
/** How long the pages list must stay the same before it is reported, and the most list_pages waits for that. */
const PAGES_SETTLE_MS = 200;
const PAGES_WAIT_MS = 2_000;
/** A capture the worker never finished restores the user's selection and view on its own after this long. */
const PENDING_CAPTURE_TIMEOUT_MS = 10_000;
/** Wider margin when the crop is estimated from the layer's size instead of measured. */
const CAPTURE_FALLBACK_MARGIN_PX = 48;
const ZOOM_ANIMATION_MS = 500;
const TOAST_TIMEOUT_MS = 4_000;
/** The mirror shows a new view about 0.5 s after it stops changing (Arc, 2026-10-03). */
const VIEW_UPDATE_TIMEOUT_MS = 1_500;
const BACKGROUND_MESSAGE = "the Figma tab is in the background, where Figma does not apply selection, zoom, or page changes";
/** A snapshot's UI budget per allowed layer: the walk opens a layer at most once, and reading reveals few rows. */
const SNAPSHOT_UI_OPS_PER_LAYER = 3;
/** How long a snapshot waits for the mirror to place a selected layer; it never places hidden ones. */
const SNAPSHOT_MIRROR_WAIT_MS = 300;
/** A resumable snapshot stops reading this long before its deadline, plus time to close each layer it opened. */
const SNAPSHOT_RESERVE_MS = 5_000;
const COLLAPSE_MS_PER_ROW = 100;

/** Budgets of one operation, and what happens to the layers panel when the user steps in. */
interface RunLimits {
  timeBudgetMs: number;
  maxUiOps: number;
  /** Close the layers this operation opened even after the user stepped in, until their next input. */
  collapseAfterInterrupt?: boolean;
  /** Shown during the operation: input on it is not the user stepping in, and its Stop ends the operation. */
  overlay?: ReadingOverlay;
  /** Wait while the tab is in the background instead of failing; ending there puts the panel back once the tab returns. */
  pause?: BackgroundPause;
}

const DEFAULT_LIMITS: RunLimits = { timeBudgetMs: OP_TIME_BUDGET_MS, maxUiOps: OP_MAX_UI_OPS };

/** What the user had selected: none, one layer, several found layers, or several Figloo could not all find. */
type UserSelection = { kind: "none" } | { kind: "layer"; id: string } | { kind: "layers"; ids: string[] } | { kind: "multiple" };

const STOPPED_MESSAGE = "the user stopped the read with Stop or Esc on Figloo's reading overlay; the layers panel and the selection were put back";
const BACKGROUND_TIMEOUT_MESSAGE =
  "the read ran out of time while the Figma tab was in the background; Figloo puts the layers panel and the selection back once the tab is on screen again, unless the user uses Figma first";

const MIRROR_MESSAGE =
  "Figma shows where layers are on screen only with Adapt content for screen readers turned on (Main menu, Preferences, Accessibility settings)";

interface PendingExport {
  token: string;
  files: CapturedFile[];
  /** How Figma tried to hand files over, from the page hook. */
  notes: string[];
  onMessage: (event: MessageEvent) => void;
  before: UserSelection;
  /** What the layer's own settings export, such as "PNG 2x", before Figloo added its temporary one. */
  original: string[];
  temporary: boolean;
  user: UserWatch;
  timer: ReturnType<typeof setTimeout>;
}

/** An export that never finishes cleans up on its own after this long. */
const PENDING_EXPORT_TIMEOUT_MS = 30_000;
/** Notes kept per export about how Figma tried to hand files over. */
const MAX_EXPORT_NOTES = 20;

interface PendingCapture {
  token: string;
  before: UserSelection;
  /** The user's view before the capture moved it. */
  view: CanvasView | null;
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
  /** How many inputs the user made so far. */
  inputs: () => number;
  dispose: () => void;
}

/** Any trusted pointer, key, or wheel input during an operation means the user took over, except input on the overlay. */
export function watchForUser(win: Window, overlay?: ReadingOverlay): UserWatch {
  let inputs = 0;
  const onInput = (event: Event) => {
    if (event.isTrusted && !overlay?.owns(event)) inputs += 1;
  };
  const types = ["pointerdown", "keydown", "wheel"];
  for (const type of types) win.addEventListener(type, onInput, { capture: true, passive: true });
  return {
    interrupted: () => inputs > 0,
    inputs: () => inputs,
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
  private pendingExport: PendingExport | null = null;

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
    const { value, uiOps, elapsedMs } = await this.run(async (tree) => {
      // One layer can be found from the rows on screen; several need the list read in order.
      const single = count === null || count === 1;
      const rows = single ? [await tree.selectionRoot()].filter((row): row is Row => row !== null) : await tree.selectionRoots(Math.min(count, MAX_ANCHORS));
      if (rows.length === 0) throw new OpError("NO_SELECTION", "the selected layer is not in the layers panel");
      for (const row of rows) await tree.climb(row);
      return rows;
    });
    const anchors = value.map((row) => this.toNode(row));
    return { identity, selectionCount: count ?? 1, anchor: anchors[0]!, anchors, uiOps, elapsedMs };
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

  /**
   * Lists the pages once the pages list has stopped changing. Figma drew every page at once in each
   * load seen in Arc on 2026-10-02, yet one first read there returned 8 of a file's 20 pages.
   */
  async listPages(): Promise<ListPagesResult> {
    const { fileKey } = this.identity();
    const deadline = Date.now() + PAGES_WAIT_MS;
    let list = readPagesList(this.doc);
    let changedAt = Date.now();
    while (Date.now() - changedAt < PAGES_SETTLE_MS && Date.now() < deadline) {
      // Timers are throttled in hidden tabs but message tasks are not.
      await (this.doc.hidden ? nextTask() : sleep(25));
      const next = readPagesList(this.doc);
      if (JSON.stringify(next) !== JSON.stringify(list)) {
        list = next;
        changedAt = Date.now();
      }
    }
    if (list.pages.length === 0) throw new OpError("UI_NOT_READY", "the pages list is not shown in Figma's left sidebar");
    const settled = Date.now() - changedAt >= PAGES_SETTLE_MS;
    return { fileKey, pages: list.pages, complete: settled && list.allDrawn };
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
    learnParents(this.index, params.known ?? []);
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
   * Places the siblings of a layer by where they are on screen. Figma's screen reader mirror only
   * places the selected layer, its neighbours in layer order, its parent, and its first child, so
   * every third sibling is selected in turn. The user's selection is put back afterwards.
   */
  async visualNeighbors(params: VisualNeighborsParams): Promise<VisualNeighborsResult> {
    const identity = this.checkExpected(params.expect);
    learnParents(this.index, params.known ?? []);
    if (this.doc.hidden) throw new OpError("TAB_IN_BACKGROUND", BACKGROUND_MESSAGE);
    await this.showPropertiesTab();
    let before: UserSelection = { kind: "none" };
    let restored = false;
    const { value, uiOps, elapsedMs } = await this.run(
      async (tree, source) => {
        if (!source.hasMirror()) throw new OpError("UI_NOT_READY", MIRROR_MESSAGE);
        before = await this.userSelection(tree);
        const row = await tree.find(params.ref);
        if (!row) throw new OpError("NODE_NOT_FOUND", `layer ${params.ref} is no longer in the layers panel`);
        const page = await tree.siblingsPage(row, 1, MAX_NEIGHBOR_LIMIT);
        const list = page.rows;
        const siblingsHasMore = page.hasMore;
        const rects = new Map<string, Rect>();
        const boxes = new Map<string, LayerBox>();
        // The mirror places frames, groups, shapes, and instances, but not text layers.
        const isText = (layer: Row) => layer.type === "Text";
        const select = async (target: Row): Promise<void> => {
          tree.check();
          const shown = (await tree.find(target.id)) ?? target;
          const previous = inspectionSignature(this.doc);
          if (!(await source.select(shown))) throw new OpError("UI_NOT_READY", `Figma did not select layer ${target.id}`);
          if (!isText(target)) {
            await source.settle(() => source.mirrorRect(target.id) !== null);
            for (const [id, rect] of source.mirrorRects()) rects.set(id, rect);
          }
          const inPanel = await this.waitForPanel(shown, previous, source).then(() => true).catch(() => false);
          const box = inPanel ? layerBox(this.doc) : null;
          if (box) boxes.set(target.id, box);
        };
        await select(row);
        // Selecting a layer also places its neighbours in layer order, so pick the next one when it can.
        for (let i = 0; i < list.length; i += 1) {
          const sibling = list[i]!;
          if (sibling.id === row.id || isText(sibling) || rects.has(sibling.id)) continue;
          const next = list[i + 1];
          await select(next && next.id !== row.id && !isText(next) ? next : sibling);
        }
        // Text layers get their position from the panel.
        for (const sibling of list) {
          if (sibling.id !== row.id && isText(sibling) && !boxes.has(sibling.id)) await select(sibling);
        }
        return { row, list, rects, boxes, siblingsHasMore, zoomLabel: parseZoom(source.zoomLabel()) };
      },
      async (tree, source) => {
        restored = await this.restoreSelection(tree, source, before);
      },
    );
    const measured = (layer: Row): Measured => ({ id: layer.id, rect: value.rects.get(layer.id) ?? null, box: value.boxes.get(layer.id) ?? null });
    const others = value.list.filter((layer) => layer.id !== value.row.id);
    const result = placeSiblings(measured(value.row), others.map(measured), value.zoomLabel);
    if (!result.reference) {
      throw new OpError("UI_NOT_READY", `Figma shows no position for layer ${params.ref}: it may be hidden, or a text layer placed by auto layout`);
    }
    const byId = new Map(others.map((layer) => [layer.id, layer]));
    const placed: VisualNeighbor[] = result.placed.map(({ id, placement }) => ({ ...this.toNode(byId.get(id)!), ...placement }));
    const nearest = params.direction === "nearest";
    const wanted = nearest ? placed : placed.filter((neighbor) => neighbor.side === params.direction);
    // For a direction, layers in the same row or column come before those off to a diagonal.
    wanted.sort(nearest ? (a, b) => a.gap - b.gap : (a, b) => Number(b.inLine) - Number(a.inLine) || a.gap - b.gap);
    return {
      identity,
      reference: { width: Math.round(result.reference.width * 10) / 10, height: Math.round(result.reference.height * 10) / 10 },
      zoom: result.zoom === null ? null : Math.round(result.zoom * 10_000) / 10_000,
      neighbors: wanted.slice(0, params.limit),
      compared: placed.length,
      unplaced: result.unplaced,
      siblingsHasMore: value.siblingsHasMore,
      userSelectionRestored: restored,
      uiOps,
      elapsedMs,
    };
  }

  /**
   * Moves the view so the worker can capture it: zooms to the layer (or fits the page), then clears
   * the selection so no outline shows. The user's selection comes back in finishCapture.
   */
  async prepareCapture(params: CaptureParams): Promise<CapturePlan> {
    const identity = this.checkExpected(params.expect);
    learnParents(this.index, params.known ?? []);
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
      const view = await userView(source);
      if (params.ref !== null) {
        const row = await tree.find(params.ref);
        if (!row) throw new OpError("NODE_NOT_FOUND", `layer ${params.ref} is no longer in the layers panel`);
        const previous = inspectionSignature(this.doc);
        if (!(await source.select(row))) throw new OpError("UI_NOT_READY", `Figma did not select layer ${params.ref}; guest sessions cannot select layers`);
        // The panel's size tells how large the layer should look once zoomed, which checks the bounds below.
        const size = inspectionRoot(this.doc) ? await this.waitForPanel(row, previous, source).then(() => layerSize(this.doc)).catch(() => null) : null;
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
      await source.settle(() => !(this.doc.querySelector('[data-testid="visual-bell-message"]')?.textContent?.trim()), TOAST_TIMEOUT_MS);
      return { crop, cropSource, canvas, zoom: source.zoomLabel(), view };
    });
    const token = crypto.randomUUID();
    const pending: PendingCapture = {
      token,
      before,
      view: value.view,
      user: watchForUser(this.win),
      timer: setTimeout(() => void this.finishCapture(token), PENDING_CAPTURE_TIMEOUT_MS),
    };
    this.pendingCapture = pending;
    return { identity, token, ...value, viewport: { width: this.win.innerWidth, height: this.win.innerHeight } };
  }

  /**
   * Puts the user's selection back, and their view unless `keepView`: a snapshot reads at the
   * capture's view and puts the view back once it is done.
   */
  async finishCapture(token: string, keepView = false): Promise<{ userSelectionRestored: boolean; viewRestored: boolean; interrupted: boolean }> {
    const pending = this.pendingCapture;
    if (!pending || pending.token !== token) return { userSelectionRestored: false, viewRestored: false, interrupted: false };
    this.pendingCapture = null;
    clearTimeout(pending.timer);
    try {
      // If the user clicked or typed while the capture ran, their new selection and view win.
      if (pending.user.interrupted()) return { userSelectionRestored: false, viewRestored: false, interrupted: true };
      let restored = false;
      await this.run(
        async () => undefined,
        async (tree, source) => {
          restored = await this.restoreSelection(tree, source, pending.before);
        },
      );
      const viewRestored = keepView ? false : await this.putViewBack(pending.view, pending.user);
      return { userSelectionRestored: restored, viewRestored, interrupted: false };
    } finally {
      pending.user.dispose();
    }
  }

  /** Puts the user's view back, unless they used Figma since, the tab is in the background, or another operation runs. */
  private async putViewBack(view: CanvasView | null, user: UserWatch): Promise<boolean> {
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

  /**
   * Reads a layer and its whole subtree for a snapshot, instances counting as one layer: walks the
   * layers panel once, opening what is collapsed, then selects every layer in panel order to read
   * its inspection panel and where the mirror shows it. The view must not move meanwhile, so the
   * screen positions match the screenshot taken just before. Closes what it opened and puts the
   * user's selection back. A subtree above `maxLayers` is not read; its root's children are listed.
   * With `resume`, a call that runs short of time stops between layers and reports how far it got,
   * and a later call goes on from there after walking the panel again.
   */
  async readSubtree(params: ReadSubtreeParams): Promise<SnapshotReadResult> {
    const identity = this.checkExpected(params.expect);
    learnParents(this.index, params.known ?? []);
    if (this.doc.hidden) throw new OpError("TAB_IN_BACKGROUND", BACKGROUND_MESSAGE);
    // The screenshot was taken before this op, so the overlay cannot end up in it.
    const overlay = new ReadingOverlay(this.doc);
    // Stop on the overlay changes nothing in Figma, so the view goes back then too; other input means the user took over.
    const user = watchForUser(this.win, overlay);
    const viewBack = () => this.putViewBack(params.view, user).finally(() => user.dispose());
    await this.showPropertiesTab().catch(async (error: unknown) => {
      await viewBack();
      throw error;
    });
    let before: UserSelection = { kind: "none" };
    let restored = false;
    let rootPath: string[] = [];
    const deadline = Date.now() + params.timeBudgetMs;
    const pause = new BackgroundPause(this.doc, deadline, (paused) => overlay.setPaused(paused));
    const ran = await this.run(
      async (tree, source) => {
        overlay.show();
        const started = Date.now();
        before = await this.userSelection(tree);
        const root = await tree.find(params.ref);
        if (!root) throw new OpError("NODE_NOT_FOUND", `layer ${params.ref} is no longer in the layers panel`);
        const { chain, reachedTop } = await tree.climb(root);
        if (!reachedTop) throw new OpError("UI_NOT_READY", `the layers panel did not show the parents of layer ${params.ref}`);
        if (chain.some((parent) => parent.type === "Instance")) {
          throw new OpError("INSIDE_INSTANCE", `layer ${params.ref} is inside an instance, whose layer IDs only hold until the page reloads`);
        }
        // The climb goes from the parent up; the snapshot keeps the way down, so the root can be found after a reload.
        rootPath = chain.map((parent) => parent.id).reverse();
        const walk = await tree.walkSubtree(root, params.maxLayers, (found) => overlay.update({ phase: "walking", found }));
        if (!walk.complete) {
          const page = await tree.childrenPage(walk.layers[0]!.row, 1, MAX_NEIGHBOR_LIMIT);
          return { status: "too_large" as const, children: page.rows, childrenHasMore: page.hasMore };
        }
        const walkMs = Date.now() - started;
        const walked = walk.layers.map(({ row, parentRef }) => ({ ref: row.id, parentRef }));
        const { start, restarted } = resumePoint(
          walked.map(({ ref, parentRef }) => `${ref}|${parentRef}`),
          params.resume,
        );
        // Every call reads the root first: its place on screen and its width give this call's zoom.
        const indexes = [0, ...walk.layers.map((_, i) => i).slice(Math.max(1, start))];
        // The view stays put, so every layer the mirror places on the way is measured on the same screen.
        const rects = new Map<string, Rect>();
        const collect = () => {
          for (const [id, rect] of source.mirrorRects()) rects.set(id, rect);
        };
        const durations: number[] = [];
        let fresh = 0;
        const readOne = async (index: number) => {
          const layer = walk.layers[index]!;
          const done = Math.max(start, 0) + fresh;
          overlay.update({ phase: "reading", done, total: walk.layers.length, remainingMs: estimateRemainingMs(durations, walk.layers.length - done) });
          // A layer read while the tab went to the background may show a stale panel, so it is read again once the tab is back.
          for (;;) {
            const layerStarted = Date.now();
            const mark = pause.mark();
            tree.check();
            const row = await tree.find(layer.row.id);
            if (!row) throw new OpError("NODE_NOT_FOUND", `layer ${layer.row.id} is no longer in the layers panel`);
            const previous = inspectionSignature(this.doc);
            if (!(await source.select(row))) throw new OpError("UI_NOT_READY", `Figma did not select layer ${row.id}`);
            // Two layers that look alike leave the panel unchanged; the selection itself did change.
            const switched = await this.waitForPanel(row, previous, source).then(
              () => true,
              () => false,
            );
            const sections = readInspection(inspectionRoot(this.doc) ?? this.doc);
            collect();
            // The mirror does not place text layers.
            if (row.type !== "Text" && !rects.has(row.id) && (await source.settle(() => source.mirrorRects().has(row.id), SNAPSHOT_MIRROR_WAIT_MS))) collect();
            if (!pause.hidSince(mark)) {
              durations.push(Date.now() - layerStarted);
              // The root read again by a later call is not a new layer.
              if (index > 0 || start === 0) fresh += 1;
              return { layer, sections, exports: switched ? designerExports(this.doc, row.name) : null };
            }
            await pause.untilVisible();
          }
        };
        // Only a resumable read stops early, while there is still time to close what the walk opened and to answer.
        const timeIsUp = () => Date.now() > deadline - SNAPSHOT_RESERVE_MS - COLLAPSE_MS_PER_ROW * tree.expandedCount();
        const { read, stoppedAt } = await readInTurn(indexes, readOne, { canStop: params.resume !== undefined, timeIsUp });
        if (stoppedAt !== null && fresh === 0) throw new OpError("BUDGET_EXCEEDED", "the snapshot ran out of time before it could read a layer");
        overlay.update({ phase: "finishing" });
        return {
          status: stoppedAt === null ? ("complete" as const) : ("partial" as const),
          read,
          rects,
          walkMs,
          zoomLabel: parseZoom(source.zoomLabel()),
          start,
          walked,
          restarted,
          // A row's color alone can miss a layer inside a hidden one, so hidden parents count too, read in this call or not.
          hidden: hiddenLayers(walk.layers),
        };
      },
      async (tree, source) => {
        restored = await this.restoreSelection(tree, source, before);
      },
      { timeBudgetMs: params.timeBudgetMs, maxUiOps: SNAPSHOT_UI_OPS_PER_LAYER * params.maxLayers, collapseAfterInterrupt: true, overlay, pause },
    )
      .finally(() => {
        overlay.remove();
        pause.dispose();
      })
      .catch(async (error: unknown) => {
        await viewBack();
        throw error;
      });
    const viewRestored = await viewBack();
    const { value, uiOps, elapsedMs } = ran;
    if (value.status === "too_large") {
      return {
        status: "too_large",
        identity,
        maxLayers: params.maxLayers,
        children: value.children.map((row) => this.toNode(row)),
        childrenHasMore: value.childrenHasMore,
        userSelectionRestored: restored,
        viewRestored,
        uiOps,
        elapsedMs,
      };
    }
    const measures = value.read.map(({ layer, sections }) => {
      const box = boxOf(sections);
      // A rotated layer's Top and Left are where its origin went, not the corner of what shows on screen.
      const rotated = sections.some((section) => section.properties.some((p) => p.group === null && p.name === "Rotation"));
      return { id: layer.row.id, parentId: layer.parentRef, type: layer.row.type, rect: value.rects.get(layer.row.id) ?? null, box: box && rotated ? { ...box, position: null } : box };
    });
    const root = measures[0]!;
    // The root's width on screen over its width in the panel, as for visual neighbors.
    const zoom = chooseZoom(root.rect && root.box ? root.rect.width / root.box.width : null, value.zoomLabel);
    const rootOnScreen = root.rect && root.rect.width > 0 && root.rect.height > 0 ? root.rect : null;
    // Layers read now may sit in frames earlier calls placed.
    const bounds = boundsInRoot(measures, zoom, value.start > 0 ? (params.resume?.placed ?? []) : []);
    const own = value.start > 0 ? value.read.slice(1) : value.read;
    const layers: SnapshotLayer[] = own.map(({ layer: { row, parentRef, depth }, sections, exports }) => ({
      ref: row.id,
      name: row.name.slice(0, MAX_NAME_LENGTH),
      type: row.type,
      depth,
      parentRef,
      position: row.position,
      siblingCount: row.setSize,
      hasChildren: row.hasChildren,
      hidden: value.hidden.has(row.id),
      bounds: bounds.get(row.id)!,
      sections,
      exports,
    }));
    return {
      status: value.status,
      identity,
      layers,
      readFrom: value.start,
      walked: value.walked,
      restarted: value.restarted,
      rootPath,
      rootOnScreen,
      zoom,
      walkMs: value.walkMs,
      userSelectionRestored: restored,
      viewRestored,
      uiOps,
      elapsedMs,
    };
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

  /**
   * Exports a layer through the inspection panel's Export button. Without an explicit format and with
   * settings of its own, the layer exports as the designer set it up; otherwise a temporary setting is
   * added and removed again in finishExport. Files captured in the page arrive as window messages.
   */
  async prepareExport(params: ExportParams): Promise<ExportPlan> {
    const identity = this.checkExpected(params.expect);
    learnParents(this.index, params.known ?? []);
    if (this.doc.hidden) throw new OpError("TAB_IN_BACKGROUND", BACKGROUND_MESSAGE);
    await this.showPropertiesTab();
    if (this.pendingExport) await this.finishExport(this.pendingExport.token, 0, 0);
    const files: CapturedFile[] = [];
    const notes: string[] = [];
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { __figlooExport?: string; __figlooExportNote?: string; note?: unknown; name?: unknown; type?: unknown; data?: unknown } | null;
      if (event.source === this.win && data?.__figlooExportNote === params.token && notes.length < MAX_EXPORT_NOTES) notes.push(String(data.note).slice(0, 120));
      if (event.source !== this.win || !data || data.__figlooExport !== params.token || !(data.data instanceof ArrayBuffer)) return;
      files.push({ name: String(data.name || "export"), mimeType: String(data.type || "application/octet-stream"), data: toBase64(data.data) });
    };
    this.win.addEventListener("message", onMessage);
    let before: UserSelection = { kind: "none" };
    let original: string[] = [];
    let temporary = false;
    try {
      const { value } = await this.run(async (tree, source) => {
        before = await this.userSelection(tree);
        try {
          const row = await tree.find(params.ref);
          if (!row) throw new OpError("NODE_NOT_FOUND", `layer ${params.ref} is no longer in the layers panel`);
          // Figma's Export button does nothing for such a layer, so there is no file to wait for.
          if (row.hidden) throw new OpError("LAYER_HIDDEN", `layer ${params.ref} is hidden in Figma, or inside a hidden layer, and Figma exports nothing for it`);
          const previous = inspectionSignature(this.doc);
          if (!(await source.select(row))) throw new OpError("UI_NOT_READY", `Figma did not select layer ${params.ref}; guest sessions cannot select layers`);
          await this.waitForPanel(row, previous, source);
          // Right after a selection change the section can still list the previous layer's settings.
          // A layer without settings keeps the previous button label, so settings count as this
          // layer's only under a button that names it.
          await source.settle(() => {
            const shown = exportSection(this.doc);
            return shown !== null && (exportRows(shown).length === 0 || exportsLayer(shown, row.name));
          });
          const section = exportSection(this.doc);
          if (!section) throw new OpError("UI_NOT_READY", "the inspection panel does not show an export section for this layer");
          original = exportSettings(section);
          if (original.length > 0 && !exportsLayer(section, row.name)) throw new OpError("UI_NOT_READY", `the export section did not switch to layer ${params.ref}`);
          // The requested format, or SVG for a layer without settings; a matching setting is reused.
          const format = params.format ?? (original.length === 0 ? "svg" : undefined);
          const scale = params.scale ?? "1x";
          if (format !== undefined && !original.includes(`${format.toUpperCase()} ${scale}`)) {
            temporary = true;
            const failure = await addTemporarySetting(section, original, format, scale);
            if (failure) throw new OpError("UI_NOT_READY", failure);
          }
          const settings = exportRows(section).map(({ format, scale }) => ({ format: format ?? "unknown", scale }));
          // Once the layer has a setting the button names it; a stale label would export another layer.
          if (!(await source.settle(() => exportsLayer(section, row.name)))) {
            throw new OpError("UI_NOT_READY", `the Export button does not name layer ${params.ref}, so Figloo did not click it`);
          }
          const button = exportButton(section);
          if (!button) throw new OpError("UI_NOT_READY", "the inspection panel has no Export button for this layer");
          source.actions += 1;
          synthesizeClick(button);
          return { name: row.name.slice(0, MAX_NAME_LENGTH), settings, temporary, onlyFormat: params.format !== undefined && original.length > 0 ? params.format : null };
        } catch (error) {
          // Leave the layer as it was: drop a half-configured temporary setting and reselect.
          if (temporary) await this.removeTemporaryRow(original);
          await tree.whileRestoring(() => this.restoreSelection(tree, source, before)).catch(() => false);
          throw error;
        }
      });
      this.pendingExport = {
        token: params.token,
        files,
        notes,
        onMessage,
        before,
        original,
        temporary,
        user: watchForUser(this.win),
        timer: setTimeout(() => void this.finishExport(params.token, 0, 0), PENDING_EXPORT_TIMEOUT_MS),
      };
      return { identity, ...value };
    } catch (error) {
      this.win.removeEventListener("message", onMessage);
      throw error;
    }
  }

  /** Waits up to `waitMs` for `expected` captured files, then removes the temporary setting and reselects. */
  async finishExport(token: string, expected: number, waitMs: number): Promise<{ files: CapturedFile[]; notes: string[]; userSelectionRestored: boolean }> {
    const pending = this.pendingExport;
    if (!pending || pending.token !== token) return { files: [], notes: [], userSelectionRestored: false };
    const deadline = Date.now() + waitMs;
    // Figma may pack several files into one ZIP, which then holds all of them.
    const zipped = () => pending.files.some((file) => file.mimeType === "application/zip" || /\.zip$/i.test(file.name));
    while (pending.files.length < expected && !zipped() && Date.now() < deadline && !pending.user.interrupted()) await sleep(100);
    this.pendingExport = null;
    clearTimeout(pending.timer);
    this.win.removeEventListener("message", pending.onMessage);
    pending.user.dispose();
    if (pending.user.interrupted()) return { files: pending.files, notes: pending.notes, userSelectionRestored: false };
    let restored = false;
    await this.run(
      async () => undefined,
      async (tree, source) => {
        if (pending.temporary) await this.removeTemporaryRow(pending.original);
        restored = await this.restoreSelection(tree, source, pending.before);
      },
    );
    return { files: pending.files, notes: pending.notes, userSelectionRestored: restored };
  }

  private async removeTemporaryRow(original: string[]): Promise<void> {
    const section = exportSection(this.doc);
    if (section) await removeTemporarySetting(section, original);
  }

  /** What the user had selected before Figloo changes the selection. */
  private async userSelection(tree: LayerTree): Promise<UserSelection> {
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
  private async restoreSelection(tree: LayerTree, source: DomRowSource, before: UserSelection): Promise<boolean> {
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

  private selectedCount(): number | null {
    return parseSelectedCount(this.doc.querySelector("input.focus-target")?.getAttribute("aria-label") ?? null);
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
    learnParents(this.index, params.known ?? []);
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

  protected async run<T>(
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
  private putBackLater(
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
  private async putBack(tree: LayerTree, source: DomRowSource, finish?: (tree: LayerTree, source: DomRowSource) => Promise<void>): Promise<void> {
    try {
      await tree.restore();
      // A read that ran out of time or UI operations still finds the user's layers to select them again.
      if (finish) await tree.whileRestoring(() => finish(tree, source));
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
function layerBox(doc: Document): LayerBox | null {
  const root = inspectionRoot(doc);
  const box = root ? boxOf(readInspection(root)) : null;
  return box && box.width > 0 && box.height > 0 ? box : null;
}

/** The size and the place in its nearest frame that the panel's layout section shows; a line has a zero height. */
function boxOf(sections: InspectedSection[]): LayerBox | null {
  const layout = sections.find((section) => section.kind === "properties");
  const px = (name: string) => {
    const value = layout?.properties.find((p) => p.group === null && p.name === name)?.value;
    const match = value ? /(-?[\d,.]+)px\)?$/.exec(value) : null;
    return match ? Number(match[1]!.replace(/,/g, "")) : Number.NaN;
  };
  const width = px("Width");
  const height = px("Height");
  if (!(width >= 0 && height >= 0)) return null;
  // A missing Top or Left next to a shown one is zero; with neither shown the position is unknown.
  const left = px("Left");
  const top = px("Top");
  const shown = Number.isFinite(left) || Number.isFinite(top);
  return { width, height, position: shown ? { left: Number.isFinite(left) ? left : 0, top: Number.isFinite(top) ? top : 0 } : null };
}

/**
 * The export settings the panel shows for a layer once it has switched to it; in Arc on 2026-10-01
 * they did not change any more after that. A layer without settings keeps the previous layer's
 * button label, so settings count as this layer's only under a button that names it.
 */
function designerExports(doc: Document, name: string): string[] | null {
  const section = exportSection(doc);
  const settings = section ? exportSettings(section) : [];
  return settings.length === 0 || (section !== null && exportsLayer(section, name)) ? settings : null;
}

function layerSize(doc: Document): { width: number; height: number } | null {
  const box = layerBox(doc);
  return box ? { width: box.width, height: box.height } : null;
}

function parseZoom(label: string | null): number | null {
  const match = label ? /^([\d.]+)%$/.exec(label) : null;
  return match ? Number(match[1]) / 100 : null;
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

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
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
