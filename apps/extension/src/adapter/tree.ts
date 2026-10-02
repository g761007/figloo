import type { StopReason } from "@figloo/protocol";
import type { Row } from "./row.js";

export type Align = "start" | "center" | "end";

/** The virtualized layers panel: only rendered rows can be read. */
export interface RowSource {
  /** Rendered rows in ascending rowIndex order. */
  rows(): Row[];
  /** Length of the flat list of expanded rows. */
  rowCount(): number;
  /** Scrolls so `rowIndex` is rendered, placed per `align`, and returns the rendered rows. */
  reveal(rowIndex: number, align: Align): Promise<Row[]>;
  /** Clicks the expand caret of a rendered row and returns the rendered rows. */
  toggle(row: Row): Promise<Row[]>;
}

export type StopCause = "time_budget" | "scan_budget" | "ui_timeout" | "user_interrupted";

/** Thrown when an exploration has to stop before it finishes. */
export class StopExploration extends Error {
  constructor(readonly cause: StopCause) {
    super(`exploration stopped: ${cause}`);
    this.name = "StopExploration";
  }
}

export interface Limits {
  deadline: number;
  maxUiOps: number;
  now: () => number;
  interrupted: () => boolean;
}

/** What earlier reads taught about a layer; kept for the lifetime of the page. */
export interface IndexEntry {
  rowIndex: number;
  /** null for layers directly on the page, undefined when not known yet. */
  parentRef?: string | null;
  insideInstance?: boolean | null;
  childCount?: number;
}

/**
 * Records parents the server knows from a saved snapshot, for layers this page load has not met yet,
 * such as after a reload: `find` then opens the way to them through their parents. Entries the tab
 * read itself keep what it read.
 */
export function learnParents(index: Map<string, IndexEntry>, known: ReadonlyArray<{ ref: string; parentRef: string | null }>): void {
  for (const { ref, parentRef } of known) {
    const entry = index.get(ref);
    if (!entry || entry.parentRef === undefined) index.set(ref, { ...entry, rowIndex: entry?.rowIndex ?? 0, parentRef });
  }
}

export interface Page {
  rows: Row[];
  total: number | null;
  from: number;
  nextFrom: number | null;
  hasMore: boolean;
  stopReason: StopReason;
}

interface Parent {
  id: string | null;
  rowIndex: number;
  level: number;
  type: string | null;
}

/** A layer met by walkSubtree, with its parent and its depth below the root. */
export interface WalkedLayer {
  row: Row;
  parentRef: string | null;
  depth: number;
}

/** Refs of walked layers that are hidden or inside a hidden layer; `layers` lists parents before their children. */
export function hiddenLayers(layers: WalkedLayer[]): Set<string> {
  const hidden = new Set<string>();
  for (const { row, parentRef } of layers) if (row.hidden || (parentRef !== null && hidden.has(parentRef))) hidden.add(row.id);
  return hidden;
}

export interface Walk {
  /** The root first, then every layer below it in layers panel order; instances count as one layer. */
  layers: WalkedLayer[];
  /** False when the subtree has more than the allowed number of layers. */
  complete: boolean;
}

/** The page itself, parent of the layers at level 0. */
const PAGE_ROOT: Parent = { id: null, rowIndex: 0, level: -1, type: null };

/**
 * Local navigation over the layers panel. It only reads rows between a known layer and the
 * relation asked for, spends a bounded number of UI operations, and records every layer it
 * expands so the panel can be put back the way the user left it.
 */
export class LayerTree {
  uiOps = 0;
  private snapshot: Row[];
  private readonly expandedByUs: string[] = [];
  private restoring = false;

  constructor(
    private readonly source: RowSource,
    private readonly index: Map<string, IndexEntry>,
    private readonly limits: Limits,
  ) {
    this.snapshot = source.rows();
  }

  /** Stops on user input or an exhausted budget; while restoring only user input stops it. */
  check(): void {
    if (this.limits.interrupted()) throw new StopExploration("user_interrupted");
    if (this.restoring) return;
    if (this.limits.now() >= this.limits.deadline) throw new StopExploration("time_budget");
  }

  private spend(): void {
    this.check();
    if (!this.restoring && this.uiOps >= this.limits.maxUiOps) throw new StopExploration("scan_budget");
    this.uiOps += 1;
  }

  private remember(row: Row, update: Omit<IndexEntry, "rowIndex"> = {}): void {
    this.index.set(row.id, { ...this.index.get(row.id), ...update, rowIndex: row.rowIndex });
  }

