import { describe, expect, it } from "vitest";
import { scopeOf, walkRoot } from "../src/adapter/survey-ops.js";
import { LayerTree, type IndexEntry } from "../src/adapter/tree.js";
import { FakeLayers, type FakeNode } from "./fake-layers.js";

/** A screen with a header and a list of two cards, each with a title and a button instance. */
function screen(id: string): FakeNode {
  const card = (n: number): FakeNode => ({
    id: `${id}-card${n}`,
    name: "Card",
    children: [
      { id: `${id}-card${n}-title`, name: "Title", type: "Text" },
      { id: `${id}-card${n}-button`, name: "Button", type: "Instance", children: [{ id: `${id}-card${n}-label`, name: "Label", type: "Text" }] },
    ],
  });
  return {
    id,
    name: `Screen ${id}`,
    children: [
      { id: `${id}-header`, name: "Header", type: "Instance", children: [{ id: `${id}-logo`, name: "Logo" }] },
      { id: `${id}-list`, name: "List", type: "Auto layout", children: [card(1), card(2)] },
    ],
  };
}

/** A page as designers lay one out: notes, a loose frame, an instance, and frames in sections, one section inside another. */
function page(): FakeNode[] {
  return [
    { id: "note", name: "Primary color #3366FF\nfor buttons", type: "Text" },
    screen("home"),
    { id: "tabbar", name: "Tab Bar", type: "Instance", children: [{ id: "tab", name: "Tab" }] },
    {
      id: "flow",
      name: "Sign up",
      type: "Section",
      children: [screen("step1"), { id: "states", name: "States", type: "Section", children: [screen("error")] }, { id: "flow-note", name: "Errors show inline", type: "Text" }],
    },
  ];
}

function makeTree(source: FakeLayers, index = new Map<string, IndexEntry>()): LayerTree {
  return new LayerTree(source, index, { deadline: Number.POSITIVE_INFINITY, maxUiOps: 10_000, now: () => 0, interrupted: () => false });
}

describe("the scope of a survey", () => {
  it("takes every layer on the page, with each section, also one inside another, replaced by its layers", async () => {
    const source = new FakeLayers(page());
    const tree = makeTree(source);
    const { entries, sections } = await scopeOf(tree, null);
    expect(entries.map(({ row, sectionRef }) => [row.id, sectionRef])).toEqual([
      ["note", null],
      ["home", null],
      ["tabbar", null],
      ["step1", "flow"],
      ["error", "states"],
      ["flow-note", "flow"],
    ]);
    expect(sections).toEqual([
      { ref: "flow", name: "Sign up", parentRef: null },
      { ref: "states", name: "States", parentRef: "flow" },
    ]);
    await tree.restore();
    expect(source.expandedIds()).toEqual([]);
  });

  it("takes the layers the agent named, a section standing for what is in it, and says which section a frame is in", async () => {
    const source = new FakeLayers(page());
    const index = new Map<string, IndexEntry>();
    // The context learned where the frame is when it listed the section earlier.
    await makeTree(source, index).childrenPage(source.flat().find((row) => row.id === "flow")!, 1, 50);
    const tree = makeTree(source, index);
    const { entries } = await scopeOf(tree, ["home", "step1", "states"]);
    expect(entries.map(({ row, sectionRef }) => [row.id, sectionRef])).toEqual([
      ["home", null],
      ["step1", "flow"],
      ["error", "states"],
    ]);
  });
});

describe("walking one layer of a survey", () => {
  it("lists the layers inside a frame, instances as one layer, and closes only what it opened", async () => {
    const nodes = page();
    // The user had the section open; the survey must not close it.
    nodes[3]!.expanded = true;
    const source = new FakeLayers(nodes);
    const before = source.expandedIds();
    const tree = makeTree(source);
    const frame = source.flat().find((row) => row.id === "step1")!;

    const { layers, complete } = await walkRoot(tree, frame);
    expect(complete).toBe(true);
    expect(layers.map((layer) => [layer.ref, layer.parentRef, layer.type])).toEqual([
      ["step1-header", "step1", "Instance"],
      ["step1-list", "step1", "Auto layout"],
      ["step1-card1", "step1-list", "Frame"],
      ["step1-card1-title", "step1-card1", "Text"],
      ["step1-card1-button", "step1-card1", "Instance"],
      ["step1-card2", "step1-list", "Frame"],
      ["step1-card2-title", "step1-card2", "Text"],
      ["step1-card2-button", "step1-card2", "Instance"],
    ]);
    expect(source.expandedIds()).toEqual(before);
  });

  it("keeps open what an earlier step of the survey opened, such as the section it listed, until the end", async () => {
    const source = new FakeLayers(page());
    const tree = makeTree(source);
    await scopeOf(tree, null);
    const opened = source.expandedIds();
    expect(opened).toEqual(["flow", "states"]);

    await walkRoot(tree, source.flat().find((row) => row.id === "step1")!);
    await walkRoot(tree, source.flat().find((row) => row.id === "error")!);
    expect(source.expandedIds()).toEqual(opened);
    await tree.restore();
    expect(source.expandedIds()).toEqual([]);
  });

  it("does not walk into an instance or a layer without children", async () => {
    const source = new FakeLayers(page());
    const tree = makeTree(source);
    expect(await walkRoot(tree, source.flat().find((row) => row.id === "tabbar")!)).toEqual({ layers: [], complete: true });
    expect(await walkRoot(tree, source.flat().find((row) => row.id === "note")!)).toEqual({ layers: [], complete: true });
    expect(source.toggles).toBe(0);
  });

  it("marks the layers inside a hidden one as hidden", async () => {
    const nodes = page();
    nodes[1]!.children![1]!.hidden = true;
    const source = new FakeLayers(nodes);
    const { layers } = await walkRoot(makeTree(source), source.flat().find((row) => row.id === "home")!);
    expect(layers.filter((layer) => layer.hidden).map((layer) => layer.ref)).toEqual([
      "home-list",
      "home-card1",
      "home-card1-title",
      "home-card1-button",
      "home-card2",
      "home-card2-title",
      "home-card2-button",
    ]);
  });
});
