import type { SessionIdentity } from "@figloo/protocol";

export const DEFAULT_PORT = 47129;

/** Connection state kept by the service worker and shown on the options page. */
export interface ConnectionState {
  phase: "unpaired" | "disconnected" | "connecting" | "connected";
  port: number | null;
  connectedAt: number | null;
  lastError: string | null;
  attempts: number;
  tabCount: number;
  /** The connected server's agent session; null while disconnected and for servers older than 0.2.0. */
  session: SessionIdentity | null;
  /** When a server last handed the extension over to another session's server. */
  lastHandoverAt: number | null;
}
