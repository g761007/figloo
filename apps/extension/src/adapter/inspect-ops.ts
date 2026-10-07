import type { InspectGroup, InspectParams, InspectResult, InspectedNode, Rect, VisualNeighbor, VisualNeighborsParams, VisualNeighborsResult } from "@figloo/protocol";
import { MAX_NEIGHBOR_LIMIT } from "@figloo/protocol";
import type { ExplorerCore } from "./explorer-core.js";
import { placeSiblings, type LayerBox, type Measured } from "./geometry.js";
import { inspectionRoot, inspectionSignature, layerBox, readInspection } from "./inspect.js";
import { BACKGROUND_MESSAGE, MAX_NAME_LENGTH, OpError, parseZoom, type UserSelection } from "./operation.js";
import type { Row } from "./row.js";
import { learnParents } from "./tree.js";

const ALL_GROUPS: InspectGroup[] = ["layout", "appearance", "typography", "component"];

const MIRROR_MESSAGE =
  "Figma shows where layers are on screen only with Adapt content for screen readers turned on (Main menu, Preferences, Accessibility settings)";

export async function inspectNodes(core: ExplorerCore, params: InspectParams): Promise<InspectResult> {
  const identity = core.checkExpected(params.expect);
  learnParents(core.index, params.known ?? []);
  if (core.doc.hidden) throw new OpError("TAB_IN_BACKGROUND", BACKGROUND_MESSAGE);
  await core.showInspectionPanel();
  const groups = params.groups ?? ALL_GROUPS;
  let before: UserSelection = { kind: "none" };
  let restored = false;
  const { value, uiOps, elapsedMs } = await core.run(
    async (tree, source) => {
      before = await core.userSelection(tree);
      const nodes: InspectedNode[] = [];
      for (const ref of params.refs) {
        tree.check();
        const row = await tree.find(ref);
        if (!row) throw new OpError("NODE_NOT_FOUND", `layer ${ref} is no longer in the layers panel`);
        const previous = inspectionSignature(core.doc);
        if (!(await source.select(row))) throw new OpError("UI_NOT_READY", `Figma did not select layer ${ref}; guest sessions cannot select layers`);
        await core.waitForPanel(row, previous, source);
        const sections = readInspection(inspectionRoot(core.doc) ?? core.doc).filter((section) =>
          section.group === "other" ? params.groups === undefined : groups.includes(section.group),
        );
        const shown = new Set(sections.map((section) => section.group));
        nodes.push({ ref, name: row.name.slice(0, MAX_NAME_LENGTH), type: row.type, sections, notShown: groups.filter((group) => !shown.has(group)) });
      }
      return nodes;
    },
    async (tree, source) => {
      restored = await core.restoreSelection(tree, source, before);
    },
  );
  return { identity, nodes: value, userSelectionRestored: restored, uiOps, elapsedMs };
}

/**
 * Places the siblings of a layer by where they are on screen. Figma's screen reader mirror only
 * places the selected layer, its neighbours in layer order, its parent, and its first child, so
 * every third sibling is selected in turn. The user's selection is put back afterwards.
 */
export async function visualNeighbors(core: ExplorerCore, params: VisualNeighborsParams): Promise<VisualNeighborsResult> {
  const identity = core.checkExpected(params.expect);
  learnParents(core.index, params.known ?? []);
  if (core.doc.hidden) throw new OpError("TAB_IN_BACKGROUND", BACKGROUND_MESSAGE);
  await core.showPropertiesTab();
  let before: UserSelection = { kind: "none" };
  let restored = false;
  const { value, uiOps, elapsedMs } = await core.run(
    async (tree, source) => {
      if (!source.hasMirror()) throw new OpError("UI_NOT_READY", MIRROR_MESSAGE);
      before = await core.userSelection(tree);
      const row = await tree.find(params.ref);
      if (!row) throw new OpError("NODE_NOT_FOUND", `layer ${params.ref} is no longer in the layers panel`);
      const page = await tree.siblingsPage(row, 1, MAX_NEIGHBOR_LIMIT);
      const list = page.rows;
      const siblingsHasMore = page.hasMore;
      const rects = new Map<string, Rect>();
      const boxes = new Map<string, LayerBox>();
      // The mirror places frames, groups, shapes, and instances, but not text layers.
      const isText = (layer: Row) => layer.type === "Text";
      const select = async (target: Row): Promise<void> => {
        tree.check();
        const shown = (await tree.find(target.id)) ?? target;
        const previous = inspectionSignature(core.doc);
        if (!(await source.select(shown))) throw new OpError("UI_NOT_READY", `Figma did not select layer ${target.id}`);
        if (!isText(target)) {
          await source.settle(() => source.mirrorRect(target.id) !== null);
          for (const [id, rect] of source.mirrorRects()) rects.set(id, rect);
        }
        const inPanel = await core.waitForPanel(shown, previous, source).then(() => true).catch(() => false);
        const box = inPanel ? layerBox(core.doc) : null;
        if (box) boxes.set(target.id, box);
      };
      await select(row);
      // Selecting a layer also places its neighbours in layer order, so pick the next one when it can.
      for (let i = 0; i < list.length; i += 1) {
        const sibling = list[i]!;
        if (sibling.id === row.id || isText(sibling) || rects.has(sibling.id)) continue;
        const next = list[i + 1];
        await select(next && next.id !== row.id && !isText(next) ? next : sibling);
      }
      // Text layers get their position from the panel.
      for (const sibling of list) {
        if (sibling.id !== row.id && isText(sibling) && !boxes.has(sibling.id)) await select(sibling);
      }
      return { row, list, rects, boxes, siblingsHasMore, zoomLabel: parseZoom(source.zoomLabel()) };
    },
    async (tree, source) => {
      restored = await core.restoreSelection(tree, source, before);
    },
  );
  const measured = (layer: Row): Measured => ({ id: layer.id, rect: value.rects.get(layer.id) ?? null, box: value.boxes.get(layer.id) ?? null });
  const others = value.list.filter((layer) => layer.id !== value.row.id);
  const result = placeSiblings(measured(value.row), others.map(measured), value.zoomLabel);
  if (!result.reference) {
    throw new OpError("UI_NOT_READY", `Figma shows no position for layer ${params.ref}: it may be hidden, or a text layer placed by auto layout`);
  }
  const byId = new Map(others.map((layer) => [layer.id, layer]));
  const placed: VisualNeighbor[] = result.placed.map(({ id, placement }) => ({ ...core.toNode(byId.get(id)!), ...placement }));
  const nearest = params.direction === "nearest";
  const wanted = nearest ? placed : placed.filter((neighbor) => neighbor.side === params.direction);
  // For a direction, layers in the same row or column come before those off to a diagonal.
  wanted.sort(nearest ? (a, b) => a.gap - b.gap : (a, b) => Number(b.inLine) - Number(a.inLine) || a.gap - b.gap);
  return {
    identity,
    reference: { width: Math.round(result.reference.width * 10) / 10, height: Math.round(result.reference.height * 10) / 10 },
    zoom: result.zoom === null ? null : Math.round(result.zoom * 10_000) / 10_000,
    neighbors: wanted.slice(0, params.limit),
    compared: placed.length,
    unplaced: result.unplaced,
    siblingsHasMore: value.siblingsHasMore,
    userSelectionRestored: restored,
    uiOps,
    elapsedMs,
  };
}
