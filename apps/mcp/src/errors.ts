/** What kind of problem an error code is, so an agent can tell setup problems from passing ones. */
export type ErrorCategory = "connection" | "compatibility" | "context" | "user_action" | "figma_ui" | "export" | "snapshot" | "filesystem" | "request" | "internal";

/**
 * Whether calling the same tool again can help: "yes" as it is, perhaps after a short wait;
 * "after_user" once the user did what the hint asks; "no" without a different call first.
 */
export type ErrorRetry = "yes" | "after_user" | "no";

export interface ErrorInfo {
  category: ErrorCategory;
  retry: ErrorRetry;
  /** The next step for the agent. */
  hint: string;
}

/** Error codes only the MCP server reports, beyond those of the bridge protocol. */
export const SERVER_ERROR_CODES = ["INVALID_ARGUMENT", "SAVE_REFUSED", "SNAPSHOT_EXPIRED", "SNAPSHOT_INCOMPLETE", "SNAPSHOT_NOT_FOUND", "SUBTREE_TOO_LARGE"] as const;

export const ERRORS: Record<string, ErrorInfo> = {
  NOT_CONNECTED: { category: "connection", retry: "after_user", hint: "Call get_status for setup steps." },
  TIMEOUT: { category: "connection", retry: "yes", hint: "The Figma tab did not answer in time; call get_status." },
  UNAUTHORIZED: {
    category: "connection",
    retry: "after_user",
    hint: "The extension's pairing token does not match this server's. Ask the user to run figloo-mcp pair and paste the token and port into the extension's options page.",
  },
  BUSY: {
    category: "connection",
    retry: "yes",
    hint: "Another operation is running in this tab, or Figloo is working for another agent session (the message names it); retry after a few seconds.",
  },
  PROTOCOL_MISMATCH: {
    category: "compatibility",
    retry: "after_user",
    hint: "The extension and this server speak different bridge protocol versions. Call get_status, which says which one the user should update.",
  },
  TAB_NOT_FOUND: { category: "context", retry: "no", hint: "Call get_status to list the open Figma tabs and their tabId." },
  CONTEXT_NOT_FOUND: { category: "context", retry: "no", hint: "The context was released or expired; call get_anchor again." },
  CONTEXT_EXPIRED: { category: "context", retry: "no", hint: "The Figma tab reloaded or switched files; call get_anchor again." },
  PAGE_CHANGED: { category: "context", retry: "no", hint: "The user switched to another Figma page; call get_anchor again." },
  UNKNOWN_REF: { category: "context", retry: "no", hint: "Pass a ref returned earlier in this context." },
  INVALID_CURSOR: { category: "context", retry: "no", hint: "Pass nextCursor exactly as returned, with the same contextId, ref, and relation." },
  NODE_NOT_FOUND: { category: "context", retry: "no", hint: "The layer is no longer in the layers panel; call get_anchor again." },
  NO_SELECTION: { category: "user_action", retry: "after_user", hint: "Ask the user to select the layers to work on in Figma, then call get_anchor again." },
  TAB_IN_BACKGROUND: {
    category: "user_action",
    retry: "after_user",
    hint: "Ask the user to bring the Figma tab to the front (visible on screen, it may sit beside other windows), then retry. Reading pages, the selection, and already expanded layers still works from the background.",
  },
  USER_INTERRUPTED: { category: "user_action", retry: "after_user", hint: "The user interacted with Figma during the operation. Check with the user before retrying." },
  UI_NOT_READY: { category: "figma_ui", retry: "no", hint: "Call get_status to see what the Figma tab can do right now." },
  BUDGET_EXCEEDED: { category: "figma_ui", retry: "yes", hint: "The operation ran out of its time or UI budget; narrow the request or retry." },
  EXPORT_BLOCKED: {
    category: "export",
    retry: "after_user",
    hint: "Figma handed over no file and the browser started no download. If the browser blocked repeated downloads from figma.com, ask the user to allow them in the site settings, then retry.",
  },
  EXPORT_PENDING: {
    category: "export",
    retry: "after_user",
    hint: "The browser is waiting to save the export, probably behind a Save dialog. Ask the user to confirm it, or to turn off asking where to save each file.",
  },
  LAYER_HIDDEN: {
    category: "export",
    retry: "no",
    hint: "Figma exports nothing for a hidden layer or one inside a hidden layer. Leave it out, or ask the user whether it should be shown in Figma.",
  },
  SAVE_REFUSED: { category: "filesystem", retry: "no", hint: "saveTo must be a path inside the project directory, and existing files are only replaced with overwrite: true." },
  INSIDE_INSTANCE: {
    category: "snapshot",
    retry: "no",
    hint: "Layers inside an instance get new IDs when the page reloads, so a snapshot needs a root outside instances: use the instance itself or a layer above it.",
  },
  SUBTREE_TOO_LARGE: {
    category: "snapshot",
    retry: "no",
    hint: "Snapshot a smaller root: call snapshot_layer on one of the children listed in the message, or on a layer further down.",
  },
  SNAPSHOT_NOT_FOUND: {
    category: "snapshot",
    retry: "no",
    hint: "Pass the snapshot id exactly as snapshot_layer returned it; without one, take a snapshot with snapshot_layer.",
  },
  SNAPSHOT_EXPIRED: { category: "snapshot", retry: "no", hint: "Take a new snapshot with snapshot_layer, which needs a contextId from get_anchor or explore_page." },
  SNAPSHOT_INCOMPLETE: {
    category: "snapshot",
    retry: "no",
    hint: "Call snapshot_layer again with the same root until it returns complete: true; each call reads on where the last one stopped.",
  },
  INVALID_ARGUMENT: { category: "request", retry: "no", hint: "Check the tool's parameters against its description." },
  BAD_MESSAGE: { category: "request", retry: "no", hint: "Figloo could not read a message between its parts; ask the user to report it with the Diagnostics from the Figloo popup." },
  INTERNAL: { category: "internal", retry: "no", hint: "Something failed inside Figloo; the message says what. Ask the user to report it with the Diagnostics from the Figloo popup if it happens again." },
};

/** The category, retry advice, and hint of a code, with a tool's own wording of the hint where it has one. */
export function describeError(code: string, hints: Record<string, string> = {}): ErrorInfo {
  const info = ERRORS[code] ?? ERRORS.INTERNAL!;
  return { ...info, hint: hints[code] ?? info.hint };
}
