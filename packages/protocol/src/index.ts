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

/** Errors a tool call can end with, beyond transport problems. */
export const ErrorCodeSchema = z.enum([
  "USER_INTERRUPTED",
  "NO_SELECTION",
  "MULTIPLE_SELECTION",
  "NODE_NOT_FOUND",
  "PAGE_CHANGED",
  "UI_NOT_READY",
  "BUSY",
  "CONTEXT_NOT_FOUND",
  "CONTEXT_EXPIRED",
  "UNKNOWN_REF",
  "INVALID_CURSOR",
  "BUDGET_EXCEEDED",
  "TAB_IN_BACKGROUND",
]);
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
  /** Figma applies expand and select only while the tab is visible; reading works either way. */
  visible: z.boolean(),
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
  /** null when the content script could not be reached. */
  visible: z.boolean().nullable(),
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

export const BridgeOpSchema = z.enum(["refresh_tabs", "get_anchor", "list_neighbors", "list_pages", "explore_page", "inspect_nodes", "capture"]);
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
  error: z.object({ code: z.union([BridgeErrorCodeSchema, ErrorCodeSchema]), message: z.string() }).optional(),
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

/** Identifies one load of one Figma file in one tab; a reload or file switch produces a new pageId. */
export const PageIdentitySchema = z.object({
  pageId: z.string(),
  fileKey: z.string(),
  /** Name of the Figma page (canvas) shown in the pages list, when the list is visible. */
  page: z.string().nullable(),
});
export type PageIdentity = z.infer<typeof PageIdentitySchema>;

/** A layer as the layers panel shows it. */
export const LayerNodeSchema = z.object({
  /** Layer ID from the layers panel. IDs of layers inside an instance only hold for one page load. */
  ref: z.string(),
  name: z.string(),
  nameTruncated: z.boolean(),
  /** Layer type label from the layers panel icon, for example "Frame", "Text", or "Instance". */
  type: z.string().nullable(),
  /** 0 for layers directly on the page. */
  depth: z.number().int().nonnegative(),
  /** 1-based position among its siblings, in layers panel order. */
  position: z.number().int().positive(),
  siblingCount: z.number().int().positive(),
  /** null for layers directly on the page; for deeper layers, null means it could not be confirmed. */
  parentRef: z.string().nullable(),
  hasChildren: z.boolean(),
  /** Known once the children were listed; null otherwise. */
  childCount: z.number().int().nonnegative().nullable(),
  /** Whether an ancestor is an instance; null when the ancestors were not read. */
  insideInstance: z.boolean().nullable(),
  /** Figma link that selects this layer; only for layers outside instances, whose IDs are stable. */
  link: z.string().nullable(),
});
export type LayerNode = z.infer<typeof LayerNodeSchema>;

export const StopReasonSchema = z.enum(["complete", "limit", "time_budget", "scan_budget", "output_budget", "ui_timeout"]);
export type StopReason = z.infer<typeof StopReasonSchema>;

/** Neighbor lists are paged by position: sibling or child position, or ancestor distance (1 = parent). */
export const MAX_NEIGHBOR_LIMIT = 50;
export const DEFAULT_NEIGHBOR_LIMIT = 20;
export const MAX_NEIGHBOR_DEPTH = 3;
/** Plan budget: detailed reads cover at most five layers per call. */
export const MAX_INSPECT_REFS = 5;

export const ListNeighborsParamsSchema = z.object({
  expect: PageIdentitySchema,
  ref: z.string(),
  relation: NeighborRelationSchema,
  from: z.number().int().positive(),
  limit: z.number().int().positive().max(MAX_NEIGHBOR_LIMIT),
  /** Ref of the last layer returned by the previous page; lets the tab resume without rescanning. */
  after: z.string().optional(),
  /** For children only: levels below the ref to include, breadth first, within the same limit. */
  depth: z.number().int().min(1).max(MAX_NEIGHBOR_DEPTH).optional(),
});
export type ListNeighborsParams = z.infer<typeof ListNeighborsParamsSchema>;

