import { sessionLabel, type TabStatus } from "@figloo/protocol";
import type { ConnectionState } from "./state.js";

/** Toolbar icon sets. Gray is also the manifest default, so tabs without a design file show it. */
export const ICONS = {
  color: { 16: "icons/color-16.png", 32: "icons/color-32.png" },
  gray: { 16: "icons/gray-16.png", 32: "icons/gray-32.png" },
} as const;

/** Must match `action.default_title` in the manifest. */
export const DEFAULT_TITLE = "Figloo: no Figma design file in this tab";

export interface Badge {
  text: string;
  color: string;
  textColor: string;
}

export interface ActionAppearance {
  icon: keyof typeof ICONS;
  badge: Badge | null;
  title: string;
}

const WARNING: Badge = { text: "!", color: "#F59E0B", textColor: "#1F2937" };
const ERROR: Badge = { text: "!", color: "#DC2626", textColor: "#FFFFFF" };

export function agentLine({ phase, session }: Pick<ConnectionState, "phase" | "session">): string {
  switch (phase) {
    case "connected":
      return session ? `Agent: ${sessionLabel(session)}` : "Agent: connected";
    case "unpaired":
      return "Agent: not paired; open the Figloo options page";
    default:
      return "Agent: not connected; figloo-mcp starts with your coding agent";
  }
}

/**
 * The icon turns colorful only when Figloo can read the tab: READY as is, DEGRADED with a
 * warning badge. The tooltip names the file, the limitation if any, and the agent connection.
 */
export function actionAppearance(status: TabStatus | null, connection: Pick<ConnectionState, "phase" | "session">): ActionAppearance {
  if (!status) return { icon: "gray", badge: null, title: DEFAULT_TITLE };
  const file = status.fileName ? `“${status.fileName}”` : "this file";
  const title = (headline: string) => [headline, status.detail, agentLine(connection)].filter(Boolean).join("\n");
  switch (status.readiness) {
    case "READY":
      return { icon: "color", badge: null, title: title(`Figloo: ready on ${file}`) };
    case "DEGRADED":
      return { icon: "color", badge: WARNING, title: title(`Figloo: limited on ${file}`) };
    case "LOADING":
      return { icon: "gray", badge: null, title: title(`Figloo: waiting for ${file} to load`) };
    case "INCOMPATIBLE":
      return { icon: "gray", badge: ERROR, title: title(`Figloo: cannot read ${file}`) };
  }
}

export async function applyAppearance(tabId: number, appearance: ActionAppearance): Promise<void> {
  const { badge } = appearance;
  await Promise.all([
    chrome.action.setIcon({ tabId, path: ICONS[appearance.icon] }),
    chrome.action.setTitle({ tabId, title: appearance.title }),
    chrome.action.setBadgeText({ tabId, text: badge?.text ?? "" }),
    ...(badge
      ? [chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color }), chrome.action.setBadgeTextColor({ tabId, color: badge.textColor })]
      : []),
  ]);
}
