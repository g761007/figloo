export const DEFAULT_PORT = 47129;

/** Connection state kept by the service worker and shown on the options page. */
export interface ConnectionState {
  phase: "unpaired" | "disconnected" | "connecting" | "connected";
  port: number | null;
  connectedAt: number | null;
  lastError: string | null;
  attempts: number;
  tabCount: number;
}
