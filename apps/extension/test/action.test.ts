import type { TabStatus } from "@figloo/protocol";
import { describe, expect, it } from "vitest";
import { DEFAULT_TITLE, actionAppearance } from "../src/action.js";

const tab = (overrides: Partial<TabStatus> = {}): TabStatus => ({
  tabId: 7,
  windowId: 1,
  url: "https://www.figma.com/design/abc/Name",
  title: "Name – Figma",
  fileKey: "abc",
  fileName: "Sample App",
  nodeIdFromUrl: null,
  readiness: "READY",
  access: "view",
  uiLocale: "en",
  capabilities: { layersPanel: true, focusTarget: true, propertiesPanel: true, mirrorDom: false, uiCollapsed: false },
  layerRowCount: 10,
  probedAt: 1,
  detail: null,
  ...overrides,
});

describe("actionAppearance", () => {
  it("turns the icon colorful only for tabs Figloo can read", () => {
    const icons = Object.fromEntries(
      (["READY", "DEGRADED", "LOADING", "INCOMPATIBLE"] as const).map((readiness) => [readiness, actionAppearance(tab({ readiness }), "connected").icon]),
    );
    expect(icons).toEqual({ READY: "color", DEGRADED: "color", LOADING: "gray", INCOMPATIBLE: "gray" });
  });

  it("keeps the default gray icon and title for a tab without a design file", () => {
    expect(actionAppearance(null, "connected")).toEqual({ icon: "gray", badge: null, title: DEFAULT_TITLE });
  });

  it("names the file on a ready tab and shows no badge", () => {
    const appearance = actionAppearance(tab(), "connected");
    expect(appearance.badge).toBeNull();
    expect(appearance.title).toBe("Figloo: ready on “Sample App”\nAgent: connected");
  });

  it("flags a degraded tab with a warning badge and says why", () => {
    const appearance = actionAppearance(tab({ readiness: "DEGRADED", detail: "guest session cannot select layers; sign in to Figma" }), "connected");
    expect(appearance.badge?.text).toBe("!");
    expect(appearance.title).toBe("Figloo: limited on “Sample App”\nguest session cannot select layers; sign in to Figma\nAgent: connected");
  });

  it("marks an unreadable Figma page with a different badge color than a degraded one", () => {
    const degraded = actionAppearance(tab({ readiness: "DEGRADED", detail: "x" }), "connected");
    const incompatible = actionAppearance(tab({ readiness: "INCOMPATIBLE", detail: "layers panel not found" }), "connected");
    expect(incompatible.badge?.color).not.toBe(degraded.badge?.color);
    expect(incompatible.title).toMatch(/^Figloo: cannot read “Sample App”\nlayers panel not found\n/);
  });

  it("tells the user when no agent is connected or the extension is not paired", () => {
    expect(actionAppearance(tab(), "disconnected").title).toMatch(/\nAgent: not connected/);
    expect(actionAppearance(tab(), "connecting").title).toMatch(/\nAgent: not connected/);
    expect(actionAppearance(tab(), "unpaired").title).toMatch(/\nAgent: not paired/);
  });

  it("falls back to a generic name when the file name is unknown", () => {
    expect(actionAppearance(tab({ fileName: null }), "connected").title).toMatch(/^Figloo: ready on this file\n/);
  });
});
