import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mapTokens } from "../src/map-tokens.js";
import { scanProject, type ProjectToken } from "../src/project-tokens.js";
import type { SnapshotSummary } from "../src/snapshot-summary.js";
import { deltaE, parseArgbHex, parseCssColor } from "../src/token-values.js";

const FIXTURES = resolve(import.meta.dirname, "../../../tests/fixtures/projects");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function byName(tokens: ProjectToken[]): Record<string, ProjectToken> {
  return Object.fromEntries(tokens.map((token) => [token.name, token]));
}

describe("color values", () => {
  it("reads CSS colors with the alpha last and Android ones with the alpha first", () => {
    expect(parseCssColor("#0055ff")).toEqual({ r: 0, g: 85, b: 255, a: 1 });
    expect(parseCssColor("#05F")).toEqual({ r: 0, g: 85, b: 255, a: 1 });
    expect(parseCssColor("rgba(0, 0, 0, 0.4)")).toEqual({ r: 0, g: 0, b: 0, a: 0.4 });
    expect(parseCssColor("#00000066")).toEqual({ r: 0, g: 0, b: 0, a: 0.4 });
    expect(parseArgbHex("#66000000")).toEqual({ r: 0, g: 0, b: 0, a: 0.4 });
    expect(parseArgbHex("0xFF0055FF")).toEqual({ r: 0, g: 85, b: 255, a: 1 });
  });

  it("measures how far apart two colors look", () => {
    expect(deltaE(parseCssColor("#D5D5D5")!, parseCssColor("#D6D6D6")!)).toBeLessThan(1);
    expect(deltaE(parseCssColor("#0055FF")!, parseCssColor("#FF5500")!)).toBeGreaterThan(50);
  });
});

