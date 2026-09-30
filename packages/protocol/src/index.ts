import { z } from "zod";

export const PROTOCOL_VERSION = "0.1.0";

/** Chrome extension ID pinned by the `key` field in apps/extension/static/manifest.json. */
export const EXTENSION_ID = "offikfnknfkgijgianpfcghbccmkcjnb";

/** Two protocol versions are compatible when their major matches; for 0.x the minor must match too. */
export function protocolCompatible(a: string, b: string): boolean {
  const [aMajor, aMinor] = a.split(".");
  const [bMajor, bMinor] = b.split(".");
  if (aMajor !== bMajor) return false;
  return aMajor !== "0" || aMinor === bMinor;
}

export const ConnectionStatusSchema = z.enum([
  "DISCONNECTED",
  "NO_DESIGN_TAB",
  "LOADING",
  "READY",
  "DEGRADED",
  "INCOMPATIBLE",
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

export const TabReadinessSchema = z.enum(["LOADING", "READY", "DEGRADED", "INCOMPATIBLE"]);
export type TabReadiness = z.infer<typeof TabReadinessSchema>;

export const FieldStatusSchema = z.enum([
  "observed",
  "mixed",
  "not_exposed",
  "unsupported",
  "read_failed",
]);
export type FieldStatus = z.infer<typeof FieldStatusSchema>;

export const NeighborRelationSchema = z.enum(["parent", "ancestors", "siblings", "children"]);
export type NeighborRelation = z.infer<typeof NeighborRelationSchema>;

export const ErrorCodeSchema = z.enum(["USER_INTERRUPTED"]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** How the current Figma session may use the file, as far as the web UI reveals it. */
export const FileAccessSchema = z.enum(["edit", "view", "guest", "unknown"]);
export type FileAccess = z.infer<typeof FileAccessSchema>;

/** UI surfaces the content script could find during its readiness probe. */
export const TabCapabilitiesSchema = z.object({
  layersPanel: z.boolean(),
  focusTarget: z.boolean(),
  propertiesPanel: z.boolean(),
  mirrorDom: z.boolean(),
  /** Figma's "Minimize UI" mode hides the panels entirely; the layers panel is not in the DOM then. */
  uiCollapsed: z.boolean(),
});
export type TabCapabilities = z.infer<typeof TabCapabilitiesSchema>;

/** Raw probe result produced inside a Figma tab by the content script. */
export const ProbeResultSchema = z.object({
  href: z.string(),
  readyState: z.string(),
  msSinceLoad: z.number().nonnegative(),
  uiLocale: z.string().nullable(),
  fileName: z.string().nullable(),
  access: FileAccessSchema,
  capabilities: TabCapabilitiesSchema,
  layerRowCount: z.number().int().nonnegative(),
  selectedCount: z.number().int().nonnegative().nullable(),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

/** Per-tab status as tracked by the extension service worker. */
export const TabStatusSchema = z.object({
  tabId: z.number().int(),
  windowId: z.number().int(),
  url: z.string(),
  title: z.string(),
  fileKey: z.string().nullable(),
  fileName: z.string().nullable(),
  nodeIdFromUrl: z.string().nullable(),
  readiness: TabReadinessSchema,
  access: FileAccessSchema,
  uiLocale: z.string().nullable(),
  capabilities: TabCapabilitiesSchema,
  layerRowCount: z.number().int().nonnegative(),
  probedAt: z.number().nullable(),
  detail: z.string().nullable(),
});
export type TabStatus = z.infer<typeof TabStatusSchema>;

export const BridgeErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "PROTOCOL_MISMATCH",
  "BAD_MESSAGE",
  "TIMEOUT",
  "NOT_CONNECTED",
  "TAB_NOT_FOUND",
  "INTERNAL",
]);
export type BridgeErrorCode = z.infer<typeof BridgeErrorCodeSchema>;

export const BridgeOpSchema = z.enum(["refresh_tabs"]);
export type BridgeOp = z.infer<typeof BridgeOpSchema>;

// Messages sent by the extension to the local bridge.
export const HelloMessageSchema = z.object({
  type: z.literal("hello"),
  protocolVersion: z.string(),
  token: z.string(),
  extensionVersion: z.string(),
  userAgent: z.string(),
});
export const PingMessageSchema = z.object({ type: z.literal("ping"), t: z.number() });
export const PongMessageSchema = z.object({ type: z.literal("pong"), t: z.number() });
export const TabsMessageSchema = z.object({ type: z.literal("tabs"), tabs: z.array(TabStatusSchema) });
export const ResponseMessageSchema = z.object({
  type: z.literal("response"),
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: BridgeErrorCodeSchema, message: z.string() }).optional(),
});

// Messages sent by the local bridge to the extension.
export const WelcomeMessageSchema = z.object({
  type: z.literal("welcome"),
  protocolVersion: z.string(),
  serverVersion: z.string(),
  heartbeatIntervalMs: z.number().positive(),
});
export const ErrorMessageSchema = z.object({
  type: z.literal("error"),
  code: BridgeErrorCodeSchema,
  message: z.string(),
});
export const RequestMessageSchema = z.object({
  type: z.literal("request"),
  id: z.string(),
  op: BridgeOpSchema,
  tabId: z.number().int().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const ExtensionMessageSchema = z.discriminatedUnion("type", [
  HelloMessageSchema,
  PingMessageSchema,
  PongMessageSchema,
  TabsMessageSchema,
  ResponseMessageSchema,
]);
export type ExtensionMessage = z.infer<typeof ExtensionMessageSchema>;

export const ServerMessageSchema = z.discriminatedUnion("type", [
  WelcomeMessageSchema,
  ErrorMessageSchema,
  PingMessageSchema,
  PongMessageSchema,
  RequestMessageSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type TabsMessage = z.infer<typeof TabsMessageSchema>;
export type RequestMessage = z.infer<typeof RequestMessageSchema>;
export type ResponseMessage = z.infer<typeof ResponseMessageSchema>;
export type WelcomeMessage = z.infer<typeof WelcomeMessageSchema>;

/** Result of the `refresh_tabs` request. */
export const RefreshTabsResultSchema = z.object({ tabs: z.array(TabStatusSchema) });

/** What `get_status` returns to the coding agent. */
export const StatusReportSchema = z.object({
  status: ConnectionStatusSchema,
  protocolVersion: z.string(),
  bridge: z.object({
    listening: z.boolean(),
    port: z.number().int(),
    error: z.string().nullable(),
  }),
  extension: z.object({
    connected: z.boolean(),
    extensionVersion: z.string().nullable(),
    userAgent: z.string().nullable(),
    connectedAt: z.number().nullable(),
    lastDisconnectAt: z.number().nullable(),
    lastError: z.string().nullable(),
  }),
  tabs: z.array(TabStatusSchema),
  tabsFresh: z.boolean(),
  hint: z.string().nullable(),
});
export type StatusReport = z.infer<typeof StatusReportSchema>;
