import type { TabStatus } from "@figloo/protocol";
import { agentLine } from "./action.js";
import { buildPrompt, type PopupSnapshot } from "./popup-model.js";

export interface PopupHandlers {
  /** Resolves to whether the text reached the clipboard. */
  copy: (text: string) => Promise<boolean>;
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  // Layer and file names are shown as text, never parsed as markup.
  if (text !== undefined) node.textContent = text;
  return node;
}

function readinessLine(status: TabStatus): string {
  switch (status.readiness) {
    case "READY":
      return "Ready";
    case "DEGRADED":
      return `Limited: ${status.detail ?? "some parts of Figma's UI are missing"}`;
    case "LOADING":
      return `Loading: ${status.detail ?? "waiting for Figma"}`;
    case "INCOMPATIBLE":
      return `Cannot read this file: ${status.detail ?? "Figma's UI was not recognized"}`;
  }
}

function selectionHint(error: PopupSnapshot["selectionError"]): string {
  if (!error || error.code === "NO_SELECTION") {
    return "No layer is selected. Select one in Figma to see its structure, or copy the prompt below to let the agent explore the file.";
  }
  return error.message;
}

/** Renders the popup for one tab into `root`, replacing what was there. */
export function renderPopup(root: HTMLElement, snapshot: PopupSnapshot, handlers: PopupHandlers): void {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const { tab, selection, connection } = snapshot;

  const status = el(doc, "section", "status");
  if (!tab) {
    status.append(el(doc, "p", "file", "This tab has no Figma design file. Open one to use Figloo."));
  } else {
    status.append(el(doc, "p", "file", tab.fileName ?? tab.fileKey ?? "Figma file"));
    const where = [snapshot.page, tab.access === "unknown" ? null : `${tab.access} access`].filter(Boolean).join(" · ");
    if (where) status.append(el(doc, "p", "muted", where));
    status.append(el(doc, "p", `readiness ${tab.readiness.toLowerCase()}`, readinessLine(tab)));
  }
  status.append(el(doc, "p", `agent ${connection.phase}`, agentLine(connection)));
  root.append(status);

  const usable = tab !== null && (tab.readiness === "READY" || tab.readiness === "DEGRADED");
  if (!usable) return;

  const layer = el(doc, "section", "selection");
  if (selection && selection.anchors.length > 1) {
    const found = selection.anchors.length;
    layer.append(el(doc, "p", "muted", found < selection.selectionCount ? `${selection.selectionCount} layers selected; ${found} found in the layers panel` : `${found} layers selected`));
    const list = el(doc, "ul", "anchors");
    for (const node of selection.anchors) {
      const item = el(doc, "li", undefined, node.name);
      if (node.type) item.append(el(doc, "span", "type", node.type));
      list.append(item);
    }
    layer.append(list);
  } else if (selection) {
    const path = el(doc, "p", "path");
    const crumbs = [snapshot.page, ...[...selection.ancestors].reverse().map((node) => node.name)].filter((name): name is string => Boolean(name));
    crumbs.forEach((name) => path.append(el(doc, "span", "crumb", name)));
    layer.append(path);
    const title = el(doc, "h2", "layer", selection.anchor.name);
    if (selection.anchor.type) title.append(el(doc, "span", "type", selection.anchor.type));
    layer.append(title);
    if (selection.children.length > 0) {
      const shown = selection.children.length;
      const total = selection.childrenTotal;
      const count = total !== null && total > shown ? `Children: first ${shown} of ${total}` : selection.childrenHasMore ? `Children: first ${shown}` : `Children: ${shown}`;
      layer.append(el(doc, "p", "muted", count));
      const list = el(doc, "ul", "children");
      for (const child of selection.children) {
        const item = el(doc, "li", undefined, child.name);
        if (child.type) item.append(el(doc, "span", "type", child.type));
        list.append(item);
      }
      layer.append(list);
    } else {
      layer.append(el(doc, "p", "muted", selection.anchor.hasChildren ? "Its children could not be listed." : "No children."));
    }
  } else {
    layer.append(el(doc, "p", "hint", selectionHint(snapshot.selectionError)));
  }
  root.append(layer);

  const text = buildPrompt(snapshot);
  if (!text) return;
  const prompt = el(doc, "section", "prompt");
  const preview = el(doc, "textarea", "preview");
  preview.readOnly = true;
  preview.value = text;
  preview.rows = 6;
  const button = el(doc, "button", "copy", "Copy prompt for the agent");
  button.type = "button";
  const note = el(doc, "p", "muted", "Paste it into your coding agent and add what you want done.");
  button.addEventListener("click", () => {
    void handlers.copy(text).then((copied) => {
      if (copied) {
        button.textContent = "Copied";
        return;
      }
      // Without clipboard access, leave the text selected for the user to copy.
      preview.focus();
      preview.select();
      note.textContent = "Copying was not allowed here. The prompt is selected; press Cmd+C or Ctrl+C.";
    });
  });
  prompt.append(button, preview, note);
  root.append(prompt);
}
