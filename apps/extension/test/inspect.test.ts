// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { readInspection } from "../src/adapter/inspect.js";

function repoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) dir = dirname(dir);
  return dir;
}

function fixture(name: string): Document {
  const html = readFileSync(join(repoRoot(), "tests/fixtures/inspection", `${name}.html`), "utf8");
  return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
}

const props = (section: { properties: { group: string | null; name: string; value: string }[] } | undefined) =>
  (section?.properties ?? []).map((p) => (p.group ? `${p.group}—${p.name}=${p.value}` : `${p.name}=${p.value}`));

describe("readInspection on captured view-only panels", () => {
  it("tells auto layout padding and corner radius apart from plain dimensions", () => {
    const sections = readInspection(fixture("auto-layout-frame"));
    const layout = sections.find((s) => s.kind === "properties");
    expect(layout?.group).toBe("layout");
    expect(props(layout)).toEqual([
      "Flow=Vertical",
      "Width=Hug (393px)",
      "Height=Hug (135px)",
      "Radius—Top-left=16px",
      "Radius—Top-right=16px",
      "Padding—Top=24px",
      "Padding—Right=19px",
      "Padding—Bottom=24px",
      "Padding—Left=19px",
      "Gap=10px",
    ]);
  });

  it("reads fills and drop shadows with their opacity", () => {
    const sections = readInspection(fixture("auto-layout-frame"));
    expect(sections.find((s) => s.kind === "colors")?.colors).toEqual([{ value: "#FFFFFF", opacity: null }]);
    const shadows = sections.find((s) => s.kind === "shadows");
    expect(shadows?.group).toBe("appearance");
    expect(props(shadows)).toEqual(["Drop shadow—X=0", "Drop shadow—Y=-4", "Drop shadow—Blur=8", "Drop shadow—Spread=0"]);
    expect(shadows?.colors).toEqual([{ value: "#08458A", opacity: "12%" }]);
  });

  it("keeps position rows of a layer inside a parent separate from padding", () => {
    const layout = readInspection(fixture("auto-layout-component")).find((s) => s.kind === "properties");
    expect(props(layout)).toEqual(["Flow=Vertical", "Width=Hug (317px)", "Height=Hug (411px)", "Top=336px", "Left=8px", "Gap=2px"]);
  });

  it("returns the text content and one typography block per style run", () => {
    const sections = readInspection(fixture("mixed-text"));
    expect(sections.find((s) => s.kind === "content")?.text).toBe("Sample text 1");
    const runs = sections.filter((s) => s.group === "typography" && s.kind !== "content");
    expect(runs.map((s) => s.kind)).toEqual(["typography", "typography1"]);
    expect(props(runs[0])).toEqual(["Font=Roboto", "Weight=500", "Style=Medium", "Size=24px", "Line height=150%", "Letter spacing=2%"]);
    expect(props(runs[1])).toContain("Size=20px");
  });

  it("reads component properties and the parent component of an instance", () => {
    const sections = readInspection(fixture("instance-with-properties"));
    expect(props(sections.find((s) => s.kind === "componentProps"))).toEqual(["Property=birthday"]);
    const parent = sections.find((s) => s.kind === "selection_hierarchy");
    expect(parent).toMatchObject({ group: "component", title: "Parent component" });
    expect(parent?.text).toMatch(/^Sample (text|label)/);
    expect(props(sections.find((s) => s.kind === "properties"))).toEqual(["Width=16px", "Height=16px"]);
  });
});

describe("sections Figloo cannot read", () => {
  it("finds every section of the captured panels readable", () => {
    for (const name of ["auto-layout-frame", "auto-layout-component", "instance-with-properties", "mixed-text"]) {
      expect(readInspection(fixture(name)).filter((section) => section.unreadable)).toEqual([]);
    }
  });

  it("marks a section that shows values Figloo cannot read, as after Figma changed its markup", () => {
    const doc = fixture("auto-layout-frame");
    // The rows lose the "Copy <name>: <value>" labels Figloo reads them by, but still show their values.
    for (const el of doc.querySelectorAll('[data-testid="properties-inspection-panel"] [aria-label^="Copy "]')) el.setAttribute("aria-label", "Duplicate");
    const sections = readInspection(doc);
    expect(sections.find((section) => section.kind === "properties")).toMatchObject({ unreadable: true, properties: [] });
    expect(sections.find((section) => section.kind === "colors")?.unreadable).toBeUndefined();
  });
});

