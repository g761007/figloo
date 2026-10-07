import type { Row } from "../src/adapter/row.js";
import type { Align, RowSource } from "../src/adapter/tree.js";

export interface FakeNode {
  id: string;
  name: string;
  type?: string;
  expanded?: boolean;
  selected?: boolean;
  hidden?: boolean;
  /** A "Fixed" or "Scrolls" section header row among its siblings, not a layer. */
  header?: boolean;
  children?: FakeNode[];
}

/** An in-memory layers panel that renders only a window of rows, like Figma's virtualized list. */
export class FakeLayers implements RowSource {
  top = 1;
  reveals = 0;
  toggles = 0;
  /** Called on every UI operation, for example to simulate the user stepping in. */
  onOperation?: () => void;

  constructor(
    readonly roots: FakeNode[],
    readonly windowSize = 6,
  ) {}

  flat(): Row[] {
    const out: Row[] = [];
    const visit = (nodes: FakeNode[], level: number, insideSelected: boolean, insideHidden: boolean) => {
      // Like Figma, sibling positions and counts leave the section headers out.
      const layers = nodes.filter((node) => !node.header);
      for (const node of nodes) {
        if (node.header) {
          out.push({ id: "", name: node.name, type: null, level, position: 0, setSize: 0, rowIndex: out.length + 1, hasChildren: false, expanded: false, selected: false, hidden: false, header: true });
          continue;
        }
        const hasChildren = node.children?.some((child) => !child.header) ?? false;
        const expanded = hasChildren && node.expanded === true;
        const selected = insideSelected || node.selected === true;
        const hidden = insideHidden || node.hidden === true;
        out.push({ id: node.id, name: node.name, type: node.type ?? "Frame", level, position: layers.indexOf(node) + 1, setSize: layers.length, rowIndex: out.length + 1, hasChildren, expanded, selected, hidden });
        if (expanded) visit(node.children!, level + 1, selected, hidden);
      }
    };
    visit(this.roots, 0, false, false);
    return out;
  }

  rows(): Row[] {
    return this.flat().filter((row) => row.rowIndex >= this.top && row.rowIndex < this.top + this.windowSize);
  }

  rowCount(): number {
    return this.flat().length;
  }

  async reveal(rowIndex: number, align: Align): Promise<Row[]> {
    this.reveals += 1;
    this.onOperation?.();
    const desired = align === "start" ? rowIndex : align === "end" ? rowIndex - this.windowSize + 1 : rowIndex - Math.floor(this.windowSize / 2);
    this.top = Math.max(1, Math.min(desired, this.rowCount() - this.windowSize + 1));
    return this.rows();
  }

  async toggle(row: Row): Promise<Row[]> {
    this.toggles += 1;
    this.onOperation?.();
    if (!this.rows().some((r) => r.id === row.id)) throw new Error(`clicked the caret of a row that is not rendered: ${row.id}`);
    const node = this.node(row.id);
    node.expanded = !node.expanded;
    return this.rows();
  }

  node(id: string): FakeNode {
    const stack = [...this.roots];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.id === id) return node;
      stack.push(...(node.children ?? []));
    }
    throw new Error(`no node ${id}`);
  }

  expandedIds(): string[] {
    const out: string[] = [];
    const stack = [...this.roots];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.expanded) out.push(node.id);
      stack.push(...(node.children ?? []));
    }
    return out.sort();
  }
}
