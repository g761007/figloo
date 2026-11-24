import type { CanvasView, CaptureParams, ExplorePageParams, ExportParams, InspectParams, ListNeighborsParams, ReadSubtreeParams, SurveyParams, VisualNeighborsParams } from "@figloo/protocol";
import { finishCapture, prepareCapture, putViewBackNow } from "./capture-ops.js";
import { ExplorerCore } from "./explorer-core.js";
import { finishExport, prepareExport } from "./export-ops.js";
import { inspectNodes, visualNeighbors } from "./inspect-ops.js";
import { explorePage, getAnchor, listNeighbors, listPages } from "./navigation-ops.js";
import { readSubtree } from "./snapshot-ops.js";
import { surveyFrames } from "./survey-ops.js";

export { OpError } from "./operation.js";

/** Runs exploration requests inside one Figma page and remembers what it read about layers. */
export class Explorer extends ExplorerCore {
  getAnchor() {
    return getAnchor(this);
  }

  listPages() {
    return listPages(this);
  }

  explorePage(params: ExplorePageParams) {
    return explorePage(this, params);
  }

  listNeighbors(params: ListNeighborsParams) {
    return listNeighbors(this, params);
  }

  inspectNodes(params: InspectParams) {
    return inspectNodes(this, params);
  }

  visualNeighbors(params: VisualNeighborsParams) {
    return visualNeighbors(this, params);
  }

  prepareCapture(params: CaptureParams) {
    return prepareCapture(this, params);
  }

  finishCapture(token: string, keepView = false) {
    return finishCapture(this, token, keepView);
  }

  putViewBackNow(view: CanvasView | null) {
    return putViewBackNow(this, view);
  }

  readSubtree(params: ReadSubtreeParams) {
    return readSubtree(this, params);
  }

  surveyFrames(params: SurveyParams) {
    return surveyFrames(this, params);
  }

  prepareExport(params: ExportParams) {
    return prepareExport(this, params);
  }

  finishExport(token: string, expected: number, waitMs: number) {
    return finishExport(this, token, expected, waitMs);
  }
}
