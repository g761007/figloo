// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { addTemporarySetting, exportButton, exportRows, exportSection, exportSettings, exportsLayer, removeTemporarySetting, unreadableExportRows } from "../src/adapter/export.js";

function repoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) dir = dirname(dir);
  return dir;
}

/** Figma's file type control: a select button since October 2026, before that a listbox marked as legacy. */
const FIXTURES = {
  select: "tests/fixtures/inspection/export-with-setting-select.html",
  legacy: "tests/fixtures/inspection/export-with-setting.html",
} as const;
type Markup = keyof typeof FIXTURES;
const MARKUPS = Object.keys(FIXTURES) as Markup[];
const fixture = (markup: Markup) => readFileSync(join(repoRoot(), FIXTURES[markup]), "utf8");

describe.each(MARKUPS)("export section on captured Figma markup (%s file type control)", (markup) => {
  const doc = new DOMParser().parseFromString(`<body>${fixture(markup)}</body>`, "text/html");

  it("reads the designer's export setting", () => {
    const section = exportSection(doc)!;
    expect(section).not.toBeNull();
    expect(exportRows(section).map(({ format, scale }) => ({ format, scale }))).toEqual([{ format: "PNG", scale: "2x" }]);
  });

  it("finds the button that exports the layer, not the section title", () => {
    expect(exportButton(exportSection(doc)!)?.textContent?.trim()).toBe("Export Sample frame");
  });

  it("tells whether the button exports the selected layer or one selected before it", () => {
    const section = exportSection(doc)!;
    expect(exportsLayer(section, "Sample frame")).toBe(true);
    expect(exportsLayer(section, "tag_icon")).toBe(false);
  });
});

/**
 * Figma's export section as observed in a view-only file: a new setting goes first, at the smallest
 * scale no other setting uses, and every change renders all rows again as new elements. The select
 * opens on a click and calls JPG JPEG. The legacy listbox opens only with Space, and next to other
 * settings, a new setting's legacy format menu opened before its scale menu, or while the scale menu
 * is still closing, stays marked open with no options for good.
 */
function simulateExportSection(initial: string[], markup: Markup): { section: Element; settings: () => string[]; designerSettingsTouched: () => boolean } {
  document.body.innerHTML = fixture(markup);
  const section = exportSection(document)!;
  const first = exportRows(section)[0]!.element;
  const template = first.cloneNode(true) as Element;
  const container = first.parentElement!;
  let settings = initial.map((setting) => {
    const [format, scale] = setting.split(" ");
    return { format: format!, scale: scale!, fresh: false, stuck: false, designer: true };
  });
  let designerSettingsTouched = false;
  const popup = (role: string, labels: string[], choose: (label: string) => void, closeAfterMs = 0) => {
    for (const label of labels) {
      const item = document.createElement("div");
      item.setAttribute("role", role);
      item.textContent = label;
      item.getBoundingClientRect = () => ({ x: 0, y: 0, width: 40, height: 20, top: 0, left: 0, right: 40, bottom: 20, toJSON: () => ({}) });
      item.addEventListener("click", () => {
        const close = () => document.querySelectorAll(`[role="${role}"]`).forEach((el) => el.remove());
        if (closeAfterMs > 0) setTimeout(close, closeAfterMs);
        else close();
        choose(label);
        render();
      });
      document.body.append(item);
    }
  };
  const render = () => {
    exportRows(section).forEach((row) => row.element.remove());
    settings.forEach((setting, index) => {
      const row = template.cloneNode(true) as Element;
      const input = row.querySelector<HTMLInputElement>('input[aria-label^="Export constraints"]')!;
      input.value = setting.scale;
      input.setAttribute("value", setting.scale);
      const chooseFormat = (format: string) => {
        designerSettingsTouched ||= setting.designer && format !== setting.format;
        setting.format = format;
      };
      if (markup === "select") {
        const select = row.querySelector('[role="combobox"]')!;
        select.querySelector("span")!.textContent = setting.format;
        const selected = row.querySelector('[role="option"][aria-selected="true"]')!;
        selected.querySelector("span")!.textContent = setting.format;
        selected.setAttribute("data-fpl-select-value", setting.format);
        select.addEventListener("click", () => popup("option", ["PNG", "JPEG", "SVG", "PDF"], chooseFormat));
      } else {
        row.querySelector('[data-testid="legacy-export-file-type-input"] span')!.textContent = setting.format;
        const listbox = row.querySelector('[role="listbox"]')!;
        listbox.setAttribute("aria-expanded", String(setting.stuck));
        listbox.addEventListener("keydown", (event) => {
          if ((event as KeyboardEvent).key !== " " || setting.stuck) return;
          const scaleMenuClosing = document.querySelector('[role="menuitem"]') !== null;
          if ((setting.fresh || scaleMenuClosing) && settings.length > 1) {
            setting.stuck = true;
            render();
          } else {
            popup("option", ["PNG", "JPG", "SVG", "PDF"], chooseFormat);
          }
        });
      }
      row.querySelector('button[aria-label="Select an option"]')!.addEventListener("click", () => {
        setting.fresh = false;
        popup(
          "menuitem",
          ["0.5x", "0.75x", "1x", "1.5x", "2x", "3x", "4x", "512w", "512h"],
          (scale) => {
            designerSettingsTouched ||= setting.designer && scale !== setting.scale;
            setting.scale = scale;
          },
          45,
        );
      });
      row.querySelector('button[aria-label="Remove"]')!.addEventListener("click", () => {
        designerSettingsTouched ||= setting.designer;
        settings = settings.filter((_, at) => at !== index);
        render();
      });
      container.append(row);
    });
  };
  section.querySelector('button[aria-label="Add export settings"]')!.addEventListener("click", () => {
    const scale = ["1x", "2x", "3x", "4x"].find((candidate) => !settings.some((s) => s.scale === candidate))!;
    settings = [{ format: "PNG", scale, fresh: true, stuck: false, designer: false }, ...settings];
    render();
  });
  render();
  return { section, settings: () => settings.map((s) => `${s.format} ${s.scale}`), designerSettingsTouched: () => designerSettingsTouched };
}

