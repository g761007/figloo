import type { ExportFormat, ExportScale } from "@figloo/protocol";
import { synthesizeClick } from "./dom-source.js";

/** One export setting row: its element and what it currently exports. */
export interface ExportRow {
  element: Element;
  format: string | null;
  scale: string | null;
}

export function exportSection(root: ParentNode): Element | null {
  return root.querySelector('[data-testid="export-inspection-panel"]');
}

const SCALE_INPUT = 'input[aria-label^="Export constraints"]';
/** The file type control: a select button since October 2026, before that a listbox marked as legacy. */
const FORMAT_SELECT = 'button[role="combobox"][aria-haspopup="listbox"]';
const LEGACY_FORMAT = '[data-testid="legacy-export-file-type-input"]';

/** The file type a control or option shows, named as the tools name it: the select calls JPG JPEG. */
function formatName(text: string | null | undefined): string | null {
  const name = text?.trim() || null;
  return name === "JPEG" ? "JPG" : name;
}

const rowFormat = (row: Element | null | undefined) => formatName(row?.querySelector(`${FORMAT_SELECT}, ${LEGACY_FORMAT}`)?.textContent);

/** Rows are told by their scale field, which both file type controls sit next to. */
export function exportRows(section: Element): ExportRow[] {
  return [...section.querySelectorAll('[role="row"]')]
    .filter((row) => row.querySelector(SCALE_INPUT))
    .map((row) => ({
      element: row,
      format: rowFormat(row),
      scale: row.querySelector<HTMLInputElement>(SCALE_INPUT)?.value || null,
    }));
}

/** The button that exports every setting row, labelled "Export <layer name>". */
export function exportButton(section: Element): HTMLButtonElement | null {
  return [...section.querySelectorAll("button")].find((button) => /^Export ./.test(button.textContent?.trim() ?? "")) ?? null;
}

/** Whether the Export button names this layer. A layer without settings keeps the previous layer's label. */
export function exportsLayer(section: Element, layerName: string): boolean {
  const label = exportButton(section)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  return label.slice("Export ".length).includes(layerName.replace(/\s+/g, " ").trim().slice(0, 16));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await sleep(40);
  }
  return true;
}

function visibleOption(selector: string, text: string, name: (el: Element) => string | null | undefined = (el) => el.textContent?.trim()): Element | undefined {
  return [...document.querySelectorAll(selector)].find((el) => name(el) === text && el.getBoundingClientRect().width > 0);
}

/** What a setting row exports, such as "PNG 2x". */
const settingOf = (row: ExportRow) => `${row.format ?? "?"} ${row.scale ?? "?"}`;

export function exportSettings(section: Element): string[] {
  return exportRows(section).map(settingOf);
}

/**
 * Setting rows Figloo cannot fully read: rows with a field or a file type control in which it does
 * not find the scale or the file type, such as after Figma changed the controls in October 2026.
 */
export function unreadableExportRows(section: Element): number {
  return [...section.querySelectorAll('[role="row"]')].filter(
    (row) => row.querySelector(`input, ${FORMAT_SELECT}, ${LEGACY_FORMAT}`) && (!row.querySelector<HTMLInputElement>(SCALE_INPUT)?.value || rowFormat(row) === null),
  ).length;
}

/**
 * Where the row that is not among `original` is. Figma puts a new setting first and renders every
 * row again after each change, so the new row is found by what the rows export, not by element.
 */
function extraIndex(section: Element, original: string[]): number {
  const left = [...original];
  return exportRows(section).findIndex((row) => {
    const at = left.indexOf(settingOf(row));
    if (at < 0) return true;
    left.splice(at, 1);
    return false;
  });
}

const sameSettings = (a: string[], b: string[]) => [...a].sort().join("|") === [...b].sort().join("|");

