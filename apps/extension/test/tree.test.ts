import { describe, expect, it } from "vitest";
import { LayerTree, StopExploration, type IndexEntry, type Limits } from "../src/adapter/tree.js";
import { FakeLayers, type FakeNode } from "./fake-layers.js";

/** Five cards whose layers share names; only card `selectedCard` has its button selected. */
function cardScreen(selectedCard = 3, options: { buttonExpanded?: boolean } = {}): FakeNode[] {
  const card = (n: number): FakeNode => ({
    id: `c${n}`,
    name: "Card",
    expanded: n === selectedCard,
    children: [
      { id: `c${n}-title`, name: "Title", type: "Text" },
      { id: `c${n}-image`, name: "Image", type: "Image" },
      {
        id: `c${n}-button`,
        name: "Button",
        type: "Instance",
        selected: n === selectedCard,
        expanded: n === selectedCard && options.buttonExpanded === true,
        children: [{ id: `c${n}-label`, name: "Label", type: "Text" }],
      },
    ],
  });
  return [
    { id: "cover", name: "Cover" },
    {
      id: "screen",
      name: "Screen",
      expanded: true,
      children: [
        { id: "header", name: "Header", children: [{ id: "logo", name: "Logo" }, { id: "nav", name: "Nav" }] },
        { id: "list", name: "List", type: "Auto layout", expanded: true, children: [1, 2, 3, 4, 5].map(card) },
      ],
    },
    { id: "footer", name: "Footer" },
  ];
}

function makeTree(source: FakeLayers, index = new Map<string, IndexEntry>(), limits: Partial<Limits> = {}): LayerTree {
  return new LayerTree(source, index, { deadline: Number.POSITIVE_INFINITY, maxUiOps: 1_000, now: () => 0, interrupted: () => false, ...limits });
}

const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

describe("LayerTree anchor and ancestors", () => {
  it("finds the card around the selected button without mixing up cards with the same layer names", async () => {
    const source = new FakeLayers(cardScreen(3));
    const tree = makeTree(source);

    const anchor = await tree.selectionRoot();
    expect(anchor?.id).toBe("c3-button");

    const { chain, reachedTop } = await tree.climb(anchor!);
    expect(ids(chain)).toEqual(["c3", "list", "screen"]);
    expect(reachedTop).toBe(true);

    const children = await tree.childrenPage(chain[0]!, 1, 20);
    expect(ids(children.rows)).toEqual(["c3-title", "c3-image", "c3-button"]);
    expect(children).toMatchObject({ total: 3, hasMore: false, stopReason: "complete" });
  });

  it("returns the selected layer rather than the expanded descendants Figma also marks as selected", async () => {
    const source = new FakeLayers(cardScreen(3, { buttonExpanded: true }));
    const label = source.flat().find((row) => row.id === "c3-label")!;
    source.top = label.rowIndex; // The button row itself is scrolled out of view.
    expect(source.rows()[0]?.id).toBe("c3-label");

    const anchor = await makeTree(source).selectionRoot();
    expect(anchor?.id).toBe("c3-button");
  });

  it("lists ancestors nearest first and pages through them", async () => {
    const source = new FakeLayers(cardScreen(3));
    const index = new Map<string, IndexEntry>();
    const title = source.flat().find((row) => row.id === "c3-title")!;

    const first = await makeTree(source, index).ancestorsPage(title, 1, 2);
    expect(ids(first.rows)).toEqual(["c3", "list"]);
    expect(first).toMatchObject({ total: 3, hasMore: true, nextFrom: 3, stopReason: "limit" });

    const second = await makeTree(source, index).ancestorsPage(title, 3, 2);
    expect(ids(second.rows)).toEqual(["screen"]);
    expect(second).toMatchObject({ hasMore: false, nextFrom: null, stopReason: "complete" });
  });

  it("does not offer a cursor that would only repeat a climb that lost its way", async () => {
    const source = new FakeLayers(cardScreen(3));
    const title = source.flat().find((row) => row.id === "c3-title")!;
    // A row whose level jumps by two has no confirmable parent in a pre-order list.
    const broken = { ...title, level: title.level + 2 };
    const page = await makeTree(source).ancestorsPage(broken, 1, 20);
    expect(page.stopReason).toBe("ui_timeout");
    expect(page.hasMore).toBe(true);
  });

  it("knows which layers sit inside an instance once the ancestors are read", async () => {
    const source = new FakeLayers(cardScreen(3));
    const index = new Map<string, IndexEntry>();
    const tree = makeTree(source, index);
    const anchor = (await tree.selectionRoot())!;
    await tree.climb(anchor);
    expect(index.get("c3-button")?.insideInstance).toBe(false);

    await tree.childrenPage(anchor, 1, 20);
    expect(index.get("c3-label")?.insideInstance).toBe(true);
  });
});

