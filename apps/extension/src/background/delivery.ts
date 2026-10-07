import { CapturePlanSchema, ExportFinishSchema, ExportPlanSchema, MAX_SNAPSHOT_LAYERS, SNAPSHOT_TIME_BUDGET_MS, SnapshotParamsSchema, SnapshotReadResultSchema, TabOpResponseSchema, type CapturePlan, type CaptureResult, type ImageAlignment, type Rect, type TabOpResponse } from "@figloo/protocol";
import { CAPTURE_MARGIN_PX, alignCapture, cropCapture, insideImage, intersect, inflate, placeInImage } from "../capture.js";
import { installExportCapture, removeExportCapture } from "../export-capture.js";
import { server } from "./connection.js";

/** How long the page hook waits for Figma to hand over the exported files. */
const EXPORT_CAPTURE_WAIT_MS = 8_000;
/** How long a browser download may take before the export is reported as pending. */
const EXPORT_DOWNLOAD_WAIT_MS = 30_000;

/**
 * Exports a layer. First choice: a short-lived hook in the page's main world receives the files
 * Figma produces, so nothing reaches the download folder. Fallback: when nothing was captured, the
 * browser's own download of the file is used and its path is reported.
 */
export async function exportTab(tabId: number, params: unknown): Promise<TabOpResponse> {
  const started = Date.now();
  const token = crypto.randomUUID();
  const downloads: number[] = [];
  const onCreated = (item: chrome.downloads.DownloadItem) => {
    const fromFigma = item.url.startsWith("blob:https://www.figma.com/") || item.url.startsWith("data:") || (item.referrer ?? "").startsWith("https://www.figma.com/");
    if (fromFigma && Date.parse(item.startTime) >= started - 1_000) downloads.push(item.id);
  };
  chrome.downloads.onCreated.addListener(onCreated);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: installExportCapture, args: [token, EXPORT_CAPTURE_WAIT_MS + 20_000] });
    const prepared = await sendToTab(tabId, "prepare_export", { ...(params as object), token });
    if (!prepared.ok) return prepared;
    const plan = ExportPlanSchema.parse(prepared.result);
    const finished = await sendToTab(tabId, "finish_export", { token, expected: plan.settings.length, waitMs: EXPORT_CAPTURE_WAIT_MS });
    if (!finished.ok) return finished;
    const { files, notes, userSelectionRestored } = ExportFinishSchema.parse(finished.result);
    // The MCP server opens any ZIP and keeps only plan.onlyFormat at the requested scale, so every file goes along as is.
    const base = { identity: plan.identity, onlyFormat: plan.onlyFormat, settings: plan.settings, usedExistingSettings: !plan.temporary, userSelectionRestored };
    if (files.length > 0) {
      return { ok: true, result: { ...base, source: "direct", files: files.map((f) => ({ ...f, downloadPath: null })), elapsedMs: Date.now() - started } };
    }
    for (let waited = 0; downloads.length === 0 && waited < 3_000; waited += 200) await delay(200);
    if (downloads.length === 0) {
      // What the page hook saw tells a layer Figma does not export apart from a file handed over another way.
      const seen = notes.length > 0 ? `Figma made ${notes.join("; ")}` : "Figma made no Blob and clicked no download link";
      return { ok: false, error: { code: "EXPORT_BLOCKED", message: `Figma produced no file that Figloo could receive, and the browser started no download; ${seen}` } };
    }
    const items = await Promise.all(downloads.map((id) => waitForDownload(id, EXPORT_DOWNLOAD_WAIT_MS)));
    if (items.some((item) => !item || item.state === "in_progress")) {
      return { ok: false, error: { code: "EXPORT_PENDING", message: "the browser is still waiting to save the export, possibly for a confirmation" } };
    }
    const saved = items.filter((item): item is chrome.downloads.DownloadItem => item?.state === "complete" && item.filename.length > 0);
    if (saved.length === 0) return { ok: false, error: { code: "EXPORT_BLOCKED", message: "the browser did not complete the export download" } };
    return {
      ok: true,
      result: {
        ...base,
        source: "download",
        files: saved.map((item) => ({ name: item.filename.split("/").pop() ?? item.filename, mimeType: item.mime, data: null, downloadPath: item.filename })),
        elapsedMs: Date.now() - started,
      },
    };
  } catch (error) {
    await sendToTab(tabId, "finish_export", { token, expected: 0, waitMs: 0 });
    return { ok: false, error: { code: "INTERNAL", message: `export failed: ${error instanceof Error ? error.message : String(error)}` } };
  } finally {
    chrome.downloads.onCreated.removeListener(onCreated);
    await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: removeExportCapture, args: [token] }).catch(() => undefined);
  }
}

async function waitForDownload(id: number, timeoutMs: number): Promise<chrome.downloads.DownloadItem | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [item] = await chrome.downloads.search({ id });
    if (!item || item.state !== "in_progress" || Date.now() >= deadline) return item;
    await delay(200);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendToTab(tabId: number, op: string, params: unknown): Promise<TabOpResponse> {
  try {
    return TabOpResponseSchema.parse(await chrome.tabs.sendMessage(tabId, { type: "figloo:op", op, params }));
  } catch {
    return { ok: false, error: { code: "UI_NOT_READY", message: "the Figloo content script is not running in this tab; reload the tab" } };
  }
}

/**
 * The tab moves its view to the target and clears the selection; the worker captures what is on
 * screen, crops it to the target, and the tab then puts the user's selection and view back.
 */
export async function captureTab(tabId: number, params: unknown): Promise<TabOpResponse> {
  return (await takeCapture(tabId, params)).response;
}

