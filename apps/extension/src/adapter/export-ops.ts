import type { CapturedFile, ExportParams, ExportPlan } from "@figloo/protocol";
import { synthesizeClick } from "./dom-source.js";
import type { ExplorerCore } from "./explorer-core.js";
import { addTemporarySetting, exportButton, exportRows, exportSection, exportSettings, exportsLayer, removeTemporarySetting, unreadableExportRows } from "./export.js";
import { inspectionSignature } from "./inspect.js";
import { BACKGROUND_MESSAGE, MAX_NAME_LENGTH, OpError, sleep, watchForUser, type UserSelection, type UserWatch } from "./operation.js";
import { learnParents } from "./tree.js";

export interface PendingExport {
  token: string;
  files: CapturedFile[];
  /** How Figma tried to hand files over, from the page hook. */
  notes: string[];
  onMessage: (event: MessageEvent) => void;
  before: UserSelection;
  /** What the layer's own settings export, such as "PNG 2x", before Figloo added its temporary one. */
  original: string[];
  temporary: boolean;
  user: UserWatch;
  timer: ReturnType<typeof setTimeout>;
}

/** An export that never finishes cleans up on its own after this long. */
const PENDING_EXPORT_TIMEOUT_MS = 30_000;
/** Notes kept per export about how Figma tried to hand files over. */
const MAX_EXPORT_NOTES = 20;

/**
 * Exports a layer through the inspection panel's Export button. Without an explicit format and with
 * settings of its own, the layer exports as the designer set it up; otherwise a temporary setting is
 * added and removed again in finishExport. Files captured in the page arrive as window messages.
 */
