import type { TabCapabilities, TabStatus } from "@figloo/protocol";
import type { ConnectionState } from "./state.js";

/**
 * Diagnostics a user pastes into a GitHub issue. Everything here comes from an allowlist of fields
 * that describe Figloo, the browser, and Figma's UI, never the design: no file, page, or layer
 * names, no URLs or file keys, no project folder names, no error messages, and no pairing token.
 */

/** An op that failed lately, by its code only: messages can name pages and layers. */
export interface RecentError {
  op: string;
  code: string;
  at: number;
}

export const MAX_RECENT_ERRORS = 10;

export interface Diagnostics {
  extension: { version: string; protocolVersion: string | null; pinnedId: boolean | null };
  browser: string;
  /** null when the popup could not reach the service worker. */
  worker: {
    phase: ConnectionState["phase"];
    port: number | null;
    attempts: number;
    connectedAt: number | null;
    lastError: string | null;
    lastHandoverAt: number | null;
    server: { version: string | null; protocolVersion: string | null; client: string | null } | null;
    designTabs: number;
    snapshotRunning: boolean;
    recentErrors: RecentError[];
  } | null;
  tab: {
    readiness: TabStatus["readiness"];
    detail: string | null;
    access: TabStatus["access"];
    uiLocale: string | null;
    visible: boolean | null;
    capabilities: TabCapabilities;
    layerRowCount: number;
    /** Names of the parts of Figma's page Figloo expects but did not find. */
    missingAnchors: string[];
  } | null;
}

export interface DiagnosticsInput {
  extensionVersion: string;
  userAgent: string;
  protocolVersion?: string;
  pinnedId?: boolean;
  state?: ConnectionState;
  server?: { version: string | null; protocolVersion: string | null };
  tab?: TabStatus | null;
  designTabs?: number;
  snapshotRunning?: boolean;
  recentErrors?: RecentError[];
}

/**
 * The connection's last error as a code. The worker writes fixed sentences, close codes with the
 * bridge's reason, or "CODE: message" from the bridge; only the code and the reason are kept.
 */
export function errorCodeOf(lastError: string | null): string | null {
  if (!lastError) return null;
  const coded = /^([A-Z][A-Z_]+):/.exec(lastError);
  if (coded) return coded[1]!;
  const closed = /^(\d{4}) ([A-Z][A-Z_]+)$/.exec(lastError);
  if (closed) return `${closed[1]} ${closed[2]}`;
  if (lastError.startsWith("cannot reach ws://")) return "cannot reach the MCP server";
  if (lastError.startsWith("no pairing token")) return "not paired";
  return "other";
}

export function buildDiagnostics(input: DiagnosticsInput): Diagnostics {
  const { state, tab } = input;
  return {
    extension: { version: input.extensionVersion, protocolVersion: input.protocolVersion ?? null, pinnedId: input.pinnedId ?? null },
    browser: input.userAgent,
    worker: state
      ? {
          phase: state.phase,
          port: state.port,
          attempts: state.attempts,
          connectedAt: state.connectedAt,
          lastError: errorCodeOf(state.lastError),
          lastHandoverAt: state.lastHandoverAt,
          // The session's project is a folder name, so only the agent's name and the versions go along.
          server:
            state.phase === "connected"
              ? { version: input.server?.version ?? state.session?.serverVersion ?? null, protocolVersion: input.server?.protocolVersion ?? null, client: state.session?.client ?? null }
              : null,
          designTabs: input.designTabs ?? state.tabCount,
          snapshotRunning: input.snapshotRunning ?? false,
          recentErrors: (input.recentErrors ?? []).slice(-MAX_RECENT_ERRORS).map(({ op, code, at }) => ({ op, code, at })),
        }
      : null,
    tab: tab
      ? {
          readiness: tab.readiness,
          detail: tab.detail,
          access: tab.access,
          uiLocale: tab.uiLocale,
          visible: tab.visible,
          capabilities: { ...tab.capabilities },
          layerRowCount: tab.layerRowCount,
          missingAnchors: [...(tab.missingAnchors ?? [])],
        }
      : null,
  };
}

function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 90) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

const yesNo = (value: boolean | null) => (value === null ? "unknown" : value ? "yes" : "no");

/** The diagnostics as lines of text, with times relative to `now`. */
export function formatDiagnostics(d: Diagnostics, now: number): string {
  const lines = ["Figloo diagnostics", `Extension: ${d.extension.version}, protocol ${d.extension.protocolVersion ?? "unknown"}, pinned ID: ${yesNo(d.extension.pinnedId)}`, `Browser: ${d.browser}`];
  const w = d.worker;
  if (!w) {
    lines.push("Service worker: not reachable from the popup");
  } else {
    const where = w.port === null ? "" : ` on port ${w.port}`;
    if (w.phase === "connected") {
      const since = w.connectedAt === null ? "" : `, connected ${ago(w.connectedAt, now)}`;
      const server = w.server ? `; server ${w.server.version ?? "unknown"}, protocol ${w.server.protocolVersion ?? "unknown"}, agent ${w.server.client ?? "unknown"}` : "";
      lines.push(`MCP server: connected${where}${since}${server}`);
    } else {
      lines.push(`MCP server: ${w.phase}${where}, attempts ${w.attempts}${w.lastError ? `, last error ${w.lastError}` : ""}`);
    }
    if (w.lastHandoverAt !== null) lines.push(`Last handover between sessions: ${ago(w.lastHandoverAt, now)}`);
    lines.push(`Figma design tabs: ${w.designTabs}; snapshot running in this tab: ${yesNo(w.snapshotRunning)}`);
  }
  const t = d.tab;
  if (!t) {
    lines.push("This tab: not a Figma design file");
  } else {
    lines.push(`This tab: ${t.readiness}${t.detail ? ` (${t.detail})` : ""}, ${t.access} access, UI language ${t.uiLocale ?? "unknown"}, on screen: ${yesNo(t.visible)}`);
    const c = t.capabilities;
    lines.push(
      `Figma UI found: layers panel ${yesNo(c.layersPanel)}, keyboard target ${yesNo(c.focusTarget)}, properties panel ${yesNo(c.propertiesPanel)}, screen reader mirror ${yesNo(c.mirrorDom)}, UI minimized ${yesNo(c.uiCollapsed)}, layer rows ${t.layerRowCount}`,
    );
    lines.push(`Figma UI not found: ${t.missingAnchors.length > 0 ? t.missingAnchors.join(", ") : "none"}`);
  }
  if (w) {
    const recent = [...w.recentErrors].reverse().map((e) => `${e.op} ${e.code} ${ago(e.at, now)}`);
    lines.push(`Recent errors: ${recent.length > 0 ? recent.join("; ") : "none"}`);
  }
  return `${lines.join("\n")}\n`;
}