/**
 * A capture, whether the user stepped in before their selection could be put back, and the whole
 * screenshot with the plan it was taken by, for a snapshot to check the crop against. With
 * `keepView`, the view stays where the capture took it, for a snapshot to read there.
 */
async function takeCapture(
  tabId: number,
  params: unknown,
  keepView = false,
): Promise<{ response: TabOpResponse; interrupted: boolean; dataUrl?: string; plan?: CapturePlan }> {
  const started = Date.now();
  // Read the tab again: it may have changed while this request waited in the queue.
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const window = tab ? await chrome.windows.get(tab.windowId).catch(() => null) : null;
  if (!tab || !tab.active || !window || window.state === "minimized") {
    return { response: { ok: false, error: { code: "TAB_IN_BACKGROUND", message: "the Figma tab must be the visible tab of its window to capture it" } }, interrupted: false };
  }
  const prepared = await sendToTab(tabId, "prepare_capture", params);
  if (!prepared.ok) return { response: prepared, interrupted: false };
  const plan = CapturePlanSchema.parse(prepared.result);
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const { crop, ...image } = await cropCapture(dataUrl, plan.crop, plan.viewport);
    const finished = await sendToTab(tabId, "finish_capture", { token: plan.token, keepView });
    const done = finished.ok ? (finished.result as { userSelectionRestored?: boolean; viewRestored?: boolean; interrupted?: boolean } | undefined) : undefined;
    const result: CaptureResult = {
      identity: plan.identity,
      image: { ...image, mimeType: "image/jpeg" },
      crop,
      cropSource: plan.cropSource,
      zoom: plan.zoom,
      userSelectionRestored: done?.userSelectionRestored === true,
      viewRestored: done?.viewRestored === true,
      elapsedMs: Date.now() - started,
    };
    return { response: { ok: true, result }, interrupted: done?.interrupted === true, dataUrl, plan };
  } catch (error) {
    await sendToTab(tabId, "finish_capture", { token: plan.token, keepView: false });
    return { response: { ok: false, error: { code: "INTERNAL", message: `capture failed: ${error instanceof Error ? error.message : String(error)}` } }, interrupted: false };
  }
}

/**
 * Kept back from a snapshot's time budget: when reading runs out of time, the tab still closes what
 * it opened and puts the selection back, which took about 5 s in Arc, and the reply has to arrive.
 */
const SNAPSHOT_CLEANUP_MS = 15_000;

/**
 * Captures the root zoomed to fit the screen, then has the tab read every layer below it without
 * moving the view, so each layer's place on screen can be found in the screenshot. The tab puts
 * the user's view back once it is done.
 */
export async function snapshotTab(tabId: number, params: unknown): Promise<TabOpResponse> {
  const started = Date.now();
  const { expect, ref, known, resume, timeBudgetMs: shorter } = SnapshotParamsSchema.parse(params);
  const shot = await takeCapture(tabId, { expect, ref, known }, true);
  if (!shot.response.ok) return shot.response;
  if (shot.interrupted) return { ok: false, error: { code: "USER_INTERRUPTED", message: "the user interacted with Figma during the screenshot" } };
  let { image, crop } = shot.response.result as CaptureResult;
  const timeBudgetMs = Math.round((shorter ?? SNAPSHOT_TIME_BUDGET_MS) - SNAPSHOT_CLEANUP_MS - (Date.now() - started));
  if (timeBudgetMs <= 0) return { ok: false, error: { code: "BUDGET_EXCEEDED", message: "the screenshot used up the snapshot's time budget" } };
  const view = shot.plan?.view ?? null;
  const read = await sendToTab(tabId, "read_subtree", { expect, ref, known, ...(resume ? { resume } : {}), maxLayers: MAX_SNAPSHOT_LAYERS, timeBudgetMs, view });
  if (!read.ok) return read;
  const result = SnapshotReadResultSchema.parse(read.result);
  const elapsedMs = Date.now() - started;
  if (result.status === "too_large") return { ok: true, result: { ...result, elapsedMs } };
  // The mirror can keep a stale place for the root, so the screenshot itself says where the root is.
  let root: Rect | null = result.rootOnScreen;
  let alignment: ImageAlignment = "unconfirmed";
  if (root && shot.dataUrl && shot.plan) {
    const aligned = await alignCapture(shot.dataUrl, root, shot.plan.viewport);
    ({ root, alignment } = aligned);
    const recrop = alignment === "corrected" ? intersect(inflate(aligned.root, CAPTURE_MARGIN_PX), shot.plan.canvas) : null;
    if (recrop) {
      const { crop: shown, ...cropped } = await cropCapture(shot.dataUrl, recrop, shot.plan.viewport);
      image = { ...cropped, mimeType: "image/jpeg" };
      crop = shown;
    }
  }
  const rootInImage = root ? placeInImage(root, crop, image) : null;
  // The read measures the root where the screenshot was taken; a root outside the image means the view moved in between.
  // A call that goes on with a snapshot keeps the first call's screenshot, so its own does not matter.
  const keepsImage = result.readFrom === 0;
  if (keepsImage && rootInImage && !insideImage(rootInImage, image)) {
    return { ok: false, error: { code: "UI_NOT_READY", message: "the screenshot does not show the whole root, so the view moved while it was taken; take the snapshot again" } };
  }
  return {
    ok: true,
    result: {
      ...result,
      image,
      crop,
      rootInImage,
      imageScale: result.zoom ? (image.width / crop.width) * result.zoom : null,
      alignment,
      elapsedMs,
    },
  };
}
