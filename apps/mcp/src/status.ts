import { compareVersions } from "./versions.js";
import { sessionLabel, type ConnectionStatus, type StatusReport, type TabLimitation, type TabStatus } from "@figloo/protocol";

/** Every tool that works in the Figma tab. */
const FIGMA_TOOLS = ["list_pages", "explore_page", "get_anchor", "get_neighbors", "get_visual_neighbors", "inspect_nodes", "capture", "export_asset", "export_assets", "snapshot_layer"];
/** Tools that select layers, which a guest cannot do; capture still shows the whole page. */
const SELECTING_TOOLS = ["get_anchor", "get_visual_neighbors", "inspect_nodes", "capture", "export_asset", "export_assets", "snapshot_layer"];

/** What a tab cannot do, from what the extension found in it; the tab's readiness covers tabs Figloo cannot read at all. */
export function tabLimitations(tab: TabStatus): TabLimitation[] {
  if (tab.readiness !== "READY" && tab.readiness !== "DEGRADED") return [];
  const { capabilities, access, uiLocale } = tab;
  if (capabilities.uiCollapsed && !capabilities.layersPanel) {
    return [
      {
        code: "UI_MINIMIZED",
        tools: FIGMA_TOOLS,
        detail: "Figma's UI is minimized, so the layers panel is not rendered.",
        fix: "Ask the user to press Cmd+\\ in Figma, or to click the button next to the file name.",
      },
    ];
  }
  const limits: TabLimitation[] = [];
  if (access === "guest") {
    limits.push({
      code: "GUEST",
      tools: SELECTING_TOOLS,
      detail: "A guest cannot select layers, so Figloo cannot read the selection, the inspection panel, or exports here; capture works for the whole page only.",
      fix: "Ask the user to sign in to Figma in this browser; view access to the file is enough.",
    });
  }
  if (access === "edit") {
    limits.push({
      code: "EDIT_ACCESS",
      tools: ["inspect_nodes", "snapshot_layer", "export_asset", "export_assets"],
      detail: "With edit access Figma shows the Design panel instead of the inspection panel Figloo reads; layers and screenshots still work.",
      fix: null,
    });
  }
  // A signed-in session always has these; a guest has neither.
  const lost = access === "guest" ? [] : (tab.missingAnchors ?? []).filter((name) => name === "rightSidebar" || name === "propertiesPanel");
  if (lost.length > 0) {
    limits.push({
      code: "UI_CHANGED",
      tools: ["inspect_nodes", "snapshot_layer", "export_asset", "export_assets"],
      detail: `Figloo cannot find ${lost.join(" or ")} in Figma's page, so Figma may have changed its UI, and these tools may fail.`,
      fix: "Ask the user to reload the Figma tab, and if that does not help, to report it with the Diagnostics from the Figloo popup.",
    });
  }
  if (!capabilities.focusTarget) {
    limits.push({
      code: "NO_KEYBOARD_TARGET",
      tools: ["capture", "snapshot_layer"],
      detail: "Figma's canvas keyboard target is missing, so Figloo cannot zoom to a layer or clear the selection with keys.",
      fix: "Ask the user to reload the Figma tab.",
    });
  }
  if (!capabilities.mirrorDom) {
    limits.push({
      code: "NO_SCREEN_READER_MIRROR",
      tools: ["get_visual_neighbors", "capture", "snapshot_layer"],
      detail: "Figma's screen reader mirror is off: get_visual_neighbors fails, capture crops by an estimate, snapshot_layer cannot place most layers, and neither puts the user's view back.",
      fix: "Ask the user to turn on Adapt content for screen readers under Main menu, Preferences, Accessibility settings.",
    });
  }
  if (uiLocale !== null && !/^en(-|$)/i.test(uiLocale)) {
    limits.push({
      code: "NOT_ENGLISH",
      tools: SELECTING_TOOLS,
      detail: `Figma's UI language is ${uiLocale}, and Figloo reads the panels by their English labels, so these tools may fail or misread them.`,
      fix: "Ask the user to switch Figma's language to English.",
    });
  }
  return limits;
}

/** Collapses the extension connection and per-tab readiness into the single status the plan defines. */
export function overallStatus(connected: boolean, tabs: TabStatus[]): ConnectionStatus {
  if (!connected) return "DISCONNECTED";
  if (tabs.length === 0) return "NO_DESIGN_TAB";
  if (tabs.some((tab) => tab.readiness === "READY")) return "READY";
  if (tabs.some((tab) => tab.readiness === "DEGRADED")) return "DEGRADED";
  if (tabs.some((tab) => tab.readiness === "LOADING")) return "LOADING";
  return "INCOMPATIBLE";
}

/** A one-line next step for the agent, or null when nothing needs attention. */
export function statusHint(report: StatusReport): string | null {
  const usable = report.tabs.filter((tab) => tab.readiness === "READY" || tab.readiness === "DEGRADED").length;
  const choose = usable > 1 ? `${usable} Figma design tabs are open: use the tabId in the prompt the user pasted, or ask the user which file to work on.` : null;
  if (report.bridge.role === "standby") {
    if (report.bridge.holder) {
      const serving = `Figloo is serving ${sessionLabel(report.bridge.holder)} right now; tabs are as that session last saw them. Any Figloo tool that needs Figma takes over once that session has been idle for 10 seconds.`;
      return [serving, choose].filter(Boolean).join(" ");
    }
    return `The local bridge is not listening on port ${report.bridge.port}${report.bridge.error ? `: ${report.bridge.error}` : ""}.`;
  }
  switch (report.status) {
    case "DISCONNECTED":
      return rejectedHint(report) ?? "The Figloo extension has not connected. Install it, run `figloo-mcp pair`, and paste the token and port into the extension options page.";
    case "NO_DESIGN_TAB":
      return "No Figma design tab is open in the paired browser. Open a file under https://www.figma.com/design/ and call get_status again.";
    case "LOADING":
      return "A Figma tab is still loading. Call get_status again in a few seconds.";
    case "DEGRADED":
    case "INCOMPATIBLE":
      return [report.tabs.find((tab) => tab.readiness === report.status)?.detail, choose].filter(Boolean).join(" ") || null;
    default: {
      // With one file open, say what it cannot do; with several, each tab lists its own limitations.
      const ready = report.tabs.filter((tab) => tab.readiness === "READY");
      const limited = usable === 1 && ready.length === 1 ? ready[0]!.limitations.map((l) => (l.fix ? `${l.detail} ${l.fix}` : l.detail)).join(" ") : "";
      return [limited, choose].filter(Boolean).join(" ") || null;
    }
  }
}

/** Why the bridge turned the extension away, and which side the user should update or pair again. */
function rejectedHint(report: StatusReport): string | null {
  const rejected = report.extension.rejected;
  if (!rejected) return null;
  const extension = `The Figloo extension ${rejected.extensionVersion}`;
  if (rejected.reason === "token") {
    return `${extension} offered a pairing token this server does not accept. Ask the user to run \`figloo-mcp pair\` and paste the token and port into the extension options page.`;
  }
  const server = report.bridge.holder?.serverVersion ?? "this server";
  const speaks = `${extension} speaks bridge protocol ${rejected.protocolVersion}, and the server ${server} speaks ${report.protocolVersion}.`;
  return compareVersions(rejected.protocolVersion, report.protocolVersion) < 0
    ? `${speaks} Ask the user to update the extension to ${server}, from the release files of that version or by building it, reload it on the browser's extensions page, and reload the Figma tab.`
    : `${speaks} Ask the user to update the Figloo plugin or server to ${rejected.extensionVersion}, then start a new agent session.`;
}
