import type { InspectGroup, InspectedSection } from "@figloo/protocol";

const SECTION_SUFFIX = "-inspection-panel";

/** Which request group each inspection panel section belongs to. */
const GROUP_OF_SECTION: Record<string, InspectGroup> = {
  properties: "layout",
  colors: "appearance",
  borders: "appearance",
  shadows: "appearance",
  images: "appearance",
  content: "typography",
  componentProps: "component",
  selection_hierarchy: "component",
};

/** Sections Figloo reads values from; when one shows something but yields nothing, Figloo did not understand it. */
const VALUE_SECTIONS = new Set(["properties", "colors", "borders", "shadows", "content", "componentProps", "selection_hierarchy"]);

export function groupOf(kind: string): InspectGroup | "other" {
  if (kind.startsWith("typography")) return "typography";
  return GROUP_OF_SECTION[kind] ?? "other";
}

/** The right sidebar, which in a view-only session holds the inspection panel. */
export function inspectionRoot(doc: Document): Element | null {
  return doc.querySelector('[role="region"][aria-label="Right sidebar"]');
}

/** Whether the right sidebar holds the Design panel editors get instead of the inspection panel (seen on 2026-10-07). */
export function showsDesignPanel(doc: Document): boolean {
  const tabs = [...(inspectionRoot(doc)?.querySelectorAll('[role="tab"]') ?? [])].map((tab) => tab.textContent?.trim() ?? "");
  return tabs.some((tab) => tab.startsWith("Design")) && !tabs.some((tab) => tab.includes("Properties"));
}

/** The block above the first section that names the selected layer. */
export function inspectionHeader(doc: Document): string | null {
  const first = inspectionRoot(doc)?.querySelector(`[data-testid$="${SECTION_SUFFIX}"]`);
  const header = first ? [...(first.parentElement?.children ?? [])].find((el) => !el.hasAttribute("data-testid")) : undefined;
  return header?.textContent?.replace(/\s+/g, " ").trim() || null;
}

/** A cheap fingerprint of the panel, to notice when it re-renders for another layer. */
export function inspectionSignature(doc: Document): string {
  const root = inspectionRoot(doc);
  if (!root) return "";
  return [...root.querySelectorAll(`[data-testid$="${SECTION_SUFFIX}"]`)].map((el) => el.textContent ?? "").join("|");
}

/** Every section except export, in panel order. Values are kept exactly as the panel shows them. */
export function readInspection(root: ParentNode): InspectedSection[] {
  const sections: InspectedSection[] = [];
  for (const el of root.querySelectorAll(`[data-testid$="${SECTION_SUFFIX}"]`)) {
    const kind = el.getAttribute("data-testid")!.slice(0, -SECTION_SUFFIX.length);
    if (kind === "export") continue;
    const section: InspectedSection = {
      kind,
      group: groupOf(kind),
      title: el.querySelector('[data-testid="inspectPanelTitle"]')?.textContent?.trim() || null,
      properties: readProperties(el),
      colors: readColors(el),
      text: readText(kind, el),
    };
    const readsValues = VALUE_SECTIONS.has(kind) || kind.startsWith("typography");
    const showsMore = (el.textContent ?? "").replace(section.title ?? "", "").trim().length > 0;
    if (readsValues && showsMore && section.properties.length === 0 && section.colors.length === 0 && section.text === null) section.unreadable = true;
    sections.push(section);
  }
  return sections;
}

// Rows are copy buttons labelled "Copy Width: 393px" or, inside a group, "Copy Padding—Top: 24px".
const COPY_LABEL = /^Copy (.+?): ([\s\S]*)$/;

function readProperties(section: Element): InspectedSection["properties"] {
  const out: InspectedSection["properties"] = [];
  for (const el of section.querySelectorAll('[aria-label^="Copy "]')) {
    const match = COPY_LABEL.exec(el.getAttribute("aria-label") ?? "");
    if (!match) continue;
    const [, label, value] = match;
    const dash = label.indexOf("—");
    out.push(dash >= 0 ? { group: label.slice(0, dash), name: label.slice(dash + 1), value } : { group: null, name: label, value });
  }
  return out;
}

function readColors(section: Element): InspectedSection["colors"] {
  const out: InspectedSection["colors"] = [];
  for (const el of section.querySelectorAll('[data-testid="inspectColorRow"]')) {
    const value = el.textContent?.trim() ?? "";
    if (!value) continue;
    // The opacity, when it is not 100%, is the next span in the same row.
    const next = el.nextElementSibling?.textContent?.trim() ?? "";
    out.push({ value, opacity: /^\d+(\.\d+)?%$/.test(next) ? next : null });
  }
  return out;
}

function readText(kind: string, section: Element): string | null {
  if (kind === "content") {
    const parts = [...section.querySelectorAll('[dir="auto"]')].map((el) => el.textContent ?? "");
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (kind === "selection_hierarchy") {
    // The parent component's name is the one button without an aria-label.
    const button = [...section.querySelectorAll("button")].find((el) => !el.hasAttribute("aria-label"));
    return button?.textContent?.trim() || null;
  }
  return null;
}