  rendered(id: string): Row | undefined {
    return this.snapshot.find((row) => row.id === id);
  }

  /** The row at `rowIndex`, or null past the end of the list. */
  async rowAt(rowIndex: number, align: Align = "center"): Promise<Row | null> {
    this.check();
    if (rowIndex < 1) return null;
    let row = this.snapshot.find((r) => r.rowIndex === rowIndex);
    if (row) return row;
    if (rowIndex > this.source.rowCount()) return null;
    this.spend();
    this.snapshot = await this.source.reveal(rowIndex, align);
    row = this.snapshot.find((r) => r.rowIndex === rowIndex);
    if (!row) throw new StopExploration("ui_timeout");
    return row;
  }

  async parentOf(row: Row): Promise<Row | null> {
    if (row.level === 0) return null;
    for (let i = row.rowIndex - 1; i >= 1; i -= 1) {
      const candidate = await this.rowAt(i, "end");
      if (!candidate) return null;
      if (candidate.level < row.level) {
        // In a pre-order list the first shallower row above is the parent.
        if (candidate.level !== row.level - 1) return null;
        this.remember(row, { parentRef: candidate.id });
        this.remember(candidate);
        return candidate;
      }
    }
    return null;
  }

  /**
   * Walks up to `maxSteps` parents. When it reaches the page it also settles, top down, which of
   * the visited layers sit inside an instance.
   */
  async climb(row: Row, maxSteps = Number.POSITIVE_INFINITY): Promise<{ chain: Row[]; reachedTop: boolean }> {
    const chain: Row[] = [];
    let current = row;
    while (current.level > 0 && chain.length < maxSteps) {
      const parent = await this.parentOf(current);
      if (!parent) break;
      chain.push(parent);
      current = parent;
    }
    const reachedTop = current.level === 0;
    if (reachedTop) {
      if (row.level === 0) this.remember(row, { parentRef: null });
      let inside = false;
      for (const node of [...chain].reverse()) {
        this.remember(node, { insideInstance: inside, ...(node.level === 0 ? { parentRef: null } : {}) });
        inside = inside || node.type === "Instance";
      }
      this.remember(row, { insideInstance: inside });
    }
    return { chain, reachedTop };
  }

  /** The top-most selected row: the layer the user selected, not a descendant Figma also marks. */
  async selectionRoot(): Promise<Row | null> {
    let selected = this.snapshot.find((row) => row.selected) ?? null;
    for (let i = 1; !selected; i += 1) {
      const row = await this.rowAt(i, "start");
      if (!row) return null;
      if (row.selected) selected = row;
    }
    for (;;) {
      const parent = await this.parentOf(selected);
      if (!parent?.selected) return selected;
      selected = parent;
    }
  }

  /**
   * The selected layers in layers panel order, top-most rows only. A parent comes before its
   * children, so a selected row inside a selected row's subtree is one of the descendants Figma
   * also marks. Reads the list from the top and stops once `wanted` layers are found.
   */
  async selectionRoots(wanted: number): Promise<Row[]> {
    const roots: Row[] = [];
    let insideLevel: number | null = null;
    for (let i = 1; roots.length < wanted; i += 1) {
      const row = await this.rowAt(i, "start");
      if (!row) break;
      if (insideLevel !== null && row.level > insideLevel) continue;
      insideLevel = null;
      if (row.selected) {
        roots.push(row);
        insideLevel = row.level;
      }
    }
    return roots;
  }

  async expand(row: Row): Promise<Row> {
    // The caret can only be clicked while its row is rendered; earlier reads may have scrolled away.
    const shown = this.rendered(row.id) ?? (await this.find(row.id));
    if (!shown) throw new StopExploration("ui_timeout");
    if (shown.expanded) return shown;
    this.spend();
    this.snapshot = await this.source.toggle(shown);
    const updated = this.rendered(row.id);
    if (!updated?.expanded) throw new StopExploration("ui_timeout");
    this.expandedByUs.push(row.id);
    return updated;
  }

