import type { ProbeResult } from "@figloo/protocol";
import { describe, expect, it } from "vitest";
import { LOADING_GRACE_MS, MAX_UNREACHABLE_PROBES, deriveReadiness } from "../src/readiness.js";

const probe = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  href: "https://www.figma.com/design/abc/Name",
  readyState: "complete",
  msSinceLoad: 30_000,
  uiLocale: "en",
  fileName: "Name",
  access: "view",
  capabilities: { layersPanel: true, focusTarget: true, propertiesPanel: true, mirrorDom: false, uiCollapsed: false },
  layerRowCount: 10,
  selectedCount: 0,
  visible: true,
  ...overrides,
});

describe("deriveReadiness", () => {
  it("is READY when the layers panel and keyboard target exist for a signed-in session", () => {
    expect(deriveReadiness(probe(), 0)).toEqual({ readiness: "READY", detail: null });
  });

  it("stays LOADING while the layers panel is missing shortly after load", () => {
    const result = deriveReadiness(probe({ msSinceLoad: 1_000, capabilities: { layersPanel: false, focusTarget: false, propertiesPanel: false, mirrorDom: false, uiCollapsed: false } }), 0);
    expect(result.readiness).toBe("LOADING");
  });

  it("becomes INCOMPATIBLE when the layers panel is still missing after the grace period", () => {
    const result = deriveReadiness(probe({ msSinceLoad: LOADING_GRACE_MS, capabilities: { layersPanel: false, focusTarget: false, propertiesPanel: false, mirrorDom: false, uiCollapsed: false } }), 0);
    expect(result.readiness).toBe("INCOMPATIBLE");
  });

  it("degrades instead of failing when the layers panel is missing because the UI is minimized", () => {
    const result = deriveReadiness(probe({ msSinceLoad: LOADING_GRACE_MS, capabilities: { layersPanel: false, focusTarget: true, propertiesPanel: false, mirrorDom: false, uiCollapsed: true } }), 0);
    expect(result).toEqual({ readiness: "DEGRADED", detail: expect.stringMatching(/minimized/) });
  });

  it("degrades a guest session because guests cannot select layers", () => {
    expect(deriveReadiness(probe({ access: "guest" }), 0).readiness).toBe("DEGRADED");
  });

  it("treats an unreachable content script as LOADING first and INCOMPATIBLE after repeated failures", () => {
    expect(deriveReadiness(null, 0).readiness).toBe("LOADING");
    expect(deriveReadiness(null, MAX_UNREACHABLE_PROBES).readiness).toBe("INCOMPATIBLE");
  });
});
