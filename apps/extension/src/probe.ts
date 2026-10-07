import type { FileAccess, ProbeResult } from "@figloo/protocol";
import { UI_ANCHORS, missingAnchors } from "./adapter/anchors.js";
import { showsDesignPanel } from "./adapter/inspect.js";

/** Toolbar labels Figma shows when the signed-in user cannot edit the file (English UI). */
const VIEW_ONLY_LABELS = new Set(["View only", "Ask to edit", "Request sent"]);

/** Small read probe run inside a Figma tab; the selectors are the anchors in adapter/anchors.ts. */
export function probeFigmaPage(doc: Document, win: Window): ProbeResult {
  const found = (anchor: { selector: string }) => doc.querySelector(anchor.selector) !== null;
  const layersPanel = found(UI_ANCHORS.layersPanel);
  const focusTarget = doc.querySelector(UI_ANCHORS.focusTarget.selector);
  return {
    href: win.location.href,
    readyState: doc.readyState,
    msSinceLoad: Math.max(0, Math.round(win.performance.now())),
    uiLocale: doc.documentElement.lang || null,
    fileName: doc.querySelector(UI_ANCHORS.fileName.selector)?.textContent?.trim() || null,
    access: detectAccess(doc, layersPanel),
    capabilities: {
      layersPanel,
      focusTarget: focusTarget !== null,
      propertiesPanel: found(UI_ANCHORS.propertiesPanel),
      mirrorDom: found(UI_ANCHORS.mirror),
      uiCollapsed: found(UI_ANCHORS.expandUi),
    },
    layerRowCount: doc.querySelectorAll(UI_ANCHORS.layerRow.selector).length,
    selectedCount: parseSelectedCount(focusTarget?.getAttribute("aria-label") ?? null),
    visible: !doc.hidden,
    missingAnchors: missingAnchors(doc),
  };
}

/**
 * Access is detected from positive markers only; without one it is reported as "unknown", never
 * guessed. Editors get Design and Prototype tabs in the right sidebar where view-only sessions get
 * Properties (seen on 2026-10-07).
 */
function detectAccess(doc: Document, layersPanel: boolean): FileAccess {
  if (doc.querySelector(UI_ANCHORS.guestSignIn.selector)) return "guest";
  if (!layersPanel) return "unknown";
  for (const button of doc.querySelectorAll("button")) {
    if (VIEW_ONLY_LABELS.has(button.textContent?.trim() ?? "")) return "view";
  }
  if (showsDesignPanel(doc)) return "edit";
  return "unknown";
}

/** Reads the selection count from the canvas keyboard target's label, e.g. "Figma Design, 3 items selected". */
export function parseSelectedCount(label: string | null): number | null {
  if (label === null) return null;
  const match = /(\d+) items? selected/.exec(label);
  if (match) return Number(match[1]);
  return label.startsWith("Figma Design") ? 0 : null;
}
