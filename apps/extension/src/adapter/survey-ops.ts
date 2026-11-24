import type { SurveyParams, SurveyResult, SurveyRoot } from "@figloo/protocol";
import { MAX_NEIGHBOR_LIMIT, MAX_NOTE_LENGTH, MAX_SNAPSHOT_LAYERS, SURVEY_TIME_BUDGET_MS } from "@figloo/protocol";
import { Timings } from "../timings.js";
import type { ExplorerCore } from "./explorer-core.js";
import { inspectionSignature, layerSize } from "./inspect.js";
import { BACKGROUND_MESSAGE, MAX_NAME_LENGTH, OpError, type UserSelection } from "./operation.js";
import { ReadingOverlay, estimateRemainingMs } from "./overlay.js";
import type { Row } from "./row.js";
import { StopExploration, hiddenLayers, learnParents, type LayerTree, type Page } from "./tree.js";
import { BackgroundPause } from "./visibility.js";
import type { DomRowSource } from "./dom-source.js";

/** Far above what a survey needs: each layer is opened and closed once, and the time budget ends it first. */
const SURVEY_MAX_UI_OPS = 50_000;
/** A survey stops this long before its deadline, plus time to close what it opened. */
const SURVEY_RESERVE_MS = 5_000;
/** Layers whose size tells a screen from a piece of one; the inspection panel gives it once one is selected. */
const SIZED_TYPES = new Set(["Frame", "Auto layout", "Component", "Component set"]);

export interface ScopeEntry {
  row: Row;
  sectionRef: string | null;
}

/**
 * Surveys layers for an overview without reading their inspection panels: walks each one in the
 * layers panel, instances counting as one layer, and closes what it opened before the next. Frames
 * are selected once for their size. A section stands for the layers in it. The scope is the given
 * refs, or every layer directly on the page. A call that runs short of time stops between layers;
 * the next one skips those in `done`. Puts the user's selection back.
 */
export async function surveyFrames(core: ExplorerCore, params: SurveyParams): Promise<SurveyResult> {
  const identity = core.checkExpected(params.expect);
  learnParents(core.index, params.known ?? []);
  if (core.doc.hidden) throw new OpError("TAB_IN_BACKGROUND", BACKGROUND_MESSAGE);
  const timings = new Timings();
  // Guests and editors have no inspection panel; the survey goes on without sizes.
  const sized = await timings.time("survey.inspectionPanel", () => core.showInspectionPanel()).then(
    () => true,
    () => false,
  );
  const overlay = new ReadingOverlay(core.doc);
  const timeBudgetMs = params.timeBudgetMs ?? SURVEY_TIME_BUDGET_MS;
  const deadline = Date.now() + timeBudgetMs;
  const pause = new BackgroundPause(core.doc, deadline, (paused) => overlay.setPaused(paused));
  const done = new Set(params.done ?? []);
  let before: UserSelection = { kind: "none" };
  let restored = false;
  const ran = await core
    .run(
      async (tree, source) => {
        overlay.show();
        before = await core.userSelection(tree);
        const scoping = performance.now();
        const { entries, sections } = await scopeOf(tree, params.refs);
        timings.add("survey.scope", performance.now() - scoping);
        const todo = entries.filter((entry) => !done.has(entry.row.id));
        const roots: SurveyRoot[] = [];
        const durations: number[] = [];
        const timeIsUp = () => Date.now() > deadline - SURVEY_RESERVE_MS;
        let stopped = false;
        for (const [n, entry] of todo.entries()) {
          if (n > 0 && timeIsUp()) {
            stopped = true;
            break;
          }
          overlay.update({ phase: "surveying", done: entries.length - todo.length + n, total: entries.length, remainingMs: estimateRemainingMs(durations, todo.length - n) });
          const rootStarted = Date.now();
          try {
            roots.push(await surveyRoot(core, tree, source, entry, sized, pause, timings));
          } catch (error) {
            const budget = error instanceof StopExploration && (error.cause === "time_budget" || error.cause === "scan_budget");
            if (!budget) throw error;
            if (roots.length === 0) throw new OpError("BUDGET_EXCEEDED", "the survey ran out of time before it could look through one layer");
            stopped = true;
            break;
          }
          durations.push(Date.now() - rootStarted);
        }
        overlay.update({ phase: "finishing" });
        return { entries, sections, roots, stopped };
      },
      async (tree, source) => {
        restored = await timings.time("finish.selection", () => core.restoreSelection(tree, source, before));
      },
      { timeBudgetMs, maxUiOps: SURVEY_MAX_UI_OPS, collapseAfterInterrupt: true, overlay, pause },
    )
    .finally(() => {
      overlay.remove();
      pause.dispose();
    });
  const { value, uiOps, elapsedMs } = ran;
  return {
    identity,
    status: value.stopped ? "partial" : "complete",
    scope: value.entries.map(({ row, sectionRef }) => ({ ref: row.id, sectionRef })),
    sections: value.sections,
    roots: value.roots,
    userSelectionRestored: restored,
    uiOps,
    elapsedMs,
    timings: timings.toJSON(),
  };
}

