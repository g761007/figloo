// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Explorer, OpError } from "../src/adapter/ops.js";
import { ReadingOverlay } from "../src/adapter/overlay.js";
import { readRenderedRows } from "../src/adapter/row.js";
import type { LayerTree } from "../src/adapter/tree.js";

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

  it("marks the row Figma greys out as hidden, selected or not", () => {
    // The one greyed-out row in the capture is not selected; its style sets color: var(--color-text-disabled).
    expect(readRenderedRows(document).filter((row) => row.hidden).map((row) => row.id)).toEqual(["338:4259"]);
    const el = document.querySelector('[data-testid="338:4259-layers-panel-row"]')!.closest('[role="row"]') as HTMLElement;
    el.setAttribute("style", el.getAttribute("style")!.replace("color: var(--color-text-disabled);", ""));
    expect(readRenderedRows(document).some((row) => row.hidden)).toBe(false);
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
  start<T>(overlay: ReadingOverlay, work: (tree: LayerTree) => T, finished: () => void): Promise<{ value: T }> {
    return this.run(
      async (tree) => {
        overlay.show();
        return work(tree);
      },
      // Putting the selection back drives the panel, which checks for interruptions like any other step.
      async (tree) => {
        tree.check();
        finished();
      },
      { timeBudgetMs: 5_000, maxUiOps: 10, overlay },
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
      () => (putBack = true),
    );
    await expect(run).rejects.toMatchObject({ code: "USER_INTERRUPTED", message: expect.stringMatching(/stopped the read with Stop or Esc/) });
    expect(putBack).toBe(true);
    expect(document.querySelector("figloo-reading-overlay")).toBeNull();
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
