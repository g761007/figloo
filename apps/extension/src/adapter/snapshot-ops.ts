import type { ReadSubtreeParams, Rect, SnapshotLayer, SnapshotReadResult } from "@figloo/protocol";
import { MAX_NEIGHBOR_LIMIT } from "@figloo/protocol";
import type { ExplorerCore } from "./explorer-core.js";
import { exportSection, exportSettings, exportsLayer, unreadableExportRows } from "./export.js";
import { boundsInRoot, chooseZoom } from "./geometry.js";
import { boxOf, inspectionRoot, inspectionSignature, readInspection } from "./inspect.js";
import { BACKGROUND_MESSAGE, MAX_NAME_LENGTH, OpError, parseZoom, watchForUser, type UserSelection } from "./operation.js";
import { ReadingOverlay, estimateRemainingMs } from "./overlay.js";
import { readInTurn, resumePoint } from "./resume.js";
import { hiddenLayers, learnParents } from "./tree.js";
import { BackgroundPause } from "./visibility.js";

/** A snapshot's UI budget per allowed layer: the walk opens a layer at most once, and reading reveals few rows. */
const SNAPSHOT_UI_OPS_PER_LAYER = 3;
/** How long a snapshot waits for the mirror to place a selected layer; it never places hidden ones. */
const SNAPSHOT_MIRROR_WAIT_MS = 300;
/** A resumable snapshot stops reading this long before its deadline, plus time to close each layer it opened. */
const SNAPSHOT_RESERVE_MS = 5_000;
const COLLAPSE_MS_PER_ROW = 100;

/**
 * Reads a layer and its whole subtree for a snapshot, instances counting as one layer: walks the
 * layers panel once, opening what is collapsed, then selects every layer in panel order to read
 * its inspection panel and where the mirror shows it. The view must not move meanwhile, so the
 * screen positions match the screenshot taken just before. Closes what it opened and puts the
 * user's selection back. A subtree above `maxLayers` is not read; its root's children are listed.
 * With `resume`, a call that runs short of time stops between layers and reports how far it got,
 * and a later call goes on from there after walking the panel again.
 */