/** The layers to survey, in layers panel order, with every section replaced by the layers in it. */
export async function scopeOf(tree: LayerTree, refs: string[] | null): Promise<{ entries: ScopeEntry[]; sections: SurveyResult["sections"] }> {
  const entries: ScopeEntry[] = [];
  const sections: SurveyResult["sections"] = [];
  const seen = new Set<string>();
  const visit = async (row: Row, sectionRef: string | null): Promise<void> => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    if (row.type === "Section") {
      sections.push({ ref: row.id, name: row.name.slice(0, MAX_NAME_LENGTH), parentRef: sectionRef });
      for (const child of await allChildren(tree, row)) await visit(child, row.id);
      return;
    }
    entries.push({ row, sectionRef });
  };
  if (refs === null) {
    for (const row of await allChildren(tree, null)) await visit(row, null);
  } else {
    for (const ref of refs) {
      const row = await tree.find(ref);
      if (!row) throw new OpError("NODE_NOT_FOUND", `layer ${ref} is no longer in the layers panel`);
      const parent = row.level === 0 ? null : await tree.parentOf(row);
      await visit(row, parent?.type === "Section" ? parent.id : null);
    }
  }
  return { entries, sections };
}

/** Every child of `parent`, or every layer directly on the page for null, page by page. */
async function allChildren(tree: LayerTree, parent: Row | null): Promise<Row[]> {
  const rows: Row[] = [];
  let from = 1;
  for (;;) {
    const after = rows.at(-1)?.id;
    const page: Page = parent ? await tree.childrenPage(parent, from, MAX_NEIGHBOR_LIMIT, after) : await tree.topLevelPage(from, MAX_NEIGHBOR_LIMIT, after);
    rows.push(...page.rows);
    if (!page.hasMore || page.nextFrom === null) return rows;
    if (page.stopReason === "ui_timeout") throw new OpError("UI_NOT_READY", "the layers panel did not show all the layers to survey");
    if (page.stopReason === "time_budget" || page.stopReason === "scan_budget") throw new StopExploration(page.stopReason);
    from = page.nextFrom;
  }
}

/** One layer of the scope: its size when it is a frame, and the layers inside it. */
async function surveyRoot(core: ExplorerCore, tree: LayerTree, source: DomRowSource, entry: ScopeEntry, sized: boolean, pause: BackgroundPause, timings: Timings): Promise<SurveyRoot> {
  tree.check();
  const row = (await tree.find(entry.row.id)) ?? entry.row;
  let size: SurveyRoot["size"] = null;
  if (sized && SIZED_TYPES.has(row.type ?? "")) size = await timings.time("survey.size", () => sizeOf(core, source, row, pause));
  const { layers, complete } = await walkRoot(tree, row, timings);
  return {
    ref: row.id,
    name: row.name.slice(0, row.type === "Text" ? MAX_NOTE_LENGTH : MAX_NAME_LENGTH),
    type: row.type,
    sectionRef: entry.sectionRef,
    hidden: row.hidden,
    size,
    complete,
    layers,
  };
}

/**
 * The layers inside `row`, instances counting as one, and whether they all fit MAX_SNAPSHOT_LAYERS.
 * Closes what the walk opened, so the layers panel stays short for the next one.
 */
export async function walkRoot(tree: LayerTree, row: Row, timings = new Timings()): Promise<{ layers: SurveyRoot["layers"]; complete: boolean }> {
  if (!row.hasChildren || row.type === "Instance") return { layers: [], complete: true };
  const walking = performance.now();
  const mark = tree.expandedCount();
  const walk = await tree.walkSubtree(row, MAX_SNAPSHOT_LAYERS);
  const hidden = hiddenLayers(walk.layers);
  const layers = walk.layers.slice(1).map(({ row: layer, parentRef }) => ({
    ref: layer.id,
    parentRef: parentRef ?? row.id,
    name: layer.name.slice(0, MAX_NAME_LENGTH),
    type: layer.type,
    hidden: hidden.has(layer.id),
  }));
  timings.add("walk", performance.now() - walking);
  const closing = performance.now();
  await tree.restore(mark);
  timings.add("survey.close", performance.now() - closing);
  return { layers, complete: walk.complete };
}

/** The layer's width and height from the inspection panel once it shows the layer; null when it does not. */
async function sizeOf(core: ExplorerCore, source: DomRowSource, row: Row, pause: BackgroundPause): Promise<SurveyRoot["size"]> {
  // A panel read while the tab went to the background may be stale, so it is read again once the tab is back.
  for (;;) {
    const mark = pause.mark();
    const previous = inspectionSignature(core.doc);
    if (!(await source.select(row))) return null;
    const size = await core.waitForPanel(row, previous, source).then(
      () => layerSize(core.doc),
      () => null,
    );
    if (!pause.hidSince(mark)) return size;
    await pause.untilVisible();
  }
}
