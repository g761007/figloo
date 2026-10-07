import { describe, expect, it } from "vitest";
import { LayerTree, StopExploration, hiddenLayers, learnParents, type IndexEntry, type Limits } from "../src/adapter/tree.js";
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

/** The card screen with whole cards selected; the first selected card is expanded, so its rows are marked too. */
function selectedCards(numbers: number[]): FakeNode[] {
  const nodes = cardScreen(0);
  const list = nodes[1]!.children![1]!;
  for (const card of list.children!) {
    const n = Number(card.id.slice(1));
    card.selected = numbers.includes(n);
    card.expanded = n === numbers[0];
  }
  return nodes;
}

describe("LayerTree selection of several layers", () => {
  it("finds every selected card in panel order and skips the rows Figma marks inside them", async () => {
    const source = new FakeLayers(selectedCards([2, 4]));
    const roots = await makeTree(source).selectionRoots(2);
    expect(ids(roots)).toEqual(["c2", "c4"]);
  });

  it("reads past the rendered rows to reach selected layers further down", async () => {
    const source = new FakeLayers(selectedCards([1, 5]));
    expect(source.rows().some((row) => row.id === "c5")).toBe(false);
    const roots = await makeTree(source).selectionRoots(2);
    expect(ids(roots)).toEqual(["c1", "c5"]);
  });

  it("returns the layers it found when the list ends before all of them", async () => {
    const source = new FakeLayers(selectedCards([3]));
    const roots = await makeTree(source).selectionRoots(3);
    expect(ids(roots)).toEqual(["c3"]);
  });
});

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

  it("finds the user's layer to put it back after both budgets ran out, but still stops for the user", async () => {
    const source = new FakeLayers(cardScreen(3));
    const index = new Map<string, IndexEntry>();
    const reader = makeTree(source, index);
    await reader.climb((await reader.selectionRoot())!);
    source.top = 1; // The selected button is scrolled out of view, so finding it takes a reveal.

    const spent = makeTree(source, index, { deadline: 0, maxUiOps: 0 });
    await expect(spent.find("c3-button")).rejects.toMatchObject({ cause: "time_budget" });
    expect((await spent.whileRestoring(() => spent.find("c3-button")))?.id).toBe("c3-button");
    // Outside the put-back the budgets apply again.
    expect(() => spent.check()).toThrow(StopExploration);

    source.top = 1;
    const interrupted = makeTree(source, index, { deadline: 0, maxUiOps: 0, interrupted: () => true });
    await expect(interrupted.whileRestoring(() => interrupted.find("c3-button"))).rejects.toMatchObject({ cause: "user_interrupted" });
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

describe("LayerTree whole subtree walk", () => {
  const cardIds = (n: number) => [`c${n}`, `c${n}-title`, `c${n}-image`, `c${n}-button`];

  it("reads every layer below the root once in panel order, expanding each collapsed layer where it meets it", async () => {
    const source = new FakeLayers(cardScreen(3));
    const before = source.expandedIds();
    const index = new Map<string, IndexEntry>();
    const tree = makeTree(source, index);
    const list = source.flat().find((row) => row.id === "list")!;

    const walk = await tree.walkSubtree(list, 400);
    expect(walk.complete).toBe(true);
    expect(walk.layers.map((layer) => layer.row.id)).toEqual(["list", ...[1, 2, 3, 4, 5].flatMap(cardIds)]);
    // Cards 1, 2, 4, and 5 were collapsed; card 3 was already open and the buttons are instances.
    expect(source.toggles).toBe(4);
    expect(walk.layers.find((layer) => layer.row.id === "c4-title")).toMatchObject({ parentRef: "c4", depth: 2 });
    expect(walk.layers.find((layer) => layer.row.id === "c2")).toMatchObject({ parentRef: "list", depth: 1 });
    expect(walk.layers[0]).toMatchObject({ parentRef: null, depth: 0 });
    expect(index.get("c5-button")).toMatchObject({ parentRef: "c5", insideInstance: false });

    await tree.restore();
    expect(source.expandedIds()).toEqual(before);
  });

  it("keeps instances closed and skips the layers of an instance the user opened", async () => {
    const source = new FakeLayers(cardScreen(3, { buttonExpanded: true }));
    const card = source.flat().find((row) => row.id === "c3")!;

    const walk = await makeTree(source).walkSubtree(card, 400);
    expect(walk.layers.map((layer) => layer.row.id)).toEqual(cardIds(3));
    expect(walk.layers.at(-1)!.row).toMatchObject({ type: "Instance", hasChildren: true });
    expect(source.node("c1-button").expanded).toBeFalsy();
  });

  it("opens a collapsed root and closes it again on restore", async () => {
    const source = new FakeLayers(cardScreen(3));
    const tree = makeTree(source);
    const card = source.flat().find((row) => row.id === "c1")!;

    const walk = await tree.walkSubtree(card, 400);
    expect(walk.layers.map((layer) => layer.row.id)).toEqual(cardIds(1));
    expect(source.node("c1").expanded).toBe(true);

    await tree.restore();
    expect(source.node("c1").expanded).toBe(false);
  });

  it("stops as soon as the subtree holds more layers than allowed, and allows exactly the limit", async () => {
    const source = new FakeLayers(cardScreen(3));
    const list = source.flat().find((row) => row.id === "list")!;

    const cut = await makeTree(source).walkSubtree(list, 10);
    expect(cut.complete).toBe(false);
    expect(cut.layers).toHaveLength(10);

    const exact = await makeTree(new FakeLayers(cardScreen(3))).walkSubtree(list, 21);
    expect(exact.complete).toBe(true);
    expect(exact.layers).toHaveLength(21);
  });

  it("reads a root without layers of its own, or an instance root, as one layer", async () => {
    const source = new FakeLayers(cardScreen(3));
    const tree = makeTree(source);
    const footer = source.flat().find((row) => row.id === "footer")!;
    expect((await tree.walkSubtree(footer, 400)).layers.map((layer) => layer.row.id)).toEqual(["footer"]);

    const button = source.flat().find((row) => row.id === "c3-button")!;
    expect((await tree.walkSubtree(button, 400)).layers.map((layer) => layer.row.id)).toEqual(["c3-button"]);
    expect(source.toggles).toBe(0);
  });

  it("stops when the user steps in during the walk", async () => {
    const source = new FakeLayers(cardScreen(3));
    let operations = 0;
    source.onOperation = () => {
      operations += 1;
    };
    const list = source.flat().find((row) => row.id === "list")!;
    const tree = makeTree(source, new Map(), { interrupted: () => operations >= 3 });

    await expect(tree.walkSubtree(list, 400)).rejects.toMatchObject({ cause: "user_interrupted" });
  });
});

/**
 * A screen whose layers panel splits its children under "Fixed" and "Scrolls" headers, as Figma
 * does for a frame with layers that stay put while it scrolls (seen on 2026-10-07).
 */
function scrollingScreen(): FakeNode[] {
  return [
    {
      id: "screen",
      name: "Screen",
      expanded: true,
      children: [
        { id: "", name: "Fixed", header: true },
        { id: "status", name: "Status Bar" },
        { id: "tabs", name: "Tab Bar", children: [{ id: "tab-home", name: "Home" }, { id: "tab-chat", name: "Chat" }] },
        { id: "", name: "Scrolls", header: true },
        { id: "feed", name: "Feed", children: [{ id: "post", name: "Post" }] },
        { id: "footer", name: "Footer" },
      ],
    },
    { id: "next", name: "Next screen" },
  ];
}

describe("LayerTree with section headers", () => {
  it("lists a frame's children past its Fixed and Scrolls headers, which are not layers", async () => {
    const source = new FakeLayers(scrollingScreen(), 3);
    const tree = makeTree(source);
    const screen = source.flat().find((row) => row.id === "screen")!;

    const page = await tree.childrenPage(screen, 1, 50);
    expect(ids(page.rows)).toEqual(["status", "tabs", "feed", "footer"]);
    expect(page.rows.map((row) => row.position)).toEqual([1, 2, 3, 4]);
    expect(page).toMatchObject({ total: 4, hasMore: false, stopReason: "complete" });

    const rest = await tree.childrenPage(screen, 3, 2, "tabs");
    expect(ids(rest.rows)).toEqual(["feed", "footer"]);
  });

  it("finds the frame above a layer that sits below a header", async () => {
    const source = new FakeLayers(scrollingScreen(), 3);
    const feed = source.flat().find((row) => row.id === "feed")!;
    source.top = feed.rowIndex;

    const siblings = await makeTree(source).siblingsPage(feed, 1, 50);
    expect(ids(siblings.rows)).toEqual(["status", "tabs", "feed", "footer"]);
  });

  it("walks the whole subtree without counting the headers as layers", async () => {
    const source = new FakeLayers(scrollingScreen(), 3);
    const before = source.expandedIds();
    const tree = makeTree(source);
    const screen = source.flat().find((row) => row.id === "screen")!;

    const walk = await tree.walkSubtree(screen, 400);
    expect(walk.complete).toBe(true);
    expect(walk.layers.map(({ row, parentRef }) => [row.id, parentRef])).toEqual([
      ["screen", null],
      ["status", "screen"],
      ["tabs", "screen"],
      ["tab-home", "tabs"],
      ["tab-chat", "tabs"],
      ["feed", "screen"],
      ["post", "feed"],
      ["footer", "screen"],
    ]);

    await tree.restore();
    expect(source.expandedIds()).toEqual(before);
  });
});

describe("LayerTree after a page reload", () => {
  /** The card screen as a fresh page load shows it: every layer collapsed and no row read yet. */
  function reloaded(): FakeLayers {
    const nodes = cardScreen(0);
    const collapse = (list: FakeNode[]) => {
      for (const node of list) {
        node.expanded = false;
        collapse(node.children ?? []);
      }
    };
    collapse(nodes);
    return new FakeLayers(nodes);
  }
  /** The way down to the fourth card's image, as a saved snapshot of the screen knows it. */
  const fromSnapshot = [
    { ref: "screen", parentRef: null },
    { ref: "list", parentRef: "screen" },
    { ref: "c4", parentRef: "list" },
    { ref: "c4-image", parentRef: "c4" },
  ];

  it("finds a deep layer through the parents a saved snapshot names, and closes what it opened", async () => {
    const source = reloaded();
    const index = new Map<string, IndexEntry>();
    learnParents(index, fromSnapshot);
    const tree = makeTree(source, index);

    const row = await tree.find("c4-image");
    expect(row?.id).toBe("c4-image");
    expect(source.expandedIds()).toEqual(["c4", "list", "screen"]);
    // The row's place is remembered, so the next find does not start from the page again.
    expect(index.get("c4-image")).toMatchObject({ rowIndex: row!.rowIndex, parentRef: "c4" });

    await tree.restore();
    expect(source.expandedIds()).toEqual([]);
  });

  it("finds nothing without the parents, as before", async () => {
    const source = reloaded();
    expect(await makeTree(source).find("c4-image")).toBeNull();
    expect(source.toggles).toBe(0);
  });

  it("keeps what the tab read itself over the parents the server sends", () => {
    const index = new Map<string, IndexEntry>([
      ["a", { rowIndex: 7, parentRef: "p" }],
      ["b", { rowIndex: 3 }],
    ]);
    learnParents(index, [
      { ref: "a", parentRef: "q" },
      { ref: "b", parentRef: "p" },
      { ref: "c", parentRef: null },
    ]);
    expect(index.get("a")).toEqual({ rowIndex: 7, parentRef: "p" });
    expect(index.get("b")).toEqual({ rowIndex: 3, parentRef: "p" });
    expect(index.get("c")).toEqual({ rowIndex: 0, parentRef: null });
  });
});

describe("hiddenLayers", () => {
  it("counts every layer inside a hidden layer as hidden, whatever its own row shows", async () => {
    const nodes = cardScreen(0);
    // The second card is hidden; its rows are greyed, but an instance row inside it may not say so.
    nodes[1]!.children![1]!.children![1]!.hidden = true;
    const source = new FakeLayers(nodes, 50);
    const tree = makeTree(source);
    const list = (await tree.find("list"))!;
    const walk = await tree.walkSubtree(list, 100);
    for (const layer of walk.layers) if (layer.row.id === "c2-button") layer.row = { ...layer.row, hidden: false };
    expect([...hiddenLayers(walk.layers)].sort()).toEqual(["c2", "c2-button", "c2-image", "c2-title"]);
  });
});