  /** Finds a layer read earlier in this page, following its recorded parent when rows moved. */
  async find(id: string, depth = 0): Promise<Row | null> {
    const shown = this.rendered(id);
    if (shown) return shown;
    const entry = this.index.get(id);
    if (!entry) return null;
    const atHint = await this.rowAt(entry.rowIndex).catch((error: unknown) => {
      if (error instanceof StopExploration && error.cause === "ui_timeout") return null;
      throw error;
    });
    if (atHint?.id === id) return atHint;
    const nearby = this.rendered(id);
    if (nearby) return nearby;
    if (entry.parentRef === undefined || depth > 64) return null;
    const parent = entry.parentRef === null ? PAGE_ROOT : await this.find(entry.parentRef, depth + 1);
    if (!parent) return null;
    let found: Row | null = null;
    await this.walkChildren(await this.opened(parent), this.firstChildIndex(parent), (child) => {
      if (child.id !== id) return true;
      found = child;
      return false;
    });
    // The next find starts at its row instead of opening the way down again.
    if (found) this.remember(found, { parentRef: parent.id });
    return found;
  }

  async parentPage(row: Row): Promise<Page> {
    const parent = await this.parentOf(row);
    if (row.level > 0 && !parent) throw new StopExploration("ui_timeout");
    return { rows: parent ? [parent] : [], total: parent ? 1 : 0, from: 1, nextFrom: null, hasMore: false, stopReason: "complete" };
  }

  async ancestorsPage(row: Row, from: number, limit: number): Promise<Page> {
    const total = row.level;
    let chain: Row[] = [];
    try {
      ({ chain } = await this.climb(row, from - 1 + limit));
    } catch (error) {
      return this.partial(error, [], total, from);
    }
    const rows = chain.slice(from - 1);
    const last = from - 1 + rows.length;
    const hasMore = last < total;
    // A climb that ends before its step count and before the page means a parent could not be found.
    const broken = chain.length < Math.min(total, from - 1 + limit);
    return { rows, total, from, nextFrom: hasMore ? last + 1 : null, hasMore, stopReason: broken ? "ui_timeout" : hasMore ? "limit" : "complete" };
  }

  async siblingsPage(row: Row, from: number, limit: number, after?: string): Promise<Page> {
    const parent = row.level === 0 ? PAGE_ROOT : await this.parentOf(row);
    if (!parent) throw new StopExploration("ui_timeout");
    return this.childrenPage(parent, from, limit, after);
  }

  /** Layers directly on the page, in layers panel order. */
  async topLevelPage(from: number, limit: number, after?: string): Promise<Page> {
    return this.childrenPage(PAGE_ROOT, from, limit, after);
  }

  /**
   * Children down to `depth` levels, breadth first, within `limit` layers in total. A cut-off tree
   * cannot be resumed from a single position, so it reports hasMore without a next position.
   */
  async subtreePage(root: Row, depth: number, limit: number): Promise<Page> {
    const rows: Row[] = [];
    const cut = (stopReason: StopReason): Page => ({ rows, total: null, from: 1, nextFrom: null, hasMore: true, stopReason });
    let frontier: Row[] = [root];
    for (let level = 1; level <= depth; level += 1) {
      const next: Row[] = [];
      for (const parent of frontier) {
        if (!parent.hasChildren) continue;
        // A layer whose children would go unlisted means the tree is cut short.
        if (rows.length >= limit) return cut("limit");
        const page = await this.childrenPage(parent, 1, limit - rows.length);
        rows.push(...page.rows);
        next.push(...page.rows);
        if (page.stopReason !== "complete" && page.stopReason !== "limit") return cut(page.stopReason);
        if (page.hasMore) return cut("limit");
      }
      frontier = next;
    }
    return { rows, total: rows.length, from: 1, nextFrom: null, hasMore: false, stopReason: "complete" };
  }

  /**
   * Reads the whole subtree of a layer outside instances in one pass down the list: each collapsed
   * layer is expanded where the walk meets it, so its children follow right below and no row is
   * read twice. Instances count as one layer and stay as they are; the rows of an instance the user
   * expanded are skipped. Stops once the subtree turns out to hold more than `maxLayers` layers.
   * `onLayer` hears how many layers were found so far.
   */
  async walkSubtree(root: Row, maxLayers: number, onLayer?: (found: number) => void): Promise<Walk> {
    const layers: WalkedLayer[] = [{ row: root, parentRef: null, depth: 0 }];
    this.remember(root, { insideInstance: false });
    if (!root.hasChildren || root.type === "Instance") return { layers, complete: true };
    const opened = await this.opened(root);
    layers[0]!.row = opened;
    // Open layers from the root down to the current row; in a pre-order list the parent is the last one above its level.
    const open: Row[] = [opened];
    let skipBelow: number | null = null;
    for (let i = opened.rowIndex + 1; ; i += 1) {
      const row = await this.rowAt(i, "start");
      if (!row || row.level <= root.level) return { layers, complete: true };
      if (skipBelow !== null && row.level > skipBelow) continue;
      skipBelow = null;
      while (open.at(-1)!.level >= row.level) open.pop();
      if (layers.length >= maxLayers) return { layers, complete: false };
      const parent = open.at(-1)!;
      layers.push({ row, parentRef: parent.id, depth: row.level - root.level });
      onLayer?.(layers.length);
      this.remember(row, { parentRef: parent.id, insideInstance: false });
      this.remember(parent, { childCount: row.setSize });
      if (!row.hasChildren) continue;
      if (row.type === "Instance") {
        if (row.expanded) skipBelow = row.level;
        continue;
      }
      open.push(await this.opened(row));
    }
  }

