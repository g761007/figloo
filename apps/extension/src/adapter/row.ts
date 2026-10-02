/** One row of the Figma layers panel, as far as its DOM attributes reveal it. */
export interface Row {
  id: string;
  name: string;
  /** Label of the layer type icon, for example "Frame" or "Instance". */
  type: string | null;
  /** aria-level: 0 for layers directly on the page. */
  level: number;
  /** aria-posinset and aria-setsize: 1-based position among siblings, and the sibling count. */
  position: number;
  setSize: number;
  /** aria-rowindex: 1-based position in the flat list of currently expanded rows. */
  rowIndex: number;
  hasChildren: boolean;
  expanded: boolean;
  /** Figma also marks the rendered descendants of a selected layer as selected. */
  selected: boolean;
  /**
   * Figma greys out a hidden layer and every layer inside it (seen in Arc on 2026-10-01); rows of
   * instances and of layers inside them turn a dimmer purple instead (seen in Arc on 2026-10-02).
   */
  hidden: boolean;
}

const ROW_ID_SUFFIX = "-layers-panel-row";
/** The text colors of hidden rows: grey, or for components and instances the dimmest purple. */
const HIDDEN_TEXT = /--color-text-(?:disabled|component-tertiary)(?![\w-])/;

export function layersPanel(root: ParentNode): Element | null {
  return root.querySelector('[data-testid="objects-panel"]');
}

export function parseRow(el: Element): Row | null {
  const idHolder = el.querySelector(`[data-testid$="${ROW_ID_SUFFIX}"]`);
  const testId = idHolder?.getAttribute("data-testid");
  if (!testId) return null;
  const numbers = ["aria-level", "aria-posinset", "aria-setsize", "aria-rowindex"].map((name) => Number(el.getAttribute(name)));
  if (numbers.some((n) => !Number.isInteger(n))) return null;
  const [level, position, setSize, rowIndex] = numbers;
  const expanded = el.getAttribute("aria-expanded");
  return {
    id: testId.slice(0, -ROW_ID_SUFFIX.length),
    name: el.querySelector('[role="gridcell"]:not([aria-hidden="true"])')?.textContent?.trim() ?? "",
    type: el.querySelector('[role="img"][aria-label]')?.getAttribute("aria-label") ?? null,
    level,
    position,
    setSize,
    rowIndex,
    hasChildren: expanded !== null,
    expanded: expanded === "true",
    selected: el.getAttribute("aria-selected") === "true",
    hidden: HIDDEN_TEXT.test(el.getAttribute("style") ?? ""),
  };
}

/** Rows currently rendered in the virtualized layers panel, in list order. */
export function readRenderedRows(root: ParentNode): Row[] {
  const panel = layersPanel(root);
  if (!panel) return [];
  const rows: Row[] = [];
  for (const el of panel.querySelectorAll('[role="row"][aria-rowindex]')) {
    const row = parseRow(el);
    if (row) rows.push(row);
  }
  return rows.sort((a, b) => a.rowIndex - b.rowIndex);
}

export function rowElement(root: ParentNode, id: string): Element | null {
  return root.querySelector(`[data-testid="${id}${ROW_ID_SUFFIX}"]`)?.closest('[role="row"]') ?? null;
}
