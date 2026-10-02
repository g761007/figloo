import type { SessionIdentity, TabStatus } from "@figloo/protocol";
import { describe, expect, it } from "vitest";
import { DEFAULT_TITLE, actionAppearance } from "../src/action.js";
import type { ConnectionState } from "../src/state.js";

const agent = (phase: ConnectionState["phase"], session: SessionIdentity | null = null) => ({ phase, session });

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
  visible: true,
  probedAt: 1,
  detail: null,
  ...overrides,
});

describe("actionAppearance", () => {
  it("turns the icon colorful only for tabs Figloo can read", () => {
    const icons = Object.fromEntries(
      (["READY", "DEGRADED", "LOADING", "INCOMPATIBLE"] as const).map((readiness) => [readiness, actionAppearance(tab({ readiness }), agent("connected")).icon]),
    );
    expect(icons).toEqual({ READY: "color", DEGRADED: "color", LOADING: "gray", INCOMPATIBLE: "gray" });
  });

  it("keeps the default gray icon and title for a tab without a design file", () => {
    expect(actionAppearance(null, agent("connected"))).toEqual({ icon: "gray", badge: null, title: DEFAULT_TITLE });
  });

  it("names the file on a ready tab and shows no badge", () => {
    const appearance = actionAppearance(tab(), agent("connected"));
    expect(appearance.badge).toBeNull();
    expect(appearance.title).toBe("Figloo: ready on “Sample App”\nAgent: connected");
  });

  it("flags a degraded tab with a warning badge and says why", () => {
    const appearance = actionAppearance(tab({ readiness: "DEGRADED", detail: "guest session cannot select layers; sign in to Figma" }), agent("connected"));
    expect(appearance.badge?.text).toBe("!");
    expect(appearance.title).toBe("Figloo: limited on “Sample App”\nguest session cannot select layers; sign in to Figma\nAgent: connected");
  });

  it("marks an unreadable Figma page with a different badge color than a degraded one", () => {
    const degraded = actionAppearance(tab({ readiness: "DEGRADED", detail: "x" }), agent("connected"));
    const incompatible = actionAppearance(tab({ readiness: "INCOMPATIBLE", detail: "layers panel not found" }), agent("connected"));
    expect(incompatible.badge?.color).not.toBe(degraded.badge?.color);
    expect(incompatible.title).toMatch(/^Figloo: cannot read “Sample App”\nlayers panel not found\n/);
  });

  it("tells the user when no agent is connected or the extension is not paired", () => {
    expect(actionAppearance(tab(), agent("disconnected")).title).toMatch(/\nAgent: not connected/);
    expect(actionAppearance(tab(), agent("connecting")).title).toMatch(/\nAgent: not connected/);
    expect(actionAppearance(tab(), agent("unpaired")).title).toMatch(/\nAgent: not paired/);
  });

  it("names the agent session the extension serves, and only says connected for a server without one", () => {
    const session = { client: "Claude Code", project: "shop", pid: 1, startedAt: new Date(2026, 9, 2, 9, 15).getTime(), serverVersion: "0.2.0" };
    expect(actionAppearance(tab(), agent("connected", session)).title).toBe("Figloo: ready on “Sample App”\nAgent: Claude Code · shop (started 09:15)");
    expect(actionAppearance(tab(), agent("connected")).title).toMatch(/\nAgent: connected$/);
  });

  it("falls back to a generic name when the file name is unknown", () => {
    expect(actionAppearance(tab({ fileName: null }), agent("connected")).title).toMatch(/^Figloo: ready on this file\n/);
  });
});
