import { describe, expect, it } from "vitest";
import type { InspectedSection, SnapshotLayer } from "@figloo/protocol";
import { summarizeLayers } from "../src/snapshot-summary.js";

const always = () => true;

function layer(ref: string, type: string, sections: InspectedSection[], overrides: Partial<SnapshotLayer> = {}): SnapshotLayer {
  return {
    ref,
    name: type,
    type,
    depth: 1,
    parentRef: "1:1",
    position: 1,
    siblingCount: 1,
    hasChildren: false,
    hidden: false,
    bounds: { x: 0, y: 0, width: 10, height: 10, source: "mirror" },
    sections,
    exports: [],
    ...overrides,
  };
}

const group = (kind: string): InspectedSection["group"] =>
  kind === "properties" ? "layout" : kind.startsWith("typography") || kind === "content" ? "typography" : kind === "componentProps" ? "component" : "appearance";

/** A panel section; properties as [name, value] or [group, name, value]. */
function section(kind: string, properties: Array<[string, string] | [string, string, string]> = [], colors: Array<[string, string?]> = []): InspectedSection {
  return {
    kind,
    group: group(kind),
    title: null,
    properties: properties.map((p) => (p.length === 2 ? { group: null, name: p[0], value: p[1] } : { group: p[0], name: p[1], value: p[2] })),
    colors: colors.map(([value, opacity]) => ({ value, opacity: opacity ?? null })),
    text: null,
  };
}

const fill = (...colors: Array<[string, string?]>) => section("colors", [], colors);
const border = (...colors: Array<[string, string?]>) => section("borders", [], colors);
const text = (font: string, weight: string, size: string, kind = "typography") =>
  section(kind, [
    ["Font", font],
    ["Weight", weight],
    ["Style", weight === "700" ? "Bold" : "Regular"],
    ["Size", size],
    ["Line height", "150%"],
    ["Letter spacing", "0%"],
  ]);