describe.each(MARKUPS)("temporary export settings (%s file type control)", (markup) => {
  it("adds one beside the designer's setting and removes only that one", async () => {
    const figma = simulateExportSection(["PNG 2x"], markup);
    const original = exportSettings(figma.section);
    expect(await addTemporarySetting(figma.section, original, "svg", "1x")).toBeNull();
    expect(figma.settings()).toEqual(["SVG 1x", "PNG 2x"]);

    expect(await removeTemporarySetting(figma.section, original)).toBe(true);
    expect(figma.settings()).toEqual(["PNG 2x"]);
    expect(figma.designerSettingsTouched()).toBe(false);
  });

  it("sets the requested scale even though Figma starts a new setting at an unused one", async () => {
    const figma = simulateExportSection(["PNG 1x"], markup);
    const original = exportSettings(figma.section);
    expect(await addTemporarySetting(figma.section, original, "svg", "1x")).toBeNull();
    expect(figma.settings()).toEqual(["SVG 1x", "PNG 1x"]);

    expect(await removeTemporarySetting(figma.section, original)).toBe(true);
    expect(figma.settings()).toEqual(["PNG 1x"]);
    expect(figma.designerSettingsTouched()).toBe(false);
  });

  it("adds a PNG at 2x to a layer without settings and leaves none behind", async () => {
    const figma = simulateExportSection([], markup);
    expect(await addTemporarySetting(figma.section, [], "png", "2x")).toBeNull();
    expect(figma.settings()).toEqual(["PNG 2x"]);
    expect(await removeTemporarySetting(figma.section, [])).toBe(true);
    expect(figma.settings()).toEqual([]);
  });
});

describe("temporary export settings (select file type control)", () => {
  it("reads Figma's JPEG as JPG, the tools' name, and adds and removes a JPG setting", async () => {
    const figma = simulateExportSection(["JPEG 2x"], "select");
    const original = exportSettings(figma.section);
    expect(original).toEqual(["JPG 2x"]);
    expect(await addTemporarySetting(figma.section, original, "jpg", "1x")).toBeNull();
    expect(figma.settings()).toEqual(["JPEG 1x", "JPEG 2x"]);

    expect(await removeTemporarySetting(figma.section, original)).toBe(true);
    expect(figma.settings()).toEqual(["JPEG 2x"]);
    expect(figma.designerSettingsTouched()).toBe(false);
  });

  it("says so when Figma added a setting that Figloo cannot read, instead of that Figma added none", async () => {
    document.body.innerHTML = fixture("select");
    const section = exportSection(document)!;
    const original = exportSettings(section);
    const designer = section.querySelector('[role="row"]')!;
    section.querySelector('button[aria-label="Add export settings"]')!.addEventListener("click", () => {
      const unreadable = document.createElement("div");
      unreadable.setAttribute("role", "row");
      designer.before(unreadable);
    });
    expect(await addTemporarySetting(section, original, "svg", "1x")).toMatch(/cannot read/);
  });
});

describe.each(MARKUPS)("export settings Figloo cannot read (%s file type control)", (markup) => {
  const load = () => {
    document.body.innerHTML = fixture(markup);
    return exportSection(document)!;
  };

  it("finds none in the captured markup", () => {
    expect(unreadableExportRows(load())).toBe(0);
  });

  it("counts a setting row whose scale field it no longer recognizes, which it would otherwise skip", () => {
    const section = load();
    section.querySelector('input[aria-label^="Export constraints"]')!.setAttribute("aria-label", "Scale");
    expect(exportSettings(section)).toEqual([]);
    expect(unreadableExportRows(section)).toBe(1);
  });

  it("counts a setting row whose file type it cannot read", () => {
    const section = load();
    section.querySelector('button[role="combobox"], [data-testid="legacy-export-file-type-input"]')!.remove();
    expect(exportSettings(section)).toEqual(["? 2x"]);
    expect(unreadableExportRows(section)).toBe(1);
  });
});

