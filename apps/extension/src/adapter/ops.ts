import type { CanvasView, CaptureParams, ExplorePageParams, ExportParams, InspectParams, ListNeighborsParams, ReadSubtreeParams, SurveyParams, VisualNeighborsParams } from "@figloo/protocol";
import { finishCapture, prepareCapture, putViewBackNow } from "./capture-ops.js";
import { ExplorerCore } from "./explorer-core.js";
import { finishExport, prepareExport } from "./export-ops.js";
import { inspectNodes, visualNeighbors } from "./inspect-ops.js";
import { explorePage, getAnchor, listNeighbors, listPages } from "./navigation-ops.js";
import { readSubtree } from "./snapshot-ops.js";
import { surveyFrames } from "./survey-ops.js";

export { OpError } from "./operation.js";

/**
 * Runs exploration requests inside one Figma page and remembers what it read about layers. Every
 * operation that clicks, scrolls, or presses keys in Figma runs with the page locked; the steps
 * that put things back run even after Stop. Reading the pages list changes nothing and stays open.
 */
export class Explorer extends ExplorerCore {
  getAnchor() {
    return this.locked(() => getAnchor(this));
  }

  listPages() {
    return listPages(this);
  }

  explorePage(params: ExplorePageParams) {
    return this.locked(() => explorePage(this, params));
  }

  listNeighbors(params: ListNeighborsParams) {
    return this.locked(() => listNeighbors(this, params));
  }

  inspectNodes(params: InspectParams) {
    return this.locked(() => inspectNodes(this, params));
  }

  visualNeighbors(params: VisualNeighborsParams) {
    return this.locked(() => visualNeighbors(this, params));
  }

  prepareCapture(params: CaptureParams) {
    return this.locked(() => prepareCapture(this, params));
  }

  finishCapture(token: string, keepView = false) {
    return this.holding(() => finishCapture(this, token, keepView));
  }

  putViewBackNow(view: CanvasView | null) {
    return this.holding(() => putViewBackNow(this, view));
  }

  /** Follows a capture that kept the view zoomed, so after Stop it still runs to put the view back. */
  readSubtree(params: ReadSubtreeParams) {
    return this.holding(() => readSubtree(this, params));
  }

  surveyFrames(params: SurveyParams) {
    return this.locked(() => surveyFrames(this, params));
  }

  prepareExport(params: ExportParams) {
    return this.locked(() => prepareExport(this, params));
  }

  finishExport(token: string, expected: number, waitMs: number) {
    return this.holding(() => finishExport(this, token, expected, waitMs));
  }
}
