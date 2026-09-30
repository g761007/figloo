import type { LayerNode, TabStatus } from "@figloo/protocol";
import type { PopupSnapshot } from "../src/popup-model.js";

export function layer(ref: string, name: string, type: string | null, extra: Partial<LayerNode> = {}): LayerNode {
  return { ref, name, nameTruncated: false, type, depth: 1, position: 1, siblingCount: 1, parentRef: null, hasChildren: false, childCount: null, insideInstance: false, link: null, ...extra };
}

export const figmaTab: TabStatus = {
  tabId: 42,
  windowId: 1,
  url: "https://www.figma.com/design/abc123/Sample-app?node-id=2-5",
  title: "Sample app – Figma",
  fileKey: "abc123",
  fileName: "Sample app",
  nodeIdFromUrl: "2:5",
  readiness: "READY",
  access: "view",
  uiLocale: "en",
  capabilities: { layersPanel: true, focusTarget: true, propertiesPanel: true, mirrorDom: true, uiCollapsed: false },
  layerRowCount: 30,
  visible: true,
  probedAt: 1,
  detail: null,
};

export function snapshot(extra: Partial<PopupSnapshot> = {}): PopupSnapshot {
  return {
    connection: { phase: "connected", port: 47129, connectedAt: 1, lastError: null, attempts: 0, tabCount: 1 },
    tab: figmaTab,
    page: "Checkout",
    selection: null,
    selectionError: { code: "NO_SELECTION", message: "no layer is selected in Figma" },
    ...extra,
  };
}

/** A card inside a screen, with twelve children, as the service worker would report it. */
export function cardSelection(): PopupSnapshot["selection"] {
  return {
    anchor: layer("2:5", "Order card", "Frame", { hasChildren: true, link: "https://www.figma.com/design/abc123/Sample-app?node-id=2-5" }),
    ancestors: [layer("2:3", "Order list", "Auto layout"), layer("2:1", "Checkout screen", "Frame", { depth: 0 })],
    children: Array.from({ length: 12 }, (_, index) => layer(`2:${10 + index}`, `Item ${index + 1}`, index === 0 ? "Text" : "Instance")),
    childrenTotal: 12,
    childrenHasMore: false,
  };
}
