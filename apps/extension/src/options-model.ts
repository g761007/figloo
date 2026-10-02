import { sessionLabel } from "@figloo/protocol";
import type { ConnectionState } from "./state.js";

/** The connection details the options page shows. */
export function formatState(state: ConnectionState): string {
  const lines = [`Connection: ${state.phase}${state.port ? ` (port ${state.port})` : ""}`];
  if (state.session) lines.push(`Agent session: ${sessionLabel(state.session)}`);
  if (state.connectedAt) lines.push(`Connected since: ${new Date(state.connectedAt).toLocaleTimeString()}`);
  if (state.phase === "connected") lines.push(`Figma design tabs: ${state.tabCount}`);
  if (state.lastHandoverAt) lines.push(`Last handover between sessions: ${new Date(state.lastHandoverAt).toLocaleTimeString()}`);
  if (state.lastError) lines.push(`Last error: ${state.lastError}`);
  return lines.join("\n");
}