describe("summarizeLayers", () => {
  it("counts each color once per layer and says what the layers color with it", () => {
    const summary = summarizeLayers(
      [
        layer("1:1", "Frame", [fill(["#FFFFFF"]), border(["#E0E0E0"])]),
        layer("1:2", "Text", [fill(["#111111"])]),
        layer("1:3", "Text", [fill(["#111111", "70%"])]),
        // The same white as fill and border of one layer still counts as one layer.
        layer("1:4", "Frame", [fill(["#FFFFFF"]), border(["#FFFFFF"])]),
        layer("1:5", "Frame", [section("shadows", [["Drop shadow", "Blur", "2"]], [["#000000", "50%"]])]),
      ],
      always,
    );
    expect(summary.colors).toEqual([
      { value: "#FFFFFF", opacity: null, uses: ["fill", "border"], count: 2, refs: ["1:1", "1:4"] },
      { value: "#000000", opacity: "50%", uses: ["shadow"], count: 1, refs: ["1:5"] },
      { value: "#111111", opacity: null, uses: ["text"], count: 1, refs: ["1:2"] },
      { value: "#111111", opacity: "70%", uses: ["text"], count: 1, refs: ["1:3"] },
      { value: "#E0E0E0", opacity: null, uses: ["border"], count: 1, refs: ["1:1"] },
    ]);
  });

  it("counts the layers whose values it could not read, so the agent knows the summary is short of them", () => {
    const unreadable = { ...fill(["#FFFFFF"]), colors: [], unreadable: true };
    const summary = summarizeLayers(
      [layer("1:2", "Frame", [unreadable]), layer("1:3", "Frame", [fill(["#000000"])]), layer("1:4", "Frame", [unreadable], { hidden: true })],
      always,
    );
    expect(summary).toMatchObject({ layers: 2, hiddenSkipped: 1, unreadableLayers: 1 });
  });

  it("leaves hidden layers out, since they do not show, and counts them", () => {
    const summary = summarizeLayers([layer("1:1", "Frame", [fill(["#FFFFFF"])]), layer("1:2", "Frame", [fill(["#FF0000"])], { hidden: true })], always);
    expect(summary.colors.map((c) => c.value)).toEqual(["#FFFFFF"]);
    expect(summary).toMatchObject({ layers: 1, hiddenSkipped: 1 });
  });

  it("lists the text styles of whole text layers and of their style runs", () => {
    const summary = summarizeLayers(
      [
        layer("1:1", "Text", [text("Inter", "400", "14px")]),
        layer("1:2", "Text", [text("Inter", "400", "14px"), text("Inter", "700", "14px", "typography1")]),
        layer("1:3", "Text", [text("Inter", "700", "20px")]),
      ],
      always,
    );
    expect(summary.typography).toEqual([
      { font: "Inter", weight: "400", style: "Regular", size: "14px", lineHeight: "150%", letterSpacing: "0%", count: 2, refs: ["1:1", "1:2"] },
      { font: "Inter", weight: "700", style: "Bold", size: "14px", lineHeight: "150%", letterSpacing: "0%", count: 1, refs: ["1:2"] },
      { font: "Inter", weight: "700", style: "Bold", size: "20px", lineHeight: "150%", letterSpacing: "0%", count: 1, refs: ["1:3"] },
    ]);
  });

  it("orders gaps, padding sides, corner radii, and border widths by value, the way a scale reads", () => {
    const summary = summarizeLayers(
      [
        layer("1:1", "Auto layout", [
          section("properties", [
            ["Gap", "16px"],
            ["Padding", "Top", "8px"],
            ["Padding", "Right", "16px"],
            ["Padding", "Bottom", "8px"],
            ["Padding", "Left", "16px"],
            ["Radius", "8px"],
            ["Border", "1px"],
          ]),
        ]),
        layer("1:2", "Auto layout", [
          section("properties", [
            ["Gap", "4px"],
            ["Radius", "Top-left", "24px"],
            ["Border", "0.5px"],
            ["Width", "Hug (120px)"],
          ]),
        ]),
        layer("1:3", "Auto layout", [section("properties", [["Gap", "8px"]])]),
      ],
      always,
    );
    expect(summary.gaps.map((g) => g.value)).toEqual(["4px", "8px", "16px"]);
    // A layer padded 8px on two sides counts once for 8px.
    expect(summary.paddings).toEqual([
      { value: "8px", count: 1, refs: ["1:1"] },
      { value: "16px", count: 1, refs: ["1:1"] },
    ]);
    expect(summary.radii.map((r) => r.value)).toEqual(["8px", "24px"]);
    expect(summary.borders.map((b) => b.value)).toEqual(["0.5px", "1px"]);
  });

  it("keeps each distinct shadow block as the panel shows it", () => {
    const shadow = () =>
      section(
        "shadows",
        [
          ["Drop shadow", "X", "0"],
          ["Drop shadow", "Y", "2"],
          ["Drop shadow", "Blur", "8"],
        ],
        [["#000000", "25%"]],
      );
    const summary = summarizeLayers([layer("1:1", "Frame", [shadow()]), layer("1:2", "Frame", [shadow()])], always);
    expect(summary.shadows).toEqual([{ properties: shadow().properties, colors: [{ value: "#000000", opacity: "25%" }], count: 2, refs: ["1:1", "1:2"] }]);
  });

  it("groups instances by name with each combination of their component properties", () => {
    const props = (value: string) => section("componentProps", [["Property 1", value]]);
    const summary = summarizeLayers(
      [
        layer("1:1", "Instance", [props("Primary")], { name: "Button" }),
        layer("1:2", "Instance", [props("Primary")], { name: "Button" }),
        layer("1:3", "Instance", [props("Secondary")], { name: "Button" }),
        layer("1:4", "Instance", [], { name: "Icon/Chevron" }),
        // Only instances count as uses of a component.
        layer("1:5", "Frame", [], { name: "Button" }),
      ],
      always,
    );
    expect(summary.components).toEqual([
      {
        name: "Button",
        count: 3,
        refs: ["1:1", "1:2", "1:3"],
        variants: [
          { properties: { "Property 1": "Primary" }, count: 2 },
          { properties: { "Property 1": "Secondary" }, count: 1 },
        ],
      },
      { name: "Icon/Chevron", count: 1, refs: ["1:4"], variants: [] },
    ]);
  });

  it("keeps five example refs per value", () => {
    const layers = Array.from({ length: 8 }, (_, i) => layer(`1:${i + 1}`, "Frame", [fill(["#FFFFFF"])]));
    expect(summarizeLayers(layers, always).colors[0]).toMatchObject({ count: 8, refs: ["1:1", "1:2", "1:3", "1:4", "1:5"] });
  });

  it("lists at most 100 values of a kind, dropping the ones fewest layers use, and says so", () => {
    const common = Array.from({ length: 10 }, (_, c) => Array.from({ length: 3 }, (_, i) => layer(`2:${c * 3 + i}`, "Frame", [fill([`#00000${c}`])]))).flat();
    const rare = Array.from({ length: 120 }, (_, i) => layer(`3:${i}`, "Frame", [fill([`#F${String(i).padStart(5, "0")}`])]));
    const summary = summarizeLayers([...rare, ...common], always);
    expect(summary.colors).toHaveLength(100);
    expect(summary.truncated).toBe(true);
    for (let c = 0; c < 10; c += 1) expect(summary.colors.find((color) => color.value === `#00000${c}`)?.count).toBe(3);
  });

  it("gives fewer example refs before it cuts any list to fit the result", () => {
    const layers = Array.from({ length: 30 }, (_, i) => layer(`1:${i + 1}`, "Frame", [fill([`#00000${i % 6}`])]));
    const full = JSON.stringify(summarizeLayers(layers, always)).length;
    const summary = summarizeLayers(layers, (candidate) => JSON.stringify(candidate).length < full - 20);
    expect(summary.truncated).toBe(false);
    expect(summary.colors).toHaveLength(6);
    expect(Math.max(...summary.colors.map((c) => c.refs.length))).toBeLessThan(5);
  });

  it("cuts the rarest values once one ref each still does not fit", () => {
    const layers = [
      ...Array.from({ length: 5 }, (_, i) => layer(`1:${i}`, "Frame", [fill(["#111111"])])),
      ...Array.from({ length: 20 }, (_, i) => layer(`2:${i}`, "Frame", [fill([`#A${String(i).padStart(5, "0")}`])])),
    ];
    const budget = 600;
    const summary = summarizeLayers(layers, (candidate) => JSON.stringify(candidate).length <= budget);
    expect(JSON.stringify(summary).length).toBeLessThanOrEqual(budget);
    expect(summary.truncated).toBe(true);
    expect(summary.colors[0]).toMatchObject({ value: "#111111", count: 5 });
    expect(summary.colors.length).toBeLessThan(21);
  });
});
