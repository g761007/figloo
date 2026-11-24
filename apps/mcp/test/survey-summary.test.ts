import { describe, expect, it } from "vitest";
import type { SurveyRoot, SurveyedLayer } from "@figloo/protocol";
import { fitOverview, flowOf, snapshotSeconds, surveyOverview } from "../src/survey-summary.js";
import type { SurveyFile } from "../src/surveys.js";

let next = 100;
const layer = (name: string, type: string, overrides: Partial<SurveyedLayer> = {}): SurveyedLayer => ({ ref: `9:${next++}`, parentRef: "9:1", name, type, hidden: false, ...overrides });

/** A screen with a status bar, a header, two cards, and text. */
function screen(ref: string, name: string, extra: SurveyedLayer[] = [], overrides: Partial<SurveyRoot> = {}): SurveyRoot {
  return {
    ref,
    name,
    type: "Frame",
    sectionRef: null,
    hidden: false,
    size: { width: 393, height: 852 },
    complete: true,
    layers: [
      layer("Status Bar / On Light", "Instance"),
      layer("Header", "Auto layout"),
      layer("Welcome back", "Text"),
      layer("Card", "Instance"),
      layer("Card", "Instance"),
      layer("Sign in", "Text"),
      ...extra,
    ],
    ...overrides,
  };
}

const root = (ref: string, name: string, type: string, overrides: Partial<SurveyRoot> = {}): SurveyRoot => ({ ref, name, type, sectionRef: null, hidden: false, size: null, complete: true, layers: [], ...overrides });

function survey(roots: SurveyRoot[], overrides: Partial<SurveyFile> = {}): SurveyFile {
  return {
    formatVersion: 1,
    id: "abc/page-0123456789abcdef",
    fileKey: "abc",
    page: "App",
    refs: null,
    createdAt: "2026-11-24T00:00:00.000Z",
    expiresAt: "2026-11-25T00:00:00.000Z",
    elapsedMs: 1_000,
    complete: true,
    scope: roots.map((r) => ({ ref: r.ref, sectionRef: r.sectionRef })),
    sections: [],
    roots,
    ...overrides,
  };
}

const textOf = (file: SurveyFile) => fitOverview(surveyOverview(file), () => true).text;

describe("flow names", () => {
  it("takes the start of a screen's name before whatever separator the designer used, without the platform", () => {
    expect(flowOf("Likes – Fans – Empty")).toBe("Likes");
    expect(flowOf("Post／New／Filled")).toBe("Post");
    expect(flowOf("Ranking-Weekly/Gifts")).toBe("Ranking");
    expect(flowOf("Quick replies - Empty")).toBe("Quick replies");
    expect(flowOf("Gifts・Info")).toBe("Gifts");
    expect(flowOf("Wealth ranking@iOS")).toBe("Wealth ranking");
    expect(flowOf("Messages")).toBe("Messages");
  });
});

