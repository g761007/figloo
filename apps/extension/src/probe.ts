import type { FileAccess, ProbeResult } from "@figloo/protocol";
import { showsDesignPanel } from "./adapter/inspect.js";

/** Toolbar labels Figma shows when the signed-in user cannot edit the file (English UI). */
const VIEW_ONLY_LABELS = new Set(["View only", "Ask to edit", "Request sent"]);

/** Small read probe run inside a Figma tab; selectors come from docs/compatibility. */
export function probeFigmaPage(doc: Document, win: Window): ProbeResult {
  const layersPanel = doc.querySelector('[data-testid="objects-panel"]') !== null;
  const focusTarget = doc.querySelector("input.focus-target");
  return {
    href: win.location.href,
    readyState: doc.readyState,
    msSinceLoad: Math.max(0, Math.round(win.performance.now())),
    uiLocale: doc.documentElement.lang || null,
    fileName: doc.querySelector('[data-testid="filename"]')?.textContent?.trim() || null,
    access: detectAccess(doc, layersPanel),
    capabilities: {
      layersPanel,
      focusTarget: focusTarget !== null,
      propertiesPanel: doc.querySelector('[data-testid="properties-panel"]') !== null,
      mirrorDom: doc.querySelector('#hidden-input-activedescendant[role="main"]') !== null,
      uiCollapsed: doc.querySelector('button[aria-label^="Expand UI"]') !== null,
    },
    layerRowCount: doc.querySelectorAll('[data-testid$="-layers-panel-row"]').length,
    selectedCount: parseSelectedCount(focusTarget?.getAttribute("aria-label") ?? null),
    visible: !doc.hidden,
  };
}

/**
 * Access is detected from positive markers only; without one it is reported as "unknown", never
 * guessed. Editors get Design and Prototype tabs in the right sidebar where view-only sessions get
 * Properties (seen on 2026-10-07).
 */
function detectAccess(doc: Document, layersPanel: boolean): FileAccess {
  if (doc.querySelector('[data-testid="google-btn"]')) return "guest";
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
