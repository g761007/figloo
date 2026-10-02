import { describe, expect, it } from "vitest";
import { formatState } from "../src/options-model.js";
import type { ConnectionState } from "../src/state.js";

const connected: ConnectionState = { phase: "connected", port: 47129, connectedAt: null, lastError: null, attempts: 0, tabCount: 2, session: null, lastHandoverAt: null };

describe("the options page status", () => {
  it("names the agent session and when the extension last moved between sessions", () => {
    const session = { client: "Claude Code", project: "shop", pid: 1, startedAt: new Date(2026, 9, 2, 9, 15).getTime(), serverVersion: "0.2.0" };
    const handover = new Date(2026, 9, 2, 10, 30, 5).getTime();
    const text = formatState({ ...connected, session, lastHandoverAt: handover });
    expect(text.split("\n")).toEqual([
      "Connection: connected (port 47129)",
      "Agent session: Claude Code · shop (started 09:15)",
      "Figma design tabs: 2",
      `Last handover between sessions: ${new Date(handover).toLocaleTimeString()}`,
    ]);
  });

  it("leaves both out for a server older than 0.2.0 that has not handed over", () => {
    expect(formatState(connected)).toBe("Connection: connected (port 47129)\nFigma design tabs: 2");
  });
});