/** Result of the `get_anchor` op, produced inside the Figma tab. */
export const AnchorResultSchema = z.object({
  identity: PageIdentitySchema,
  selectionCount: z.number().int().nonnegative(),
  anchor: LayerNodeSchema,
  uiOps: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
});
export type AnchorResult = z.infer<typeof AnchorResultSchema>;

/** Result of the `list_neighbors` op, produced inside the Figma tab. */
export const NeighborsResultSchema = z.object({
  identity: PageIdentitySchema,
  nodes: z.array(LayerNodeSchema),
  /** Number of layers in the relation, when the UI reveals it. */
  total: z.number().int().nonnegative().nullable(),
  from: z.number().int().positive(),
  nextFrom: z.number().int().positive().nullable(),
  hasMore: z.boolean(),
  stopReason: StopReasonSchema,
  uiOps: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
});
export type NeighborsResult = z.infer<typeof NeighborsResultSchema>;

/** What `get_anchor` returns to the coding agent. */
export const GetAnchorOutputSchema = z.object({
  contextId: z.string(),
  tabId: z.number().int(),
  fileKey: z.string(),
  page: z.string().nullable(),
  selectionCount: z.number().int().nonnegative(),
  anchor: LayerNodeSchema,
});
export type GetAnchorOutput = z.infer<typeof GetAnchorOutputSchema>;

/** What `get_neighbors` returns to the coding agent. */
export const GetNeighborsOutputSchema = z.object({
  contextId: z.string(),
  ref: z.string(),
  relation: NeighborRelationSchema,
  nodes: z.array(LayerNodeSchema),
  /** Positions covered by this page (ancestor distance for "ancestors"), and how many exist in total. */
  coverage: z.object({
    fromPosition: z.number().int().positive(),
    toPosition: z.number().int().positive().nullable(),
    total: z.number().int().nonnegative().nullable(),
  }),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  stopReason: StopReasonSchema,
  uiOps: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
});
export type GetNeighborsOutput = z.infer<typeof GetNeighborsOutputSchema>;

export const ReleaseContextOutputSchema = z.object({ released: z.boolean() });

/** Reply of the content script to an op forwarded by the service worker. */
export const TabOpResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.union([BridgeErrorCodeSchema, ErrorCodeSchema]), message: z.string() }).optional(),
});
export type TabOpResponse = z.infer<typeof TabOpResponseSchema>;

/** A page of the Figma file, as the pages list shows it. */
export const FigmaPageSchema = z.object({ name: z.string(), current: z.boolean() });
export type FigmaPage = z.infer<typeof FigmaPageSchema>;

export const ListPagesResultSchema = z.object({ fileKey: z.string(), pages: z.array(FigmaPageSchema) });
export type ListPagesResult = z.infer<typeof ListPagesResultSchema>;

export const ExplorePageParamsSchema = z.object({
  /** Page to open; the current page when omitted. Switching needs the tab to be visible. */
  page: z.string().optional(),
  limit: z.number().int().positive().max(MAX_NEIGHBOR_LIMIT),
});
export type ExplorePageParams = z.infer<typeof ExplorePageParamsSchema>;

/** Result of the `explore_page` op: the layers directly on the page. */
export const ExplorePageResultSchema = NeighborsResultSchema;
export type ExplorePageResult = NeighborsResult;

/** Groups of the view-only inspection panel an agent can ask for. */
export const InspectGroupSchema = z.enum(["layout", "appearance", "typography", "component"]);
export type InspectGroup = z.infer<typeof InspectGroupSchema>;

export const InspectParamsSchema = z.object({
  expect: PageIdentitySchema,
  refs: z.array(z.string()).min(1).max(MAX_INSPECT_REFS),
  groups: z.array(InspectGroupSchema).min(1).optional(),
});
export type InspectParams = z.infer<typeof InspectParamsSchema>;

/** One value as the inspection panel shows it, for example group "Padding", name "Top", value "24px". */
export const InspectedPropertySchema = z.object({
  group: z.string().nullable(),
  name: z.string(),
  value: z.string(),
});

