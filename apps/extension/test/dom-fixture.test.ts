// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomRowSource } from "../src/adapter/dom-source.js";
import { Explorer, OpError } from "../src/adapter/ops.js";
import { ReadingOverlay } from "../src/adapter/overlay.js";
import { readRenderedRows } from "../src/adapter/row.js";
import { StopExploration, type LayerTree } from "../src/adapter/tree.js";
import { BackgroundPause } from "../src/adapter/visibility.js";

/** The repository root, found from the working directory; URL-based paths do not work under happy-dom. */
function repoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const up = dirname(dir);
    if (up === dir) throw new Error("repository root not found");
    dir = up;
  }
  return dir;
}

const FIXTURE = readFileSync(join(repoRoot(), "tests/fixtures/figma-layers-panel.html"), "utf8");
const SECTIONS_FIXTURE = readFileSync(join(repoRoot(), "tests/fixtures/figma-layers-panel-sections.html"), "utf8");
const FILE_URL = "https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/Sample-App?node-id=873-45095";

beforeEach(() => {
  document.documentElement.innerHTML = new DOMParser().parseFromString(FIXTURE, "text/html").documentElement.innerHTML;
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(FILE_URL);
});

describe("layers panel parsing on captured Figma markup", () => {
  it("reads IDs, depth, sibling position, type, and state from each row", () => {
    const rows = readRenderedRows(document);
    expect(rows.map((row) => row.id)).toEqual(["973:55870", "923:49305", "338:4256", "917:46916", "873:45095", "1335:5270", "1335:5269", "1335:5268", "422:7842", "338:4265", "338:4259"]);
    expect(rows.find((row) => row.id === "873:45095")).toMatchObject({ level: 1, position: 2, setSize: 12, type: "Instance", hasChildren: true, expanded: true, selected: false });
    expect(rows.find((row) => row.id === "1335:5269")).toMatchObject({ level: 2, position: 2, setSize: 3, type: "Auto layout", selected: true, name: "Layer 7" });
    expect(rows.find((row) => row.id === "338:4259")).toMatchObject({ type: "Image", hasChildren: false, expanded: false });
  });

  it("marks the rows Figma greys out or dims as hidden, selected or not", () => {
    // 338:4259 is grey, color: var(--color-text-disabled). 1335:5269, inside an instance, is the dimmest
    // purple, color: var(--color-text-component-tertiary), which Arc showed on 2026-10-02 for hidden
    // instances whether selected or not, while visible ones keep var(--color-text-component).
    expect(readRenderedRows(document).filter((row) => row.hidden).map((row) => row.id)).toEqual(["1335:5269", "338:4259"]);
    for (const [id, color] of [
      ["338:4259", "color: var(--color-text-disabled);"],
      ["1335:5269", "color: var(--color-text-component-tertiary);"],
    ]) {
      const el = document.querySelector(`[data-testid="${id}-layers-panel-row"]`)!.closest('[role="row"]') as HTMLElement;
      expect(el.getAttribute("style")).toContain(color);
      el.setAttribute("style", el.getAttribute("style")!.replace(color, "color: var(--color-text-component);"));
    }
    expect(readRenderedRows(document).some((row) => row.hidden)).toBe(false);
  });
});

