import type { LayerNode, TabStatus } from "@figloo/protocol";
import type { ConnectionState } from "./state.js";

/** The layers the user selected, as far as the popup shows them. */
export interface PopupSelection {
  /** The first selected layer. With one selected layer, its path and children are shown too. */
  anchor: LayerNode;
  /** Every selected layer found, including `anchor`. */
  anchors: LayerNode[];
  selectionCount: number;
  /** Nearest first. */
  ancestors: LayerNode[];
  children: LayerNode[];
  childrenTotal: number | null;
  childrenHasMore: boolean;
}

/** Everything the popup shows, gathered by the service worker for one tab. */
export interface PopupSnapshot {
  connection: ConnectionState;
  /** null when the tab has no Figma design file. */
  tab: TabStatus | null;
  page: string | null;
  selection: PopupSelection | null;
  /** Why no selection is shown, for example NO_SELECTION. */
  selectionError: { code: string; message: string } | null;
}

/** Children the popup lists, and how many of them the prompt names. */
export const POPUP_CHILDREN = 20;
const PROMPT_CHILDREN = 10;

const described = (node: LayerNode) => (node.type ? `${node.name} (${node.type})` : node.name);

const FRAME_TYPES = new Set(["Frame", "Auto layout"]);

/**
 * A frame on the canvas, or in a section, outside instances: what a screen to implement looks like.
 * Without its whole path, which the popup may have failed to read, a frame is not taken for one.
 */
function isPage(selection: PopupSelection): boolean {
  const { anchor, ancestors } = selection;
  const onCanvas = ancestors.length === anchor.depth && ancestors.every((node) => node.type === "Section");
  return FRAME_TYPES.has(anchor.type ?? "") && anchor.insideInstance !== true && onCanvas;
}

/**
 * Text to paste into the coding agent: where the design is, which layer the user means, and which
 * Figloo tools to start with. The user adds the task itself.
 */
export function buildPrompt(snapshot: PopupSnapshot): string | null {
  const { tab, selection } = snapshot;
  if (!tab) return null;
  const file = `File: ${tab.fileName ?? tab.fileKey ?? "Figma file"} (tab ${tab.tabId})`;
  const page = snapshot.page ? `Page: ${snapshot.page}` : null;
  const tools = "capture to see it, get_neighbors for its structure, inspect_nodes for exact values, and export_asset for icons";
  if (!selection) {
    return [
      "Use the Figloo MCP tools to explore the Figma file open in my browser.",
      "",
      file,
      page,
      "",
      `Call list_pages and explore_page with tabId ${tab.tabId} to find the frames you need, then use ${tools}.`,
    ]
      .filter((line) => line !== null)
      .join("\n");
  }
  const { anchor } = selection;
  if (selection.anchors.length > 1) {
    const refs = selection.anchors.map((node) => node.ref).join(", ");
    return [
      `Use the Figloo MCP tools to work on the ${selection.anchors.length} Figma layers I selected in my browser.`,
      "",
      file,
      page,
      "Layers:",
      ...selection.anchors.map((node) => `- ${described(node)}, ref ${node.ref}`),
      selection.selectionCount > selection.anchors.length ? `(${selection.selectionCount} layers are selected; these are the ones Figloo found.)` : null,
      "",
      `Call get_anchor with tabId ${tab.tabId} first; its anchors should be ${refs}. If they differ, ask me to select these layers again. Then use ${tools}.`,
    ]
      .filter((line) => line !== null)
      .join("\n");
  }
  const path = [snapshot.page, ...[...selection.ancestors].reverse().map((node) => node.name), anchor.name].filter(Boolean).join(" > ");
  const shown = selection.children.slice(0, PROMPT_CHILDREN).map(described);
  const total = selection.childrenTotal ?? selection.children.length;
  const more = total - shown.length;
  const rest = more > 0 ? `, and ${more} more` : selection.childrenHasMore ? ", and more" : "";
  const children = shown.length > 0 ? `Children: ${shown.join(", ")}${rest}` : null;
  const screen = isPage(selection);
  return [
    screen ? "I want to implement the Figma page I selected in my browser; use the Figloo MCP tools." : "Use the Figloo MCP tools to work on the Figma layer I selected in my browser.",
    "",
    file,
    page,
    `Layer: ${described(anchor)}, ref ${anchor.ref}`,
    `Path: ${path}`,
    children,
    anchor.link ? `Link: ${anchor.link}` : null,
    "",
    `Call get_anchor with tabId ${tab.tabId} first; it should return ref ${anchor.ref}. If it returns another layer, ask me to select this one again. ` +
      (screen
        ? "Then call snapshot_layer on it: it reads every layer of the page at once, with a screenshot, which takes up to three minutes while I leave Figma alone. Look layers up with query_snapshot, and use export_asset for icons and images."
        : `Then use ${tools}.`),
  ]
    .filter((line) => line !== null)
    .join("\n");
}