export async function readSubtree(core: ExplorerCore, params: ReadSubtreeParams): Promise<SnapshotReadResult> {
  const identity = core.checkExpected(params.expect);
  learnParents(core.index, params.known ?? []);
  if (core.doc.hidden) throw new OpError("TAB_IN_BACKGROUND", BACKGROUND_MESSAGE);
  // The screenshot was taken before this op, so the overlay cannot end up in it.
  const overlay = new ReadingOverlay(core.doc);
  // Stop on the overlay changes nothing in Figma, so the view goes back then too; other input means the user took over.
  const user = watchForUser(core.win, overlay);
  const viewBack = () => core.putViewBack(params.view, user).finally(() => user.dispose());
  await core.showInspectionPanel().catch(async (error: unknown) => {
    await viewBack();
    throw error;
  });
  let before: UserSelection = { kind: "none" };
  let restored = false;
  let rootPath: string[] = [];
  const deadline = Date.now() + params.timeBudgetMs;
  const pause = new BackgroundPause(core.doc, deadline, (paused) => overlay.setPaused(paused));
  const ran = await core.run(
    async (tree, source) => {
      overlay.show();
      const started = Date.now();
      before = await core.userSelection(tree);
      const root = await tree.find(params.ref);
      if (!root) throw new OpError("NODE_NOT_FOUND", `layer ${params.ref} is no longer in the layers panel`);
      const { chain, reachedTop } = await tree.climb(root);
      if (!reachedTop) throw new OpError("UI_NOT_READY", `the layers panel did not show the parents of layer ${params.ref}`);
      if (chain.some((parent) => parent.type === "Instance")) {
        throw new OpError("INSIDE_INSTANCE", `layer ${params.ref} is inside an instance, whose layer IDs only hold until the page reloads`);
      }
      // The climb goes from the parent up; the snapshot keeps the way down, so the root can be found after a reload.
      rootPath = chain.map((parent) => parent.id).reverse();
      const walk = await tree.walkSubtree(root, params.maxLayers, (found) => overlay.update({ phase: "walking", found }));
      if (!walk.complete) {
        const page = await tree.childrenPage(walk.layers[0]!.row, 1, MAX_NEIGHBOR_LIMIT);
        return { status: "too_large" as const, children: page.rows, childrenHasMore: page.hasMore };
      }
      const walkMs = Date.now() - started;
      const walked = walk.layers.map(({ row, parentRef }) => ({ ref: row.id, parentRef }));
      const { start, restarted } = resumePoint(
        walked.map(({ ref, parentRef }) => `${ref}|${parentRef}`),
        params.resume,
      );
      // Every call reads the root first: its place on screen and its width give this call's zoom.
      const indexes = [0, ...walk.layers.map((_, i) => i).slice(Math.max(1, start))];
      // The view stays put, so every layer the mirror places on the way is measured on the same screen.
      const rects = new Map<string, Rect>();
      const collect = () => {
        for (const [id, rect] of source.mirrorRects()) rects.set(id, rect);
      };
      const durations: number[] = [];
      let fresh = 0;
      const readOne = async (index: number) => {
        const layer = walk.layers[index]!;
        const done = Math.max(start, 0) + fresh;
        overlay.update({ phase: "reading", done, total: walk.layers.length, remainingMs: estimateRemainingMs(durations, walk.layers.length - done) });
        // A layer read while the tab went to the background may show a stale panel, so it is read again once the tab is back.
        for (;;) {
          const layerStarted = Date.now();
          const mark = pause.mark();
          tree.check();
          const row = await tree.find(layer.row.id);
          if (!row) throw new OpError("NODE_NOT_FOUND", `layer ${layer.row.id} is no longer in the layers panel`);
          const previous = inspectionSignature(core.doc);
          if (!(await source.select(row))) throw new OpError("UI_NOT_READY", `Figma did not select layer ${row.id}`);
          // Two layers that look alike leave the panel unchanged; the selection itself did change.
          const switched = await core.waitForPanel(row, previous, source).then(
            () => true,
            () => false,
          );
          const sections = readInspection(inspectionRoot(core.doc) ?? core.doc);
          // Every layer shows at least its size, so a root without sections means a panel Figloo does not know.
          if (index === 0 && sections.length === 0) {
            throw new OpError("UI_NOT_READY", `the inspection panel showed nothing Figloo can read for layer ${row.id}; Figma may have changed it`);
          }
          const shownExports = switched ? exportSection(core.doc) : null;
          const exportsUnreadable = shownExports !== null && unreadableExportRows(shownExports) > 0;
          collect();
          // The mirror does not place text layers.
          if (row.type !== "Text" && !rects.has(row.id) && (await source.settle(() => source.mirrorRects().has(row.id), SNAPSHOT_MIRROR_WAIT_MS))) collect();
          if (!pause.hidSince(mark)) {
            durations.push(Date.now() - layerStarted);
            // The root read again by a later call is not a new layer.
            if (index > 0 || start === 0) fresh += 1;
            return { layer, sections, exports: switched && !exportsUnreadable ? designerExports(core.doc, row.name) : null, exportsUnreadable };
          }
          await pause.untilVisible();
        }
      };
      // Only a resumable read stops early, while there is still time to close what the walk opened and to answer.
      const timeIsUp = () => Date.now() > deadline - SNAPSHOT_RESERVE_MS - COLLAPSE_MS_PER_ROW * tree.expandedCount();
      const { read, stoppedAt } = await readInTurn(indexes, readOne, { canStop: params.resume !== undefined, timeIsUp });
      if (stoppedAt !== null && fresh === 0) throw new OpError("BUDGET_EXCEEDED", "the snapshot ran out of time before it could read a layer");
      overlay.update({ phase: "finishing" });
      return {
        status: stoppedAt === null ? ("complete" as const) : ("partial" as const),
        read,
        rects,
        walkMs,
        zoomLabel: parseZoom(source.zoomLabel()),
        start,
        walked,
        restarted,
        // A row's color alone can miss a layer inside a hidden one, so hidden parents count too, read in this call or not.
        hidden: hiddenLayers(walk.layers),
      };
    },
    async (tree, source) => {
      restored = await core.restoreSelection(tree, source, before);
    },
    { timeBudgetMs: params.timeBudgetMs, maxUiOps: SNAPSHOT_UI_OPS_PER_LAYER * params.maxLayers, collapseAfterInterrupt: true, overlay, pause },
  )
    .finally(() => {
      overlay.remove();
      pause.dispose();
    })
    .catch(async (error: unknown) => {
      await viewBack();
      throw error;
    });
  const viewRestored = await viewBack();
  const { value, uiOps, elapsedMs } = ran;
  if (value.status === "too_large") {
    return {
      status: "too_large",
      identity,
      maxLayers: params.maxLayers,
      children: value.children.map((row) => core.toNode(row)),
      childrenHasMore: value.childrenHasMore,
      userSelectionRestored: restored,
      viewRestored,
      uiOps,
      elapsedMs,
    };
  }
  const measures = value.read.map(({ layer, sections }) => {
    const box = boxOf(sections);
    // A rotated layer's Top and Left are where its origin went, not the corner of what shows on screen.
    const rotated = sections.some((section) => section.properties.some((p) => p.group === null && p.name === "Rotation"));
    return { id: layer.row.id, parentId: layer.parentRef, type: layer.row.type, rect: value.rects.get(layer.row.id) ?? null, box: box && rotated ? { ...box, position: null } : box };
  });
  const root = measures[0]!;
  // The root's width on screen over its width in the panel, as for visual neighbors.
  const zoom = chooseZoom(root.rect && root.box ? root.rect.width / root.box.width : null, value.zoomLabel);
  const rootOnScreen = root.rect && root.rect.width > 0 && root.rect.height > 0 ? root.rect : null;
  // Layers read now may sit in frames earlier calls placed.
  const bounds = boundsInRoot(measures, zoom, value.start > 0 ? (params.resume?.placed ?? []) : []);
  const own = value.start > 0 ? value.read.slice(1) : value.read;
  const layers: SnapshotLayer[] = own.map(({ layer: { row, parentRef, depth }, sections, exports, exportsUnreadable }) => ({
    ref: row.id,
    name: row.name.slice(0, MAX_NAME_LENGTH),
    type: row.type,
    depth,
    parentRef,
    position: row.position,
    siblingCount: row.setSize,
    hasChildren: row.hasChildren,
    hidden: value.hidden.has(row.id),
    bounds: bounds.get(row.id)!,
    sections,
    exports,
    ...(exportsUnreadable ? { exportsUnreadable } : {}),
  }));
  return {
    status: value.status,
    identity,
    layers,
    readFrom: value.start,
    walked: value.walked,
    restarted: value.restarted,
    rootPath,
    rootOnScreen,
    zoom,
    walkMs: value.walkMs,
    userSelectionRestored: restored,
    viewRestored,
    uiOps,
    elapsedMs,
  };
}

/**
 * The export settings the panel shows for a layer once it has switched to it; in Arc on 2026-10-01
 * they did not change any more after that. A layer without settings keeps the previous layer's
 * button label, so settings count as this layer's only under a button that names it.
 */
function designerExports(doc: Document, name: string): string[] | null {
  const section = exportSection(doc);
  const settings = section ? exportSettings(section) : [];
  return settings.length === 0 || (section !== null && exportsLayer(section, name)) ? settings : null;
}
