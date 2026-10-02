import type { FigmaPage } from "@figloo/protocol";

/** What the pages list in Figma's left sidebar shows. */
export interface PagesList {
  pages: FigmaPage[];
  /** False when the list shows signs of pages it has not drawn. */
  allDrawn: boolean;
}

/**
 * Reads the pages list. Each page is a row of a grid inside its own scroll container, and nothing
 * in it counts the pages (seen in Arc on 2026-10-02). Missing pages can only show as a grid row
 * without a page in it, or as scroll content taller than the rows.
 */
export function readPagesList(root: ParentNode): PagesList {
  const wrappers = [...root.querySelectorAll('[data-testid="PagesRowWrapper"]')];
  const pages = wrappers
    .map((wrapper) => wrapper.querySelector("button"))
    .filter((button): button is HTMLButtonElement => button !== null)
    .map((button) => ({ name: button.textContent?.trim() ?? "", current: button.getAttribute("aria-current") === "page" }))
    .filter((page) => page.name.length > 0);
  const grid = wrappers[0]?.closest('[role="grid"]');
  if (!grid) return { pages, allDrawn: true };
  const emptyRow = [...grid.children].some((child) => !child.querySelector('[data-testid="PagesRowWrapper"]'));
  return { pages, allDrawn: !emptyRow && !scrollsPastRows(grid, wrappers) };
}

/** Whether the list's scroll container holds at least half a row more than the rows drawn in it. */
function scrollsPastRows(grid: Element, wrappers: Element[]): boolean {
  const view = grid.ownerDocument.defaultView;
  let scroller = grid.parentElement;
  while (scroller && view && !/auto|scroll/.test(view.getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  const heights = wrappers.map((wrapper) => (wrapper.closest('[role="row"]') ?? wrapper).getBoundingClientRect().height);
  const drawn = heights.reduce((sum, height) => sum + height, 0);
  // Without layout there is nothing to compare.
  if (!scroller || drawn === 0) return false;
  return scroller.scrollHeight - drawn > Math.max(...heights) / 2;
}
