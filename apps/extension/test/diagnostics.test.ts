import { describe, expect, it } from "vitest";
import type { TabStatus } from "@figloo/protocol";
import { MAX_RECENT_ERRORS, buildDiagnostics, errorCodeOf, formatDiagnostics, type RecentError } from "../src/diagnostics.js";
import type { ConnectionState } from "../src/state.js";

const NOW = Date.parse("2026-10-02T10:00:00Z");
/** Put into every field that may hold design content, folder names, messages, or secrets. */
const SENTINEL = "SENTINEL";

const tab: TabStatus = {
  tabId: 7,
  windowId: 1,
  url: `https://www.figma.com/design/${SENTINEL}Key/${SENTINEL}-File?node-id=1-2`,
  title: `${SENTINEL} File – Figma`,
  fileKey: `${SENTINEL}Key`,
  fileName: `${SENTINEL} File`,
  nodeIdFromUrl: "1:2",
  readiness: "READY",
  access: "view",
  uiLocale: "en",
  capabilities: { layersPanel: true, focusTarget: true, propertiesPanel: true, mirrorDom: true, uiCollapsed: false },
  layerRowCount: 120,
  visible: true,
  probedAt: NOW,
  detail: null,
};

const connected: ConnectionState = {
  phase: "connected",
  port: 47129,
  connectedAt: NOW - 5 * 60_000,
  lastError: null,
  attempts: 0,
  tabCount: 1,
  session: { client: "Claude Code", project: `${SENTINEL}-project`, pid: 4242, startedAt: NOW - 3_600_000, serverVersion: "0.4.0" },
  lastHandoverAt: NOW - 2 * 60_000,
};

const recent: RecentError[] = [
  { op: "snapshot_layer", code: "TAB_IN_BACKGROUND", at: NOW - 10 * 60_000 },
  { op: "export_asset", code: "LAYER_HIDDEN", at: NOW - 2 * 60_000 },
];

const base = { extensionVersion: "0.4.0", userAgent: "Mozilla/5.0 Chrome/154.0", protocolVersion: "0.3.0", pinnedId: true };

describe("diagnostics", () => {
  it("leave out file, page, and layer names, links, folder names, error messages, and the token", () => {
    const leaky = [
      buildDiagnostics({ ...base, state: connected, server: { version: "0.4.0", protocolVersion: "0.3.0" }, tab, recentErrors: [{ ...recent[0]!, message: `page "${SENTINEL}"` } as RecentError] }),
      buildDiagnostics({ ...base, state: { ...connected, phase: "disconnected", session: null, lastError: `UNAUTHORIZED: pairing token ${SENTINEL}-token rejected for "${SENTINEL}"` }, tab }),
      buildDiagnostics({ ...base, state: { ...connected, phase: "disconnected", session: null, lastError: `layer ${SENTINEL} is no longer in the layers panel` }, tab }),
    ];
    for (const diagnostics of leaky) {
      // The worker hands the object itself to the popup, so it must be clean too, not only the text.
      expect(JSON.stringify(diagnostics)).not.toContain(SENTINEL);
      expect(formatDiagnostics(diagnostics, NOW)).not.toContain(SENTINEL);
    }
  });

  it("keep only the code of the connection's last error", () => {
    expect(errorCodeOf("no pairing token saved; open the Figloo options page")).toBe("not paired");
    expect(errorCodeOf("cannot reach ws://127.0.0.1:47129; is figloo-mcp running?")).toBe("cannot reach the MCP server");
    expect(errorCodeOf("4001 PROTOCOL_MISMATCH")).toBe("4001 PROTOCOL_MISMATCH");
    expect(errorCodeOf("UNAUTHORIZED: pairing token rejected")).toBe("UNAUTHORIZED");
    expect(errorCodeOf("the Figma page changed")).toBe("other");
    expect(errorCodeOf(null)).toBeNull();
  });

  it("read as a short report of the versions, the connection, the tab, and the latest errors", () => {
    const text = formatDiagnostics(buildDiagnostics({ ...base, state: connected, server: { version: "0.4.0", protocolVersion: "0.3.0" }, tab, designTabs: 2, recentErrors: recent }), NOW);
    expect(text.split("\n")).toEqual([
      "Figloo diagnostics",
      "Extension: 0.4.0, protocol 0.3.0, pinned ID: yes",
      "Browser: Mozilla/5.0 Chrome/154.0",
      "MCP server: connected on port 47129, connected 5 min ago; server 0.4.0, protocol 0.3.0, agent Claude Code",
      "Last handover between sessions: 2 min ago",
      "Figma design tabs: 2; snapshot running in this tab: no",
      "This tab: READY, view access, UI language en, on screen: yes",
      "Figma UI found: layers panel yes, keyboard target yes, properties panel yes, screen reader mirror yes, UI minimized no, layer rows 120",
      "Recent errors: export_asset LAYER_HIDDEN 2 min ago; snapshot_layer TAB_IN_BACKGROUND 10 min ago",
      "",
    ]);
  });

  it("say why the extension is not connected, and what it knows without the service worker", () => {
    const disconnected = { ...connected, phase: "disconnected" as const, session: null, connectedAt: null, attempts: 3, lastHandoverAt: null, lastError: "cannot reach ws://127.0.0.1:47129; is figloo-mcp running?" };
    const text = formatDiagnostics(buildDiagnostics({ ...base, state: disconnected, tab: { ...tab, readiness: "LOADING", detail: "layers panel not found yet" } }), NOW);
    expect(text).toContain("MCP server: disconnected on port 47129, attempts 3, last error cannot reach the MCP server");
    expect(text).toContain("This tab: LOADING (layers panel not found yet)");
    expect(text).toContain("Recent errors: none");

    const alone = formatDiagnostics(buildDiagnostics({ extensionVersion: "0.4.0", userAgent: "Mozilla/5.0" }), NOW);
    expect(alone).toContain("Extension: 0.4.0, protocol unknown, pinned ID: unknown");
    expect(alone).toContain("Service worker: not reachable from the popup");
    expect(alone).toContain("This tab: not a Figma design file");
  });

  it(`keep the last ${MAX_RECENT_ERRORS} errors`, () => {
    const many = Array.from({ length: MAX_RECENT_ERRORS + 2 }, (_, i) => ({ op: `op${i}`, code: "TIMEOUT", at: NOW - (20 - i) * 1000 }));
    const listed = buildDiagnostics({ ...base, state: connected, recentErrors: many }).worker!.recentErrors.map((e) => e.op);
    expect(listed).toEqual(many.slice(2).map((e) => e.op));
  });
});
