import type { ProbeResult, TabReadiness } from "@figloo/protocol";

/** Wait this long after a tab finished loading before calling a missing layers panel incompatible. */
export const LOADING_GRACE_MS = 20_000;

/** Give up on reaching the content script after this many failed probes. */
export const MAX_UNREACHABLE_PROBES = 5;

export interface Readiness {
  readiness: TabReadiness;
  detail: string | null;
}

/** Turns a probe (or the lack of one) into the readiness reported to the agent. */
export function deriveReadiness(probe: ProbeResult | null, unreachableProbes: number): Readiness {
  if (!probe) {
    return unreachableProbes >= MAX_UNREACHABLE_PROBES
      ? { readiness: "INCOMPATIBLE", detail: "content script not reachable; reload the tab" }
      : { readiness: "LOADING", detail: "content script not reachable yet" };
  }
  const { layersPanel, focusTarget, uiCollapsed } = probe.capabilities;
  if (!layersPanel && uiCollapsed) {
    return { readiness: "DEGRADED", detail: "Figma UI is minimized, so the layers panel is not rendered; expand the UI (Cmd+\\)" };
  }
  if (!layersPanel) {
    return probe.msSinceLoad < LOADING_GRACE_MS
      ? { readiness: "LOADING", detail: "layers panel not found yet" }
      : { readiness: "INCOMPATIBLE", detail: "layers panel not found" };
  }
  if (probe.access === "guest") {
    return { readiness: "DEGRADED", detail: "guest session cannot select layers; sign in to Figma" };
  }
  if (probe.access === "edit") {
    return { readiness: "DEGRADED", detail: "edit access: Figma shows the Design panel instead of the inspection panel Figloo reads, so properties, snapshots, and exports do not work; layers and screenshots do" };
  }
  if (!focusTarget) {
    return { readiness: "DEGRADED", detail: "canvas keyboard target not found; keyboard navigation unavailable" };
  }
  return { readiness: "READY", detail: null };
}
