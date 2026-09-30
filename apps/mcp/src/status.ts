import type { ConnectionStatus, StatusReport, TabStatus } from "@figloo/protocol";

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
  if (!report.bridge.listening) {
    return `The local bridge is not listening on port ${report.bridge.port}${report.bridge.error ? `: ${report.bridge.error}` : ""}.`;
  }
  switch (report.status) {
    case "DISCONNECTED":
      return "The Figloo extension has not connected. Install it, run `figloo-mcp pair`, and paste the token and port into the extension options page.";
    case "NO_DESIGN_TAB":
      return "No Figma design tab is open in the paired browser. Open a file under https://www.figma.com/design/ and call get_status again.";
    case "LOADING":
      return "A Figma tab is still loading. Call get_status again in a few seconds.";
    case "DEGRADED":
    case "INCOMPATIBLE":
      return report.tabs.find((tab) => tab.readiness === report.status)?.detail ?? null;
    default:
      return null;
  }
}