/** Adds a setting for `format` at `scale` next to the `original` ones; returns why it failed, or null. */
export async function addTemporarySetting(section: Element, original: string[], format: ExportFormat, scale: ExportScale): Promise<string | null> {
  const add = section.querySelector('button[aria-label="Add export settings"]');
  if (!add) return "Figma shows no button to add an export setting";
  const anyRows = () => section.querySelectorAll('[role="row"]').length;
  const rowsBefore = anyRows();
  synthesizeClick(add);
  if (!(await until(() => exportRows(section).length > original.length))) {
    // Figloo cannot remove a setting it cannot read, so the user has to.
    if (anyRows() > rowsBefore) return "Figma added an export setting, but Figloo cannot read Figma's export section, which may have changed; remove the new setting in Figma's Export section";
    return "Figma did not add an export setting";
  }
  // Follow the new row by position: while it is being set up it can export the same as another row.
  // Every step checks that the other rows still export what they did, so no other row is changed.
  const index = extraIndex(section, original);
  const temporary = () => {
    const rows = exportRows(section);
    const others = rows.filter((_, at) => at !== index).map(settingOf);
    return rows.length === original.length + 1 && sameSettings(others, original) ? (rows[index]?.element ?? null) : null;
  };
  // Next to other settings, opening a new setting's legacy format menu first leaves it marked open with no
  // options until the setting is removed. Choosing its scale first, even the one it has, avoids that.
  // A new setting also starts at the smallest scale the others do not use, so this is needed anyway.
  if (!(await setExportScale(temporary, scale, true))) return `Figma did not switch the export scale to ${scale}`;
  if (!(await setExportFormat(temporary, format))) return `Figma did not switch the export format to ${format}`;
  // A format change can reset the scale.
  if (!(await setExportScale(temporary, scale))) return `Figma did not switch the export scale to ${scale}`;
  return null;
}

/** Removes the one setting that is not among `original`, so the layer's own settings stay as they were. */
export async function removeTemporarySetting(section: Element, original: string[]): Promise<boolean> {
  const at = extraIndex(section, original);
  if (at < 0) return exportRows(section).length === original.length;
  const remove = exportRows(section)[at]!.element.querySelector('button[aria-label="Remove"]');
  if (!remove) return false;
  synthesizeClick(remove);
  return until(() => exportRows(section).length === original.length);
}

/** The select opens on a click; the legacy control only from the keyboard, with Space on its listbox. */
async function setExportFormat(row: () => Element | null, format: ExportFormat): Promise<boolean> {
  const label = format.toUpperCase();
  const current = () => rowFormat(row());
  if (current() === label) return true;
  const select = row()?.querySelector(FORMAT_SELECT);
  const listbox = row()?.querySelector<HTMLElement>('[role="listbox"][aria-label="Export file type"]');
  if (select) {
    synthesizeClick(select);
  } else if (listbox) {
    listbox.focus();
    const init = { key: " ", code: "Space", keyCode: 32, which: 32, bubbles: true, cancelable: true, composed: true };
    listbox.dispatchEvent(new KeyboardEvent("keydown", init));
    listbox.dispatchEvent(new KeyboardEvent("keyup", init));
  } else {
    return false;
  }
  const option = () => visibleOption('[role="option"]', label, (el) => formatName(el.textContent));
  if (!(await until(() => option() !== undefined))) return false;
  synthesizeClick(option()!);
  await until(() => option() === undefined);
  return until(() => current() === label);
}

/** Scale presets come from the menu next to the scale field; `always` picks one even when it is set. */
async function setExportScale(row: () => Element | null, scale: ExportScale, always = false): Promise<boolean> {
  const input = () => row()?.querySelector<HTMLInputElement>(SCALE_INPUT);
  if (!always && input()?.value === scale) return true;
  const menu = row()?.querySelector('button[aria-label="Select an option"]');
  if (!menu) return false;
  synthesizeClick(menu);
  const items = '[role="menuitem"], [role="menuitemradio"], [role="option"]';
  if (!(await until(() => visibleOption(items, scale) !== undefined))) return false;
  synthesizeClick(visibleOption(items, scale)!);
  // The menu closes a moment later, and a format menu opened before that shows no options.
  await until(() => visibleOption(items, scale) === undefined);
  return until(() => input()?.value === scale);
}

