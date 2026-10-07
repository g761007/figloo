/**
 * How far a selector can be trusted to survive Figma's changes: a data-testid is "stable", a role or
 * an id is "semantic", and English text, a class, or an English aria label is "fragile".
 */
export type AnchorTier = "stable" | "semantic" | "fragile";

export interface UiAnchor {
  selector: string;
  tier: AnchorTier;
  /** What Figloo uses it for. */
  use: string;
  /** Present only in some sessions or states, so not finding it says nothing about Figma's UI. */
  optional?: boolean;
}

/**
 * The parts of Figma's page Figloo looks for before any layer is selected. The probe checks them,
 * get_status and the popup's Diagnostics report the ones it did not find, and the signed-in canary
 * expects none missing. Inside the inspection panel, which shows only once a layer is selected, the
 * selectors stay with the code that reads them, and the signed-in canary checks them by using the tools.
 */
export const UI_ANCHORS = {
  layersPanel: { selector: '[data-testid="objects-panel"]', tier: "stable", use: "the layers panel every tool reads" },
  layerRow: { selector: '[data-testid$="-layers-panel-row"]', tier: "stable", use: "layer rows and their IDs", optional: true },
  pagesList: { selector: '[data-testid="PagesRowWrapper"]', tier: "stable", use: "the pages for list_pages and page switches" },
  fileName: { selector: '[data-testid="filename"]', tier: "stable", use: "the file name the popup shows" },
  rightSidebar: { selector: '[role="region"][aria-label="Right sidebar"]', tier: "fragile", use: "the sidebar that holds the inspection panel" },
  propertiesPanel: { selector: '[data-testid="properties-panel"]', tier: "stable", use: "the inspection panel's container" },
  focusTarget: { selector: "input.focus-target", tier: "fragile", use: "the selection count and keyboard shortcuts on the canvas" },
  mirror: { selector: '#hidden-input-activedescendant[role="main"]', tier: "semantic", use: "where layers are on screen", optional: true },
  expandUi: { selector: 'button[aria-label^="Expand UI"]', tier: "fragile", use: "telling that the UI is minimized", optional: true },
  guestSignIn: { selector: '[data-testid="google-btn"]', tier: "stable", use: "telling a guest session", optional: true },
} as const satisfies Record<string, UiAnchor>;

export type AnchorName = keyof typeof UI_ANCHORS;

/** The anchors Figloo expects on every design page that it did not find. */
export function missingAnchors(doc: Document): AnchorName[] {
  return (Object.entries(UI_ANCHORS) as [AnchorName, UiAnchor][]).filter(([, anchor]) => !anchor.optional && !doc.querySelector(anchor.selector)).map(([name]) => name);
}