describe("project scan", () => {
  it("reads web tokens from CSS variables, SCSS variables, a Tailwind config, and design token JSON, and React components", async () => {
    const scan = await scanProject(join(FIXTURES, "web"));
    const t = byName(scan.tokens);
    expect(t["--color-primary"]).toMatchObject({ kind: "color", color: { r: 0, g: 85, b: 255, a: 1 }, file: "src/styles/tokens.css", line: 2 });
    expect(t["--color-overlay"]!.color).toEqual({ r: 0, g: 0, b: 0, a: 0.4 });
    expect(t["--spacing-lg"]).toMatchObject({ kind: "length", length: 24, role: "spacing" });
    expect(t["--radius-card"]).toMatchObject({ kind: "length", length: 8, role: "radius" });
    expect(t["--font-size-title"]).toMatchObject({ kind: "font", size: 15 });
    expect(t["$gap-xs"]).toMatchObject({ kind: "length", length: 2, role: "spacing" });
    expect(t["theme.extend.colors.brand.primary"]).toMatchObject({ kind: "color", file: "tailwind.config.js", color: { r: 0, g: 85, b: 255, a: 1 } });
    expect(t["theme.extend.spacing.2.5"]).toMatchObject({ kind: "length", length: 10, role: "spacing" });
    expect(t["theme.extend.borderRadius.pill"]).toMatchObject({ kind: "length", length: 14, role: "radius" });
    expect(t["theme.extend.fontSize.caption"]).toMatchObject({ kind: "font", size: 12 });
    expect(t["color.gold"]).toMatchObject({ kind: "color", file: "tokens/design-tokens.json", color: { r: 226, g: 204, b: 113, a: 1 } });
    expect(t["radius.sm"]).toMatchObject({ kind: "length", length: 15, role: "radius" });
    expect(scan.components.map((c) => c.name).sort()).toEqual(["PrimaryButton", "StatusBar"]);
    expect(scan.sources.map((s) => s.format).sort()).toEqual(["css", "css", "json", "script"]);
  });

  it("reads iOS tokens from an asset catalog and Swift, and SwiftUI views", async () => {
    const scan = await scanProject(join(FIXTURES, "ios"));
    const t = byName(scan.tokens);
    expect(t.BrandPrimary).toMatchObject({ kind: "color", color: { r: 0, g: 85, b: 255, a: 1 } });
    expect(t.borderSubtle!.color).toEqual({ r: 214, g: 214, b: 214, a: 1 });
    expect(t.accent!.color).toEqual({ r: 36, g: 244, b: 201, a: 1 });
    expect(t.overlay!.color).toEqual({ r: 0, g: 0, b: 0, a: 0.4 });
    expect(t["Spacing.md"]).toMatchObject({ kind: "length", length: 16, role: "spacing" });
    expect(t["Radius.card"]).toMatchObject({ kind: "length", length: 8, role: "radius" });
    expect(t.title).toMatchObject({ kind: "font", size: 15, weight: 500 });
    expect(t.caption).toMatchObject({ kind: "font", size: 12, weight: null });
    expect(scan.components.map((c) => c.name)).toEqual(["PrimaryButton"]);
  });

  it("reads Android tokens from resources and Compose, and composables", async () => {
    const scan = await scanProject(join(FIXTURES, "android"));
    const t = byName(scan.tokens);
    expect(t.brand_primary!.color).toEqual({ r: 0, g: 85, b: 255, a: 1 });
    expect(t.overlay!.color).toEqual({ r: 0, g: 0, b: 0, a: 0.4 });
    expect(t.spacing_md).toMatchObject({ kind: "length", length: 16, role: "spacing" });
    expect(t.corner_card).toMatchObject({ kind: "length", length: 8, role: "radius" });
    expect(t.text_title).toMatchObject({ kind: "font", size: 15 });
    expect(t.Accent!.color).toEqual({ r: 36, g: 244, b: 201, a: 1 });
    expect(t["Spacing.sm"]).toMatchObject({ kind: "length", length: 10, role: "spacing" });
    expect(t.Title).toMatchObject({ kind: "font", size: 15, weight: 500 });
    expect(scan.components.map((c) => c.name)).toEqual(["StatusBar"]);
  });

  it("reads Flutter tokens and widgets", async () => {
    const scan = await scanProject(join(FIXTURES, "flutter"));
    const t = byName(scan.tokens);
    expect(t.brandPrimary!.color).toEqual({ r: 0, g: 85, b: 255, a: 1 });
    expect(t["Spacing.md"]).toMatchObject({ kind: "length", length: 16, role: "spacing" });
    expect(t.title).toMatchObject({ kind: "font", size: 15, weight: 500 });
    expect(scan.components.map((c) => c.name)).toEqual(["PrimaryButton"]);
  });

  it("skips dependencies, hidden folders, tests, and .env files, and says when it stopped at its limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "figloo-project-"));
    dirs.push(dir);
    cpSync(join(FIXTURES, "web"), dir, { recursive: true });
    mkdirSync(join(dir, "node_modules", "lib"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "lib", "colors.css"), ":root { --color-from-a-dependency: #0055FF; }\n");
    mkdirSync(join(dir, ".cache"));
    writeFileSync(join(dir, ".cache", "colors.css"), ":root { --color-cached: #0055FF; }\n");
    writeFileSync(join(dir, ".env"), "BRAND_COLOR=#0055FF\n");
    writeFileSync(join(dir, "src", "styles", "tokens.test.ts"), 'const css = ":root { --color-in-a-test: #0055FF; }";\n');

    const scan = await scanProject(dir);
    expect(scan.complete).toBe(true);
    expect(scan.tokens.map((t) => t.name)).not.toEqual(expect.arrayContaining(["--color-from-a-dependency"]));
    expect(scan.tokens.map((t) => t.name)).not.toEqual(expect.arrayContaining(["--color-cached"]));
    expect(scan.tokens.map((t) => t.name)).not.toEqual(expect.arrayContaining(["--color-in-a-test"]));
    expect(scan.sources.map((s) => s.file)).not.toContain(".env");

    const short = await scanProject(dir, { maxFiles: 2 });
    expect(short).toMatchObject({ complete: false, files: 2 });
  });
});

