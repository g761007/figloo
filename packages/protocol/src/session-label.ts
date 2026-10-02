import type { SessionIdentity } from "./index.js";

/** Names a session the way the user sees it: client · project folder (start time). */
export function sessionLabel(session: SessionIdentity): string {
  const started = new Date(session.startedAt);
  const time = `${String(started.getHours()).padStart(2, "0")}:${String(started.getMinutes()).padStart(2, "0")}`;
  return `${session.client ? `${session.client} · ` : ""}${session.project} (started ${time})`;
}
