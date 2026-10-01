import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PROTOCOL_VERSION, RefreshTabsResultSchema, StatusReportSchema, type StatusReport } from "@figloo/protocol";
import type { Bridge } from "./bridge.js";
import { configDir } from "./config.js";
import { ContextStore } from "./contexts.js";
import { registerExplorationTools } from "./exploration.js";
import { SnapshotStore } from "./snapshots.js";
import { overallStatus, statusHint } from "./status.js";

export interface ServerDeps {
  bridge: Bridge;
  version: string;
  refreshTimeoutMs?: number;
  contexts?: ContextStore;
  log?: (message: string) => void;
  root?: string;
  /** Where snapshots are kept; ~/.figloo/snapshots with a 24-hour lifetime by default. */
  snapshots?: SnapshotStore;
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "figloo", version: deps.version });

  server.registerTool(
    "get_status",
    {
      description:
        "Report whether the Figloo browser extension is connected, which Figma design tabs are open, and what each tab can read. Call this first.",
      outputSchema: StatusReportSchema,
    },
    async () => {
      const report = await buildStatusReport(deps.bridge, deps.refreshTimeoutMs);
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }], structuredContent: report };
    },
  );

  registerExplorationTools(server, {
    bridge: deps.bridge,
    contexts: deps.contexts ?? new ContextStore(),
    log: deps.log ?? ((message) => console.error(`[figloo] ${message}`)),
    ...(deps.root ? { root: deps.root } : {}),
    snapshots: deps.snapshots ?? new SnapshotStore(join(configDir(), "snapshots")),
  });

  return server;
}

/** Asks the extension for fresh tab statuses when it is connected, then assembles the report. */
export async function buildStatusReport(bridge: Bridge, refreshTimeoutMs = 3_000): Promise<StatusReport> {
  let { tabs } = bridge.getTabs();
  let tabsFresh = false;
  if (bridge.connected) {
    try {
      tabs = RefreshTabsResultSchema.parse(await bridge.request("refresh_tabs", undefined, refreshTimeoutMs)).tabs;
      tabsFresh = true;
    } catch (error) {
      bridge.lastError = error instanceof Error ? error.message : String(error);
    }
  }
  const report: StatusReport = {
    status: overallStatus(bridge.connected, tabs),
    protocolVersion: PROTOCOL_VERSION,
    bridge: { listening: bridge.listening, port: bridge.port, error: bridge.listenError },
    extension: {
      connected: bridge.connected,
      extensionVersion: bridge.extension?.extensionVersion ?? null,
      userAgent: bridge.extension?.userAgent ?? null,
      connectedAt: bridge.extension?.connectedAt ?? null,
      lastDisconnectAt: bridge.lastDisconnectAt,
      lastError: bridge.lastError,
    },
    tabs,
    tabsFresh,
    hint: null,
  };
  report.hint = statusHint(report);
  return report;
}