const summary: SnapshotSummary = {
  layers: 12,
  hiddenSkipped: 0,
  unreadableLayers: 0,
  colors: [
    { value: "#0055FF", opacity: null, uses: ["fill"], count: 5, refs: ["1:1"] },
    { value: "#D5D5D5", opacity: null, uses: ["border"], count: 3, refs: ["1:2"] },
    { value: "#000000", opacity: "40%", uses: ["fill"], count: 2, refs: ["1:3"] },
    { value: "#123456", opacity: null, uses: ["text"], count: 1, refs: ["1:4"] },
  ],
  typography: [
    { font: "PingFang TC", weight: "500", style: "Medium", size: "15px", lineHeight: "150%", letterSpacing: "0%", count: 4, refs: ["2:1"] },
    { font: "PingFang TC", weight: "700", style: "Bold", size: "15px", lineHeight: "150%", letterSpacing: "0%", count: 1, refs: ["2:2"] },
  ],
  gaps: [
    { value: "16px", count: 3, refs: ["3:1"] },
    { value: "17px", count: 1, refs: ["3:2"] },
  ],
  paddings: [{ value: "16px", count: 2, refs: ["3:3"] }],
  radii: [{ value: "8px", count: 2, refs: ["4:1"] }],
  borders: [],
  shadows: [],
  components: [
    { name: "Button / Primary", count: 2, refs: ["5:1"], variants: [] },
    { name: "Status Bar", count: 1, refs: ["5:2"], variants: [] },
    { name: "Confetti", count: 1, refs: ["5:3"], variants: [] },
  ],
  truncated: false,
};

describe("mapping a snapshot onto a project", () => {
  it("finds exact and near tokens for each design value on every platform, and says what differs", async () => {
    for (const platform of ["web", "ios", "android", "flutter"]) {
      const mapped = mapTokens(summary, await scanProject(join(FIXTURES, platform)));
      const primary = mapped.colors.find((c) => c.value === "#0055FF")!;
      expect(primary.matches[0], platform).toMatchObject({ match: "exact", difference: null });
      expect(mapped.colors.find((c) => c.value === "#123456")!.matches, platform).toEqual([]);
      const title = mapped.typography.find((t) => t.weight === "500")!;
      // The web project sets font sizes only, so its match cannot vouch for the weight.
      expect(title.matches[0], platform).toMatchObject(platform === "web" ? { match: "near", difference: "the token sets no weight" } : { match: "exact" });
      const spacing = mapped.spacing.find((s) => s.value === "16px")!;
      expect(spacing, platform).toMatchObject({ uses: ["gap", "padding"], count: 5 });
      expect(spacing.matches[0], platform).toMatchObject({ match: "exact" });
    }
  });

  it("calls a color that only looks the same, or differs only in alpha, near", async () => {
    const mapped = mapTokens(summary, await scanProject(join(FIXTURES, "web")));
    expect(mapped.colors.find((c) => c.value === "#D5D5D5")!.matches[0]).toMatchObject({ token: "--color-border-subtle", match: "near", difference: expect.stringMatching(/^ΔE 0\.\d$/) });
    const overlay = mapped.colors.find((c) => c.value === "#000000")!.matches;
    expect(overlay[0]).toMatchObject({ token: "--color-overlay", match: "exact" });
    expect(overlay[1]).toMatchObject({ token: "--color-black", match: "near", difference: "alpha 1 vs 0.4" });
    expect(mapped.spacing.find((s) => s.value === "17px")!.matches[0]).toMatchObject({ token: "--spacing-md", match: "near", difference: "1px" });
    expect(mapped.radii[0]!.matches[0]).toMatchObject({ token: "--radius-card", match: "exact", file: "src/styles/tokens.css", line: 8, written: "--radius-card: 8px;" });
  });

  it("calls a text style of another weight near, and lists components that share an instance's words", async () => {
    const mapped = mapTokens(summary, await scanProject(join(FIXTURES, "ios")));
    expect(mapped.typography.find((t) => t.weight === "700")!.matches[0]).toMatchObject({ token: "title", match: "near", difference: "weight 500 vs 700" });
    expect(mapped.components.find((c) => c.name === "Button / Primary")!.candidates[0]).toMatchObject({ name: "PrimaryButton", file: "App/Views/PrimaryButton.swift", score: 1 });
    expect(mapped.components.find((c) => c.name === "Confetti")!.candidates).toEqual([]);
    expect(mapped.unmatched).toMatchObject({ colors: 1, components: 2 });
  });
});