export const InspectedColorSchema = z.object({
  /** Hex such as "#08458A", or the name of a color style when the panel shows one. */
  value: z.string(),
  opacity: z.string().nullable(),
});

/** One block of the inspection panel, in panel order. */
export const InspectedSectionSchema = z.object({
  /** Panel identifier, for example "properties", "colors", "borders", "shadows", "typography1", "content". */
  kind: z.string(),
  group: z.union([InspectGroupSchema, z.literal("other")]),
  title: z.string().nullable(),
  properties: z.array(InspectedPropertySchema),
  colors: z.array(InspectedColorSchema),
  /** Text content for "content", the parent component name for "selection_hierarchy". */
  text: z.string().nullable(),
});
export type InspectedSection = z.infer<typeof InspectedSectionSchema>;

export const InspectedNodeSchema = z.object({
  ref: z.string(),
  name: z.string(),
  type: z.string().nullable(),
  sections: z.array(InspectedSectionSchema),
  /** Requested groups the panel did not show for this layer; Figma hides what does not apply. */
  notShown: z.array(InspectGroupSchema),
});
export type InspectedNode = z.infer<typeof InspectedNodeSchema>;

export const InspectResultSchema = z.object({
  identity: PageIdentitySchema,
  nodes: z.array(InspectedNodeSchema),
  userSelectionRestored: z.boolean(),
  uiOps: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
});
export type InspectResult = z.infer<typeof InspectResultSchema>;

export const CaptureParamsSchema = z.object({
  expect: PageIdentitySchema,
  /** Layer to capture; the whole page when null. */
  ref: z.string().nullable(),
});
export type CaptureParams = z.infer<typeof CaptureParamsSchema>;

/** A rectangle in CSS pixels of the tab's viewport. */
export const RectSchema = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() });
export type Rect = z.infer<typeof RectSchema>;

/** Returned by the tab after it moved the view for a capture; the worker then captures and crops. */
export const CapturePlanSchema = z.object({
  identity: PageIdentitySchema,
  token: z.string(),
  crop: RectSchema,
  /** "layer" when the crop follows the layer's bounds, "canvas" when it is the visible canvas. */
  cropSource: z.enum(["layer", "canvas"]),
  viewport: z.object({ width: z.number().positive(), height: z.number().positive() }),
  zoom: z.string().nullable(),
});
export type CapturePlan = z.infer<typeof CapturePlanSchema>;

export const CaptureResultSchema = z.object({
  identity: PageIdentitySchema,
  image: z.object({ data: z.string(), mimeType: z.literal("image/jpeg"), width: z.number().int(), height: z.number().int() }),
  cropSource: z.enum(["layer", "canvas"]),
  zoom: z.string().nullable(),
  userSelectionRestored: z.boolean(),
  elapsedMs: z.number().nonnegative(),
});
export type CaptureResult = z.infer<typeof CaptureResultSchema>;

/** What `explore_page` returns to the coding agent. */
export const ExplorePageOutputSchema = z.object({
  contextId: z.string(),
  tabId: z.number().int(),
  fileKey: z.string(),
  page: z.string().nullable(),
  nodes: z.array(LayerNodeSchema),
  total: z.number().int().nonnegative().nullable(),
  hasMore: z.boolean(),
  /** Continue with get_neighbors(ref = nodes[0].ref, relation = "siblings", cursor = nextCursor). */
  nextCursor: z.string().nullable(),
});
export type ExplorePageOutput = z.infer<typeof ExplorePageOutputSchema>;

export const InspectNodesOutputSchema = z.object({
  contextId: z.string(),
  nodes: z.array(InspectedNodeSchema),
  userSelectionRestored: z.boolean(),
  uiOps: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
});
export type InspectNodesOutput = z.infer<typeof InspectNodesOutputSchema>;

export const CaptureOutputSchema = z.object({
  contextId: z.string(),
  ref: z.string().nullable(),
  width: z.number().int(),
  height: z.number().int(),
  cropSource: z.enum(["layer", "canvas"]),
  zoom: z.string().nullable(),
  userSelectionRestored: z.boolean(),
});
export type CaptureOutput = z.infer<typeof CaptureOutputSchema>;