describe("section headers on captured Figma markup", () => {
  beforeEach(() => {
    document.documentElement.innerHTML = new DOMParser().parseFromString(SECTIONS_FIXTURE, "text/html").documentElement.innerHTML;
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/Sample-App?node-id=0-1");
  });

  it("reads the Fixed and Scrolls rows as section headers, not layers", () => {
    const rows = readRenderedRows(document);
    expect(rows.filter((row) => row.header).map(({ name, level, rowIndex }) => ({ name, level, rowIndex }))).toEqual([
      { name: "Fixed", level: 1, rowIndex: 2 },
      { name: "Scrolls", level: 1, rowIndex: 5 },
    ]);
    expect(rows.filter((row) => !row.header)).toHaveLength(35);
    // Figma leaves the headers out of the sibling positions and counts.
    expect(rows.find((row) => row.id === "0:677")).toMatchObject({ rowIndex: 3, level: 1, position: 1, setSize: 18 });
    expect(rows.find((row) => row.id === "0:580")).toMatchObject({ rowIndex: 6, level: 1, position: 3, setSize: 18 });
  });

  it("lists every child of a frame whose layers sit under section headers", async () => {
    const explorer = new Explorer("page-1", document, window);
    const expect_ = explorer.identity();
    const all = await explorer.listNeighbors({ expect: expect_, ref: "0:78", relation: "children", from: 1, limit: 50 });
    expect(all.nodes.map((node) => node.position)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(all.nodes.every((node) => node.parentRef === "0:78" && node.siblingCount === 18)).toBe(true);
    expect(all).toMatchObject({ total: 18, hasMore: false, stopReason: "complete" });

    const page = await explorer.listNeighbors({ expect: expect_, ref: "0:78", relation: "children", from: 3, limit: 4, after: all.nodes[1]!.ref });
    expect(page.nodes.map((node) => node.ref)).toEqual(all.nodes.slice(2, 6).map((node) => node.ref));
  });

  it("climbs from a layer below a header to its frame", async () => {
    const explorer = new Explorer("page-1", document, window);
    const expect_ = explorer.identity();
    const ancestors = await explorer.listNeighbors({ expect: expect_, ref: "0:580", relation: "ancestors", from: 1, limit: 20 });
    expect(ancestors.nodes.map((node) => node.ref)).toEqual(["0:78"]);
    const siblings = await explorer.listNeighbors({ expect: expect_, ref: "0:580", relation: "siblings", from: 1, limit: 50 });
    expect(siblings.nodes).toHaveLength(18);
  });

  it("counts the rows from where they are drawn, since header rows are shorter than layer rows", () => {
    // Scrolled so that the first rendered row is a header: 24 px tall, where layer rows are 32 px.
    document.querySelector('[data-testid="0:78-layers-panel-row"]')!.closest('[role="row"]')!.remove();
    expect(new DomRowSource(document).rowCount()).toBe(37);
  });

  it("scrolls to where a row is drawn, not to where uniform rows would put it", async () => {
    const scroller = document.querySelector('[data-testid="objects-panel"]')!.parentElement!;
    await new DomRowSource(document).reveal(37, "start");
    // Row 37 starts at 1136 px: 35 layer rows of 32 px and two headers of 24 px come before it, not 36 rows of 32 px.
    expect(scroller.scrollTop).toBe(1136);
  });
});

describe("Explorer on captured Figma markup", () => {
  it("anchors on the selected layer inside an instance even though the URL names the instance", async () => {
    const explorer = new Explorer("page-1", document, window);
    const result = await explorer.getAnchor();
    expect(result.identity).toMatchObject({ pageId: "page-1", fileKey: "AbCdEfGhIjKlMnOpQrStUv" });
    expect(result.anchor).toMatchObject({ ref: "1335:5269", name: "Layer 7", parentRef: "873:45095", insideInstance: true, link: null, depth: 2 });
  });

  it("links layers outside instances to their node in the file", async () => {
    // The fixture keeps rows 32 and 41 to 48 contiguous, so the ancestors of 422:7842 are all present.
    document.querySelector('[data-testid="1335:5269-layers-panel-row"]')!.closest('[role="row"]')!.setAttribute("aria-selected", "false");
    document.querySelector('[data-testid="422:7842-layers-panel-row"]')!.closest('[role="row"]')!.setAttribute("aria-selected", "true");
    const result = await new Explorer("page-1", document, window).getAnchor();
    expect(result.anchor).toMatchObject({ ref: "422:7842", type: "Component", parentRef: "338:4256", insideInstance: false });
    expect(result.anchor.link).toBe("https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/Sample-App?node-id=422-7842");
  });

  it("refuses to anchor without a selection", async () => {
    const target = document.querySelector("input.focus-target")!;
    target.setAttribute("aria-label", "Figma Design");
    await expect(new Explorer("p", document, window).getAnchor()).rejects.toMatchObject({ code: "NO_SELECTION" });
  });

  it("rejects a context from an earlier page load before touching the panel", async () => {
    const explorer = new Explorer("page-2", document, window);
    const expect_ = { pageId: "page-1", fileKey: "AbCdEfGhIjKlMnOpQrStUv", page: null };
    await expect(explorer.listNeighbors({ expect: expect_, ref: "1335:5269", relation: "parent", from: 1, limit: 20 })).rejects.toBeInstanceOf(OpError);
    await expect(explorer.listNeighbors({ expect: expect_, ref: "1335:5269", relation: "parent", from: 1, limit: 20 })).rejects.toMatchObject({ code: "CONTEXT_EXPIRED" });
  });

  it("does not click in a background tab, where Figma would silently ignore the expand", async () => {
    const explorer = new Explorer("page-1", document, window);
    const { identity } = await explorer.getAnchor();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    try {
      // 1335:5270 is collapsed, so listing its children needs an expand.
      await expect(explorer.listNeighbors({ expect: identity, ref: "1335:5270", relation: "children", from: 1, limit: 20 })).rejects.toMatchObject({ code: "TAB_IN_BACKGROUND" });
      // Reading rows that are already expanded still works in the background.
      const siblings = await explorer.listNeighbors({ expect: identity, ref: "1335:5270", relation: "siblings", from: 1, limit: 20 });
      expect(siblings.nodes).toHaveLength(3);
    } finally {
      delete (document as unknown as { hidden?: boolean }).hidden;
    }
  });

  it("explains that a guest cannot read properties instead of waiting for a panel that never comes", async () => {
    const explorer = new Explorer("page-1", document, window);
    const { identity } = await explorer.getAnchor();
    // The captured page has no right sidebar, just like a guest session.
    await expect(explorer.inspectNodes({ expect: identity, refs: ["1335:5269"] })).rejects.toMatchObject({ code: "UI_NOT_READY", message: expect.stringMatching(/guest/) });
  });

  it("explains at once that it cannot read the Design panel Figma shows with edit access", async () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div role="region" aria-label="Right sidebar"><div role="tablist"><button role="tab" aria-selected="true">Design</button><button role="tab" aria-selected="false">Prototype</button></div></div>',
    );
    const explorer = new Explorer("page-1", document, window);
    const { identity } = await explorer.getAnchor();
    const started = Date.now();
    await expect(explorer.inspectNodes({ expect: identity, refs: ["1335:5269"] })).rejects.toMatchObject({ code: "UI_NOT_READY", message: expect.stringMatching(/edit access/) });
    await expect(explorer.prepareExport({ expect: identity, ref: "1335:5269", token: "t" })).rejects.toMatchObject({ code: "UI_NOT_READY", message: expect.stringMatching(/edit access/) });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("lists the siblings of the anchor from the rendered rows", async () => {
    const explorer = new Explorer("page-1", document, window);
    const { identity } = await explorer.getAnchor();
    const page = await explorer.listNeighbors({ expect: identity, ref: "1335:5269", relation: "siblings", from: 1, limit: 20 });
    expect(page.nodes.map((node) => node.ref)).toEqual(["1335:5270", "1335:5269", "1335:5268"]);
    expect(page).toMatchObject({ total: 3, hasMore: false, stopReason: "complete" });
    expect(page.nodes.every((node) => node.parentRef === "873:45095" && node.insideInstance === true)).toBe(true);
  });
});

/** Runs an operation with the reading overlay the way readSubtree does, with a probe as its work. */
class OverlayRun extends Explorer {
  start<T>(overlay: ReadingOverlay, work: (tree: LayerTree) => T, putBack: (tree: LayerTree) => void, pause?: BackgroundPause): Promise<{ value: T }> {
    return this.run(
      async (tree) => {
        overlay.show();
        return work(tree);
      },
      async (tree) => putBack(tree),
      { timeBudgetMs: 5_000, maxUiOps: 10, overlay, ...(pause ? { pause } : {}) },
    ).finally(() => overlay.remove());
  }
}

/** A pointer press as the browser reports a real one. */
function trustedPress(): PointerEvent {
  const event = new PointerEvent("pointerdown", { bubbles: true, composed: true });
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
}

describe("the reading overlay during an operation", () => {
  it("ends the operation on Stop and still puts the layers panel and selection back", async () => {
    const overlay = new ReadingOverlay(document);
    let putBack = false;
    const run = new OverlayRun("page-1", document, window).start(
      overlay,
      (tree) => {
        overlay.root.querySelector("button")!.click();
        tree.check();
        return "read";
      },
      // Putting the selection back drives the panel, which checks for interruptions like any other step.
      (tree) => {
        tree.check();
        putBack = true;
      },
    );
    await expect(run).rejects.toMatchObject({ code: "USER_INTERRUPTED", message: expect.stringMatching(/stopped the read with Stop or Esc/) });
    expect(putBack).toBe(true);
    expect(document.querySelector("figloo-reading-overlay")).toBeNull();
  });

  it("still puts the selection back when the read ran out of time", async () => {
    vi.setSystemTime(Date.now());
    try {
      let putBack = false;
      const run = new OverlayRun("page-1", document, window).start(
        new ReadingOverlay(document),
        (tree) => {
          vi.setSystemTime(Date.now() + 6_000);
          tree.check();
          return "read";
        },
        // Finding the user's layers again reads the panel, which checks the budgets like any other step.
        (tree) => {
          tree.check();
          putBack = true;
        },
      );
      await expect(run).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", message: expect.stringMatching(/time budget/) });
      expect(putBack).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not take a click on the overlay for the user stepping in, but a click in Figma still is", async () => {
    let putBack = false;
    const onOverlay = new ReadingOverlay(document);
    const read = new OverlayRun("page-1", document, window).start(
      onOverlay,
      (tree) => {
        onOverlay.root.firstElementChild!.dispatchEvent(trustedPress());
        tree.check();
        return "read";
      },
      () => (putBack = true),
    );
    await expect(read).resolves.toMatchObject({ value: "read" });
    expect(putBack).toBe(true);

    putBack = false;
    const inFigma = new OverlayRun("page-1", document, window).start(
      new ReadingOverlay(document),
      (tree) => {
        document.body.dispatchEvent(trustedPress());
        tree.check();
        return "read";
      },
      () => (putBack = true),
    );
    await expect(inFigma).rejects.toMatchObject({ code: "USER_INTERRUPTED", message: expect.stringMatching(/interacted with Figma/) });
    // The user's own input wins: nothing is put back over it.
    expect(putBack).toBe(false);
  });
});

/** The tab's visibility as the test sets it; Figma reacts to clicks only while the tab is visible. */
let hidden = false;
function setHidden(value: boolean): void {
  hidden = value;
  document.dispatchEvent(new Event("visibilitychange"));
}
function simulateHiddenTab(): () => void {
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  return () => delete (document as unknown as { hidden?: boolean }).hidden;
}
const rowOf = (id: string) => document.querySelector(`[data-testid="${id}-layers-panel-row"]`)!.closest('[role="row"]')!;
const cellOf = (id: string) => rowOf(id).querySelector('[role="gridcell"]:not([aria-hidden="true"])')!;

describe("a read while the tab goes to the background", () => {
  it("waits to select a layer until the tab is back, instead of clicking where Figma ignores it", async () => {
    const restore = simulateHiddenTab();
    try {
      const pause = new BackgroundPause(document, Date.now() + 5_000);
      const source = new DomRowSource(document, pause);
      const row = readRenderedRows(document).find((r) => r.id === "1335:5269")!;
      let clicks = 0;
      cellOf("1335:5269").addEventListener("click", () => (clicks += 1));
      setHidden(true);
      const selecting = source.select(row);
      await new Promise((r) => setTimeout(r, 30));
      expect(clicks).toBe(0);
      setHidden(false);
      await expect(selecting).resolves.toBe(true);
      expect(clicks).toBe(1);
      pause.dispose();
    } finally {
      restore();
    }
  });

  it("clicks again once the tab is back when the tab went to the background as it clicked", async () => {
    const restore = simulateHiddenTab();
    try {
      const pause = new BackgroundPause(document, Date.now() + 10_000);
      const source = new DomRowSource(document, pause);
      const row = readRenderedRows(document).find((r) => r.id === "1335:5270")!;
      let clicks = 0;
      cellOf("1335:5270").addEventListener("click", () => {
        clicks += 1;
        // The first click arrives as the user switches tabs, so Figma never applies it.
        if (clicks === 1) {
          setHidden(true);
          setTimeout(() => setHidden(false), 50);
          return;
        }
        if (!document.hidden) rowOf("1335:5270").setAttribute("aria-selected", "true");
      });
      await expect(source.select(row)).resolves.toBe(true);
      expect(clicks).toBe(2);
      pause.dispose();
    } finally {
      restore();
    }
  });

  it("puts the panel back once the tab returns when the read ran out of time in the background", async () => {
    const restore = simulateHiddenTab();
    try {
      let putBack = false;
      const pause = new BackgroundPause(document, Date.now() + 5_000);
      const run = new OverlayRun("page-1", document, window).start(
        new ReadingOverlay(document),
        () => {
          setHidden(true);
          throw new StopExploration("time_budget");
        },
        () => (putBack = true),
        pause,
      );
      await expect(run).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", message: expect.stringMatching(/in the background/) });
      expect(putBack).toBe(false);
      setHidden(false);
      await new Promise((r) => setTimeout(r, 0));
      expect(putBack).toBe(true);
    } finally {
      restore();
    }
  });

  it("leaves the panel to the user who used Figma before the tab came back, and to another file", async () => {
    const restore = simulateHiddenTab();
    try {
      for (const meanwhile of [() => document.body.dispatchEvent(trustedPress()), () => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://www.figma.com/design/OtherFileKey0000000000/Other")]) {
        let putBack = false;
        const run = new OverlayRun("page-1", document, window).start(
          new ReadingOverlay(document),
          () => {
            setHidden(true);
            throw new StopExploration("time_budget");
          },
          () => (putBack = true),
          new BackgroundPause(document, Date.now() + 5_000),
        );
        await expect(run).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
        meanwhile();
        setHidden(false);
        await new Promise((r) => setTimeout(r, 0));
        expect(putBack).toBe(false);
      }
    } finally {
      restore();
    }
  });
});