describe("LayerTree siblings and children", () => {
  it("skips the descendants of expanded siblings", async () => {
    const source = new FakeLayers(cardScreen(3));
    const tree = makeTree(source);
    const list = source.flat().find((row) => row.id === "list")!;

    const page = await tree.childrenPage(list, 1, 20);
    expect(ids(page.rows)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
  });

  it("lists layers directly on the page as siblings of a top-level layer", async () => {
    const source = new FakeLayers(cardScreen(3));
    const cover = source.flat()[0]!;
    const page = await makeTree(source).siblingsPage(cover, 1, 20);
    expect(ids(page.rows)).toEqual(["cover", "screen", "footer"]);
    expect(page.total).toBe(3);
  });

  it("expands a collapsed layer to list its children and collapses it again afterwards", async () => {
    const source = new FakeLayers(cardScreen(3));
    const before = source.expandedIds();
    const tree = makeTree(source);
    const c1 = source.flat().find((row) => row.id === "c1")!;
    source.top = c1.rowIndex;

    const page = await tree.childrenPage(c1, 1, 20);
    expect(ids(page.rows)).toEqual(["c1-title", "c1-image", "c1-button"]);
    expect(source.node("c1").expanded).toBe(true);

    await tree.restore();
    expect(source.expandedIds()).toEqual(before);
  });

  it("pages through a long sibling list and resumes after the last returned layer", async () => {
    const many: FakeNode[] = [{ id: "grid", name: "Grid", expanded: true, children: Array.from({ length: 45 }, (_, i) => ({ id: `item${i + 1}`, name: "Item" })) }];
    const source = new FakeLayers(many, 8);
    const index = new Map<string, IndexEntry>();
    const item1 = source.flat()[1]!;

    const first = await makeTree(source, index).siblingsPage(item1, 1, 20);
    expect(first.rows).toHaveLength(20);
    expect(first).toMatchObject({ total: 45, hasMore: true, nextFrom: 21, stopReason: "limit" });

    const revealsBefore = source.reveals;
    const second = await makeTree(source, index).siblingsPage(item1, 21, 20, first.rows.at(-1)!.id);
    expect(second.rows[0]?.id).toBe("item21");
    expect(second.rows).toHaveLength(20);
    // Resuming reads only the next rows; rescanning from the top would need several more reveals.
    expect(source.reveals - revealsBefore).toBeLessThanOrEqual(5);

    const third = await makeTree(source, index).siblingsPage(item1, 41, 20, second.rows.at(-1)!.id);
    expect(ids(third.rows)).toEqual(["item41", "item42", "item43", "item44", "item45"]);
    expect(third).toMatchObject({ hasMore: false, nextFrom: null, stopReason: "complete" });
  });

  it("stops at the scan budget and does not claim the list is complete", async () => {
    const many: FakeNode[] = [{ id: "grid", name: "Grid", expanded: true, children: Array.from({ length: 45 }, (_, i) => ({ id: `item${i + 1}`, name: "Item" })) }];
    const source = new FakeLayers(many, 8);
    const grid = source.flat()[0]!;

    const page = await makeTree(source, new Map(), { maxUiOps: 1 }).childrenPage(grid, 1, 50);
    expect(page.stopReason).toBe("scan_budget");
    expect(page.hasMore).toBe(true);
    expect(page.nextFrom).toBe((page.rows.at(-1)?.position ?? 0) + 1);
    expect(page.rows.length).toBeLessThan(45);
  });

  it("stops at the time budget with a resumable page", async () => {
    const many: FakeNode[] = [{ id: "grid", name: "Grid", expanded: true, children: Array.from({ length: 45 }, (_, i) => ({ id: `item${i + 1}`, name: "Item" })) }];
    const source = new FakeLayers(many, 8);
    let clock = 0;
    source.onOperation = () => {
      clock += 10_000;
    };
    const page = await makeTree(source, new Map(), { deadline: 15_000, now: () => clock }).childrenPage(source.flat()[0]!, 1, 50);
    expect(page).toMatchObject({ stopReason: "time_budget", hasMore: true });
  });
});

describe("LayerTree robustness", () => {
  it("stops as soon as the user interacts, without finishing the page", async () => {
    const source = new FakeLayers(cardScreen(3));
    let userActed = false;
    source.onOperation = () => {
      userActed = true;
    };
    const c1 = source.flat().find((row) => row.id === "c1")!;
    source.top = c1.rowIndex;
    const tree = makeTree(source, new Map(), { interrupted: () => userActed });

    await expect(tree.childrenPage(c1, 1, 20)).rejects.toMatchObject({ cause: "user_interrupted" });
    await expect(tree.childrenPage(c1, 1, 20)).rejects.toBeInstanceOf(StopExploration);
  });

  it("finds a layer again after the user expanded rows above it", async () => {
    const source = new FakeLayers(cardScreen(3));
    const index = new Map<string, IndexEntry>();
    const tree = makeTree(source, index);
    const anchor = (await tree.selectionRoot())!;
    await tree.climb(anchor);
    const oldIndex = anchor.rowIndex;

    source.node("header").expanded = true; // Two more rows appear above the anchor.
    source.top = 1;

    const found = await makeTree(source, index).find("c3-button");
    expect(found?.id).toBe("c3-button");
    expect(found?.rowIndex).toBe(oldIndex + 2);
  });
});

describe("LayerTree subtree", () => {
  it("lists children breadth first down to the requested depth and collapses what it opened", async () => {
    const source = new FakeLayers(cardScreen(3));
    const before = source.expandedIds();
    const tree = makeTree(source);
    const list = source.flat().find((row) => row.id === "list")!;

    const page = await tree.subtreePage(list, 2, 50);
    expect(ids(page.rows)).toEqual([
      "c1", "c2", "c3", "c4", "c5",
      "c1-title", "c1-image", "c1-button",
      "c2-title", "c2-image", "c2-button",
      "c3-title", "c3-image", "c3-button",
      "c4-title", "c4-image", "c4-button",
      "c5-title", "c5-image", "c5-button",
    ]);
    expect(page).toMatchObject({ hasMore: false, stopReason: "complete", total: 20 });

    await tree.restore();
    expect(source.expandedIds()).toEqual(before);
  });

  it("reports a cut-off tree when the layer limit runs out before a layer's children are listed", async () => {
    const source = new FakeLayers(cardScreen(3));
    const list = source.flat().find((row) => row.id === "list")!;

    const page = await makeTree(source).subtreePage(list, 2, 8);
    expect(page.rows).toHaveLength(8);
    expect(page).toMatchObject({ hasMore: true, nextFrom: null, stopReason: "limit", total: null });
  });

  it("does not call a tree cut off when only the depth limit stops it", async () => {
    const source = new FakeLayers(cardScreen(3));
    const list = source.flat().find((row) => row.id === "list")!;

    const page = await makeTree(source).subtreePage(list, 1, 50);
    expect(ids(page.rows)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    expect(page).toMatchObject({ hasMore: false, stopReason: "complete" });
  });
});
