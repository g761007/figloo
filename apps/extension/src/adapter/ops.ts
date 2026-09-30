import type { AnchorResult, ErrorCode, LayerNode, ListNeighborsParams, NeighborsResult, PageIdentity } from "@figloo/protocol";
import { parseFigmaUrl } from "../figma-url.js";
import { parseSelectedCount } from "../probe.js";
import { DomRowSource, TabInBackground } from "./dom-source.js";
import { layersPanel, type Row } from "./row.js";
import { LayerTree, StopExploration, type IndexEntry, type Page } from "./tree.js";

/** Per-operation budgets from the plan: 15 s of UI work and a bounded number of UI operations. */
export const OP_TIME_BUDGET_MS = 15_000;
export const OP_MAX_UI_OPS = 300;
const MAX_NAME_LENGTH = 200;
const INDEX_LIMIT = 5_000;

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

  async listNeighbors(params: ListNeighborsParams): Promise<NeighborsResult> {
    const identity = this.identity();
    if (params.expect.pageId !== identity.pageId || params.expect.fileKey !== identity.fileKey) {
      throw new OpError("CONTEXT_EXPIRED", "the Figma tab was reloaded or switched files after the context was created");
    }
    if (params.expect.page !== null && identity.page !== null && params.expect.page !== identity.page) {
      throw new OpError("PAGE_CHANGED", `the Figma page changed from "${params.expect.page}" to "${identity.page}"`);
    }
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
          return tree.childrenPage(row, params.from, params.limit, params.after);
      }
    });
    return {
      identity,
      nodes: value.rows.map((row) => this.toNode(row)),
      total: value.total,
      from: value.from,
      nextFrom: value.nextFrom,
      hasMore: value.hasMore,
      stopReason: value.stopReason,
      uiOps,
      elapsedMs,
    };
  }

  private async run<T>(work: (tree: LayerTree) => Promise<T>): Promise<{ value: T; uiOps: number; elapsedMs: number }> {
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
        value = await work(tree);
        // Rows read after the user stepped in may already describe a different state.
        if (user.interrupted()) throw new StopExploration("user_interrupted");
      } catch (error) {
        if (!user.interrupted()) await this.putBack(tree, source);
        throw translate(error);
      }
      await this.putBack(tree, source);
      return { value, uiOps: tree.uiOps, elapsedMs: Date.now() - started };
    } finally {
      user.dispose();
      this.running = false;
      if (this.index.size > INDEX_LIMIT) this.index.clear();
    }
  }

  /** Best effort: once the user takes over, the panel is left as it is. */
  private async putBack(tree: LayerTree, source: DomRowSource): Promise<void> {
    try {
      await tree.restore();
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

function translate(error: unknown): unknown {
  if (error instanceof TabInBackground) {
    return new OpError("TAB_IN_BACKGROUND", "the Figma tab is in the background, where Figma does not expand layers");
  }
  if (!(error instanceof StopExploration)) return error;
  if (error.cause === "user_interrupted") return new OpError("USER_INTERRUPTED", "the user interacted with Figma during the operation");
  if (error.cause === "ui_timeout") return new OpError("UI_NOT_READY", "the layers panel did not respond in time");
  return new OpError("BUDGET_EXCEEDED", `stopped by the ${error.cause.replace("_", " ")}`);
}