export async function prepareExport(core: ExplorerCore, params: ExportParams): Promise<ExportPlan> {
  const identity = core.checkExpected(params.expect);
  learnParents(core.index, params.known ?? []);
  if (core.doc.hidden) throw new OpError("TAB_IN_BACKGROUND", BACKGROUND_MESSAGE);
  await core.showInspectionPanel();
  if (core.pendingExport) await finishExport(core, core.pendingExport.token, 0, 0);
  const files: CapturedFile[] = [];
  const notes: string[] = [];
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { __figlooExport?: string; __figlooExportNote?: string; note?: unknown; name?: unknown; type?: unknown; data?: unknown } | null;
    if (event.source === core.win && data?.__figlooExportNote === params.token && notes.length < MAX_EXPORT_NOTES) notes.push(String(data.note).slice(0, 120));
    if (event.source !== core.win || !data || data.__figlooExport !== params.token || !(data.data instanceof ArrayBuffer)) return;
    files.push({ name: String(data.name || "export"), mimeType: String(data.type || "application/octet-stream"), data: toBase64(data.data) });
  };
  core.win.addEventListener("message", onMessage);
  let before: UserSelection = { kind: "none" };
  let original: string[] = [];
  let temporary = false;
  try {
    const { value } = await core.run(async (tree, source) => {
      before = await core.userSelection(tree);
      try {
        const row = await tree.find(params.ref);
        if (!row) throw new OpError("NODE_NOT_FOUND", `layer ${params.ref} is no longer in the layers panel`);
        // Figma's Export button does nothing for such a layer, so there is no file to wait for.
        if (row.hidden) throw new OpError("LAYER_HIDDEN", `layer ${params.ref} is hidden in Figma, or inside a hidden layer, and Figma exports nothing for it`);
        const previous = inspectionSignature(core.doc);
        if (!(await source.select(row))) throw new OpError("UI_NOT_READY", `Figma did not select layer ${params.ref}; guest sessions cannot select layers`);
        await core.waitForPanel(row, previous, source);
        // Right after a selection change the section can still list the previous layer's settings.
        // A layer without settings keeps the previous button label, so settings count as this
        // layer's only under a button that names it.
        await source.settle(() => {
          const shown = exportSection(core.doc);
          return shown !== null && (exportRows(shown).length === 0 || exportsLayer(shown, row.name));
        });
        const section = exportSection(core.doc);
        if (!section) throw new OpError("UI_NOT_READY", "the inspection panel does not show an export section for this layer");
        // Exporting would add a setting beside ones Figloo cannot see, and could not take it out again.
        if (unreadableExportRows(section) > 0) {
          throw new OpError("UI_NOT_READY", `Figloo cannot read the export settings Figma shows for layer ${params.ref}, so it changed and exported nothing; Figma may have changed its export section`);
        }
        original = exportSettings(section);
        if (original.length > 0 && !exportsLayer(section, row.name)) throw new OpError("UI_NOT_READY", `the export section did not switch to layer ${params.ref}`);
        // The requested format, or SVG for a layer without settings; a matching setting is reused.
        const format = params.format ?? (original.length === 0 ? "svg" : undefined);
        const scale = params.scale ?? "1x";
        if (format !== undefined && !original.includes(`${format.toUpperCase()} ${scale}`)) {
          temporary = true;
          const failure = await addTemporarySetting(section, original, format, scale);
          if (failure) throw new OpError("UI_NOT_READY", failure);
        }
        const settings = exportRows(section).map(({ format, scale }) => ({ format: format ?? "unknown", scale }));
        // Once the layer has a setting the button names it; a stale label would export another layer.
        if (!(await source.settle(() => exportsLayer(section, row.name)))) {
          throw new OpError("UI_NOT_READY", `the Export button does not name layer ${params.ref}, so Figloo did not click it`);
        }
        const button = exportButton(section);
        if (!button) throw new OpError("UI_NOT_READY", "the inspection panel has no Export button for this layer");
        source.actions += 1;
        synthesizeClick(button);
        return { name: row.name.slice(0, MAX_NAME_LENGTH), settings, temporary, onlyFormat: params.format !== undefined && original.length > 0 ? params.format : null };
      } catch (error) {
        // Leave the layer as it was: drop a half-configured temporary setting and reselect.
        if (temporary) await removeTemporaryRow(core, original);
        await tree.whileRestoring(() => core.restoreSelection(tree, source, before)).catch(() => false);
        throw error;
      }
    });
    core.pendingExport = {
      token: params.token,
      files,
      notes,
      onMessage,
      before,
      original,
      temporary,
      user: watchForUser(core.win),
      timer: setTimeout(() => void finishExport(core, params.token, 0, 0), PENDING_EXPORT_TIMEOUT_MS),
    };
    return { identity, ...value };
  } catch (error) {
    core.win.removeEventListener("message", onMessage);
    throw error;
  }
}

/** Waits up to `waitMs` for `expected` captured files, then removes the temporary setting and reselects. */
export async function finishExport(core: ExplorerCore, token: string, expected: number, waitMs: number): Promise<{ files: CapturedFile[]; notes: string[]; userSelectionRestored: boolean }> {
  const pending = core.pendingExport;
  if (!pending || pending.token !== token) return { files: [], notes: [], userSelectionRestored: false };
  const deadline = Date.now() + waitMs;
  // Figma may pack several files into one ZIP, which then holds all of them.
  const zipped = () => pending.files.some((file) => file.mimeType === "application/zip" || /\.zip$/i.test(file.name));
  while (pending.files.length < expected && !zipped() && Date.now() < deadline && !pending.user.interrupted()) await sleep(100);
  core.pendingExport = null;
  clearTimeout(pending.timer);
  core.win.removeEventListener("message", pending.onMessage);
  pending.user.dispose();
  if (pending.user.interrupted()) return { files: pending.files, notes: pending.notes, userSelectionRestored: false };
  let restored = false;
  await core.run(
    async () => undefined,
    async (tree, source) => {
      if (pending.temporary) await removeTemporaryRow(core, pending.original);
      restored = await core.restoreSelection(tree, source, pending.before);
    },
  );
  return { files: pending.files, notes: pending.notes, userSelectionRestored: restored };
}

async function removeTemporaryRow(core: ExplorerCore, original: string[]): Promise<void> {
  const section = exportSection(core.doc);
  if (section) await removeTemporarySetting(section, original);
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