describe("the survey overview", () => {
  it("counts frames, notes, sections, and the rest, and lists every frame with its numbers and an estimate", () => {
    const file = survey(
      [
        root("1:1", "Primary #3366FF for buttons and active tabs", "Text"),
        screen("1:2", "Likes – Fans"),
        screen("1:3", "Likes – Fans – Empty", [], { sectionRef: "5:1" }),
        root("1:4", "Tab Bar", "Instance"),
        root("1:5", "Group 958", "Group", { layers: [layer("Card", "Group")] }),
      ],
      { sections: [{ ref: "5:1", name: "Empty states", parentRef: null }] },
    );
    const overview = surveyOverview(file);
    expect(overview.counts).toEqual({ frames: 2, notes: 1, sections: 1, other: 2, layers: 12 });
    const text = textOf(file);
    expect(text).toContain('Page "App": 2 frames, 1 note, 1 section, 2 other layers; 12 layers inside the frames.');
    expect(text).toContain(
      '#1 1:2 Frame "Likes – Fans" 393×852 · 6 layers: 3 instances, 2 text, 0% auto-named · instances: Card ×2, Status Bar / On Light · text: "Welcome back", "Sign in" · snapshot ~5 s',
    );
    expect(text).toContain('#2 1:3 Frame "Likes – Fans – Empty" 393×852 in "Empty states"');
    expect(text).toContain('## Frames by name\n"Likes" (2): #1 #2');
    expect(text).toContain('## Sections\n5:1 "Empty states": #2');
    expect(text).toContain('## Notes on the canvas\n1:1 "Primary #3366FF for buttons and active tabs"');
    expect(text).toContain('"Tab Bar" ×1 1 on the page');
    expect(text).toContain('Group 1: "Group 958"');
  });

  it("keeps a note's whole text on one line, up to a limit", () => {
    const note = root("1:1", "Sorting\n1. Live now\n2. Group chats", "Text");
    expect(textOf(survey([note]))).toContain('1:1 "Sorting ⏎ 1. Live now ⏎ 2. Group chats"');
  });

  it("puts names that may mean one component side by side, and says in how many frames each is used", () => {
    const file = survey([
      screen("1:2", "A"),
      screen("1:3", "B", [layer("status-bar", "Instance")]),
      screen("1:4", "C", [layer("Status bar", "Instance")]),
    ]);
    const text = textOf(file);
    expect(text).toContain('"Status Bar / On Light" ×3 in 3 frames: #1 #2 #3');
    expect(text).toContain('Maybe one thing under several names: "Status Bar / On Light" (3 frames), "status-bar" (1 frame), "Status bar" (1 frame)');
  });

  it("points out detached components, pasted screenshots, frames with mostly auto-named layers, hidden frames, and frames too large to list", () => {
    const autoNamed = Array.from({ length: 8 }, (_, i) => layer(`Group ${i + 1}`, "Group"));
    const file = survey([
      screen("1:2", "Live", [layer("Component / Live / card45", "Group"), layer("Component / Live / card45", "Group"), layer("Screenshot 2026-05-05 at 15.07.41", "Image")]),
      screen("1:3", "Old", autoNamed, { hidden: true }),
      screen("1:4", "Huge", [], { complete: false }),
    ]);
    const text = textOf(file);
    expect(text).toContain('Groups and frames named like a component, maybe detached instances: #1 "Component / Live / card45" ×2');
    expect(text).toContain('Pasted screenshots, likely references rather than design: #1 "Screenshot 2026-05-05 at 15.07.41"');
    expect(text).toContain("look at a screenshot: #2 57%");
    expect(text).toContain("Hidden frames: #2");
    expect(text).toContain("Over 2,000 layers, only the first ones listed: #3");
    expect(text).toContain("#3 1:4 Frame \"Huge\" 393×852 · 6 layers: 3 instances, 2 text, 0% auto-named · instances: Card ×2, Status Bar / On Light · text: \"Welcome back\", \"Sign in\" · over 2,000 layers: snapshot its parts");
  });

  it("takes a group named like an instance elsewhere for a detached one, but not layers named by a path convention", () => {
    const file = survey([
      screen("1:2", "Home", [layer("card/My wallet", "Auto layout"), layer("section/Profile", "Frame"), layer("Status bar", "Group")]),
      screen("1:3", "Feed", [layer("Status bar", "Instance")]),
    ]);
    const text = textOf(file);
    expect(text).toContain('maybe detached instances: #1 "Status bar"');
    expect(text).not.toContain("card/My wallet");
    expect(text).not.toContain("section/Profile");
  });

  it("lists components of a single frame last, by frame, after those shared across frames", () => {
    const file = survey([screen("1:2", "Dates", [layer("option/Coffee", "Instance"), layer("option/Movie", "Instance"), layer("option/Movie", "Instance")]), screen("1:3", "Feed")]);
    const components = textOf(file).split("## Components\n")[1]!.split("\n\n")[0]!.split("\n");
    expect(components[0]).toMatch(/^"Card" ×4 in 2 frames/);
    expect(components.at(-1)).toBe('Only in #1: "option/Movie" ×2, "option/Coffee"');
  });

  it("does not take a group for a detached instance by a one-word name, which many layers share", () => {
    const file = survey([screen("1:2", "Home", [layer("Card", "Group"), layer("card", "Group")]), root("1:3", "card", "Component")]);
    expect(textOf(file)).not.toContain("maybe detached");
  });

  it("puts names that differ only in case or punctuation side by side", () => {
    const file = survey([screen("1:2", "A", [layer("Navigation bar", "Instance")]), screen("1:3", "B", [layer("Navigation/Bar", "Instance")])]);
    expect(textOf(file)).toContain('Maybe one thing under several names: "Navigation bar" (1 frame), "Navigation/Bar" (1 frame)');
  });

  it("does not take numbered siblings for one thing under several names", () => {
    const file = survey([screen("1:2", "A", [layer("sticker/slot-1", "Instance"), layer("sticker/slot-2", "Instance")]), screen("1:3", "B", [layer("sticker/slot-1", "Instance"), layer("sticker/slot-2", "Instance")])]);
    expect(textOf(file)).not.toContain("Maybe one thing");
  });

  it("leaves times and counts, such as a status bar's, out of a frame's text", () => {
    const file = survey([screen("1:2", "Chat", [layer("15:03", "Text"), layer("90", "Text")])]);
    expect(textOf(file)).toContain('text: "Welcome back", "Sign in" ·');
    expect(textOf(file)).not.toContain('"15:03"');
  });

  it("estimates a snapshot from the layer count, as the benchmark measured", () => {
    expect(snapshotSeconds(0)).toBe(5);
    // 3 s + 301 × 65 ms = 22.6 s, to the nearest 5 s.
    expect(snapshotSeconds(300)).toBe(25);
    // 42.4 s; the 605-layer screen took 39.8 s in Arc after 0.7.0's M3.
    expect(snapshotSeconds(605)).toBe(40);
  });
});

describe("fitting the overview into one result", () => {
  it("cuts the least important parts first and says how much each left out", () => {
    const roots = [
      ...Array.from({ length: 30 }, (_, i) => screen(`1:${i + 10}`, `Flow ${i % 3} – Screen ${i}`)),
      ...Array.from({ length: 40 }, (_, i) => root(`2:${i}`, `Group ${i}`, "Group")),
      ...Array.from({ length: 10 }, (_, i) => root(`3:${i}`, `Note ${i}: ${"x".repeat(80)}`, "Text")),
    ];
    const overview = surveyOverview(survey(roots));
    const full = fitOverview(overview, () => true);
    expect(full.truncated).toBe(false);
    const limit = full.text.length - 400;
    const cut = fitOverview(overview, (text) => text.length <= limit);
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(limit);
    // The other layers go first; every frame stays.
    expect(cut.text).toMatch(/## Other layers on the page\n… 1 more line left out to fit|## Other layers on the page\n[^\n]*\n… /);
    for (let i = 1; i <= 30; i += 1) expect(cut.text).toContain(`#${i} `);
    expect(cut.text).toContain("## Notes on the canvas");
  });

  it("cuts frames only when nothing else is left to cut", () => {
    const overview = surveyOverview(survey(Array.from({ length: 20 }, (_, i) => screen(`1:${i + 10}`, `Screen ${i}`))));
    const cut = fitOverview(overview, (text) => text.length <= 2_000);
    expect(cut.text.length).toBeLessThanOrEqual(2_000);
    expect(cut.text).toContain("## Frames\n#1 ");
    expect(cut.text).toMatch(/… \d+ more lines left out to fit/);
  });
});
