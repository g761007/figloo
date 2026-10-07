import type { AnchorResult, ExplorePageParams, ExplorePageResult, ListNeighborsParams, ListPagesResult, NeighborsResult } from "@figloo/protocol";
import { MAX_ANCHORS } from "@figloo/protocol";
import { parseSelectedCount } from "../probe.js";
import { nextTask, synthesizeClick } from "./dom-source.js";
import type { ExplorerCore } from "./explorer-core.js";
import { BACKGROUND_MESSAGE, OpError, sleep } from "./operation.js";
import { readPagesList } from "./pages.js";
import { readRenderedRows, type Row } from "./row.js";
import { learnParents, type Page } from "./tree.js";

const PAGE_SWITCH_TIMEOUT_MS = 8_000;
/** How long the pages list must stay the same before it is reported, and the most list_pages waits for that. */
const PAGES_SETTLE_MS = 200;
const PAGES_WAIT_MS = 2_000;

export async function getAnchor(core: ExplorerCore): Promise<AnchorResult> {
  const identity = core.identity();
  const label = core.doc.querySelector("input.focus-target")?.getAttribute("aria-label") ?? null;
  const count = parseSelectedCount(label);
  if (count === 0) throw new OpError("NO_SELECTION", "no layer is selected in Figma");
  const { value, uiOps, elapsedMs } = await core.run(async (tree) => {
    // One layer can be found from the rows on screen; several need the list read in order.
    const single = count === null || count === 1;
    const rows = single ? [await tree.selectionRoot()].filter((row): row is Row => row !== null) : await tree.selectionRoots(Math.min(count, MAX_ANCHORS));
    if (rows.length === 0) throw new OpError("NO_SELECTION", "the selected layer is not in the layers panel");
    for (const row of rows) await tree.climb(row);
    return rows;
  });
  const anchors = value.map((row) => core.toNode(row));
  return { identity, selectionCount: count ?? 1, anchor: anchors[0]!, anchors, uiOps, elapsedMs };
}

/**
 * Lists the pages once the pages list has stopped changing. Figma drew every page at once in each
 * load seen in Arc on 2026-10-02, yet one first read there returned 8 of a file's 20 pages.
 */
export async function listPages(core: ExplorerCore): Promise<ListPagesResult> {
  const { fileKey } = core.identity();
  const deadline = Date.now() + PAGES_WAIT_MS;
  let list = readPagesList(core.doc);
  let changedAt = Date.now();
  while (Date.now() - changedAt < PAGES_SETTLE_MS && Date.now() < deadline) {
    // Timers are throttled in hidden tabs but message tasks are not.
    await (core.doc.hidden ? nextTask() : sleep(25));
    const next = readPagesList(core.doc);
    if (JSON.stringify(next) !== JSON.stringify(list)) {
      list = next;
      changedAt = Date.now();
    }
  }
  if (list.pages.length === 0) throw new OpError("UI_NOT_READY", "the pages list is not shown in Figma's left sidebar");
  const settled = Date.now() - changedAt >= PAGES_SETTLE_MS;
  return { fileKey, pages: list.pages, complete: settled && list.allDrawn };
}

export async function explorePage(core: ExplorerCore, params: ExplorePageParams): Promise<ExplorePageResult> {
  let identity = core.identity();
  if (params.page !== undefined && params.page !== identity.page) {
    await switchPage(core, params.page);
    identity = core.identity();
  }
  const { value, uiOps, elapsedMs } = await core.run((tree) => tree.topLevelPage(1, params.limit));
  return { identity, ...core.pageResult(value), uiOps, elapsedMs };
}

async function switchPage(core: ExplorerCore, name: string): Promise<void> {
  if (core.doc.hidden) throw new OpError("TAB_IN_BACKGROUND", BACKGROUND_MESSAGE);
  const button = [...core.doc.querySelectorAll('[data-testid="PagesRowWrapper"]')]
    .map((wrapper) => wrapper.querySelector("button"))
    .find((candidate) => candidate?.textContent?.trim() === name);
  if (!button) throw new OpError("NODE_NOT_FOUND", `there is no page named "${name}"`);
  const firstLayer = () => readRenderedRows(core.doc).find((row) => !row.header)?.id;
  const firstRowBefore = firstLayer();
  synthesizeClick(button);
  // The pages list marks the new page first; the layers panel follows once Figma has loaded it.
  const deadline = Date.now() + PAGE_SWITCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (core.identity().page === name && firstLayer() !== firstRowBefore) return;
    await sleep(50);
  }
  throw new OpError("UI_NOT_READY", `the layers panel did not show page "${name}" in time`);
}

export async function listNeighbors(core: ExplorerCore, params: ListNeighborsParams): Promise<NeighborsResult> {
  const identity = core.checkExpected(params.expect);
  learnParents(core.index, params.known ?? []);
  const { value, uiOps, elapsedMs } = await core.run(async (tree): Promise<Page> => {
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
        return (params.depth ?? 1) > 1 ? tree.subtreePage(row, params.depth!, params.limit) : tree.childrenPage(row, params.from, params.limit, params.after);
    }
  });
  return { identity, ...core.pageResult(value), uiOps, elapsedMs };
}