  async childrenPage(parentRow: Parent | Row, from: number, limit: number, after?: string): Promise<Page> {
    if ("hasChildren" in parentRow && !parentRow.hasChildren) {
      return { rows: [], total: 0, from, nextFrom: null, hasMore: false, stopReason: "complete" };
    }
    // A row read earlier may have moved since; rows below an expanded layer shift down.
    if ("setSize" in parentRow) parentRow = this.rendered(parentRow.id) ?? (await this.find(parentRow.id)) ?? parentRow;
    const rows: Row[] = [];
    let total: number | null = null;
    let ended = false;
    try {
      const parent = await this.opened(parentRow);
      const parentEntry = parent.id ? this.index.get(parent.id) : undefined;
      const inside = parent.id === null ? false : parentEntry?.insideInstance == null ? null : parentEntry.insideInstance || parent.type === "Instance";
      let start = this.firstChildIndex(parent);
      const hint = after ? this.index.get(after) : undefined;
      if (after && hint) {
        const resumed = await this.rowAt(hint.rowIndex, "start");
        if (resumed?.id === after && resumed.level === parent.level + 1) {
          start = resumed.rowIndex + 1;
          total = resumed.setSize;
        }
      }
      ended =
        (await this.walkChildren(parent, start, (child) => {
          total = child.setSize;
          this.remember(child, { parentRef: parent.id, ...(inside === null ? {} : { insideInstance: inside }) });
          if (child.position < from) return true;
          rows.push(child);
          return rows.length < limit;
        })) === "end";
      if ("setSize" in parent && total !== null) this.remember(parent, { childCount: total });
    } catch (error) {
      return this.partial(error, rows, total, from);
    }
    const lastPosition = rows.at(-1)?.position ?? from - 1;
    const hasMore = !ended && total !== null && lastPosition < total;
    return { rows, total: total ?? (ended ? 0 : null), from, nextFrom: hasMore ? lastPosition + 1 : null, hasMore, stopReason: hasMore ? "limit" : "complete" };
  }

  /** Collapses what this exploration expanded, deepest first. Only user input stops it. */
  async restore(): Promise<void> {
    await this.whileRestoring(async () => {
      for (const id of this.expandedByUs.splice(0).reverse()) {
        const row = await this.find(id);
        if (row?.expanded) {
          this.spend();
          this.snapshot = await this.source.toggle(row);
        }
      }
    });
  }

  /** Runs put-back work, such as selecting the user's layers again, as restore runs: only user input stops it. */
  async whileRestoring<T>(work: () => Promise<T>): Promise<T> {
    const was = this.restoring;
    this.restoring = true;
    try {
      return await work();
    } finally {
      this.restoring = was;
    }
  }

  private firstChildIndex(parent: Parent): number {
    return parent.rowIndex + 1;
  }

  private async opened<T extends Parent | Row>(parent: T): Promise<T | Row> {
    if (!("expanded" in parent) || parent.expanded || !parent.hasChildren) return parent;
    return this.expand(parent);
  }

  /** Visits the direct children of `parent` from `start` on; stops early when `visit` returns false. */
  private async walkChildren(parent: Parent, start: number, visit: (child: Row) => boolean): Promise<"end" | "stopped"> {
    const childLevel = parent.level + 1;
    for (let i = start; ; i += 1) {
      const row = await this.rowAt(i, "start");
      if (!row || row.level <= parent.level) return "end";
      if (row.level === childLevel && !visit(row)) return "stopped";
    }
  }

  /** A page cut short by a budget. Nothing is known about what follows, so hasMore stays true. */
  private partial(error: unknown, rows: Row[], total: number | null, from: number): Page {
    if (!(error instanceof StopExploration) || error.cause === "user_interrupted") throw error;
    const lastPosition = rows.at(-1)?.position ?? from - 1;
    return { rows, total, from, nextFrom: lastPosition + 1, hasMore: true, stopReason: error.cause };
  }
}
