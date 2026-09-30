import type { LayerNode, TabStatus } from "@figloo/protocol";
import type { ConnectionState } from "./state.js";

/** The layer the user selected, as far as the popup shows it. */
export interface PopupSelection {
  anchor: LayerNode;
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
  const path = [snapshot.page, ...[...selection.ancestors].reverse().map((node) => node.name), anchor.name].filter(Boolean).join(" > ");
  const shown = selection.children.slice(0, PROMPT_CHILDREN).map(described);
  const total = selection.childrenTotal ?? selection.children.length;
  const more = total - shown.length;
  const rest = more > 0 ? `, and ${more} more` : selection.childrenHasMore ? ", and more" : "";
  const children = shown.length > 0 ? `Children: ${shown.join(", ")}${rest}` : null;
  return [
    "Use the Figloo MCP tools to work on the Figma layer I selected in my browser.",
    "",
    file,
    page,
    `Layer: ${described(anchor)}, ref ${anchor.ref}`,
    `Path: ${path}`,
    children,
    anchor.link ? `Link: ${anchor.link}` : null,
    "",
    `Call get_anchor with tabId ${tab.tabId} first; it should return ref ${anchor.ref}. If it returns another layer, ask me to select this one again. Then use ${tools}.`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}
