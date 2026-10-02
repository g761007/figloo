import { z } from "zod";

export const PROTOCOL_VERSION = "0.2.0";

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
  "EXPORT_BLOCKED",
  "EXPORT_PENDING",
  "INSIDE_INSTANCE",
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

export const BridgeOpSchema = z.enum([
  "refresh_tabs",
  "get_anchor",
  "list_neighbors",
  "list_pages",
  "explore_page",
  "inspect_nodes",
  "capture",
  "export_asset",
  "visual_neighbors",
  "snapshot_layer",
]);
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
/** Most selected layers `get_anchor` returns. */
export const MAX_ANCHORS = 20;

export const AnchorResultSchema = z.object({
  identity: PageIdentitySchema,
  selectionCount: z.number().int().nonnegative(),
  /** The first selected layer in layers panel order. */
  anchor: LayerNodeSchema,
  /** Every selected layer found, in layers panel order, at most MAX_ANCHORS. */
  anchors: z.array(LayerNodeSchema).min(1).max(MAX_ANCHORS),
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
  anchors: z.array(LayerNodeSchema),
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
  /** The part of the canvas no panel covers, which a crop stays within. */
  canvas: RectSchema,
  viewport: z.object({ width: z.number().positive(), height: z.number().positive() }),
  zoom: z.string().nullable(),
});
export type CapturePlan = z.infer<typeof CapturePlanSchema>;

export const CaptureImageSchema = z.object({ data: z.string(), mimeType: z.literal("image/jpeg"), width: z.number().int(), height: z.number().int() });

export const CaptureResultSchema = z.object({
  identity: PageIdentitySchema,
  image: CaptureImageSchema,
  /** The part of the viewport the image shows, in CSS pixels; the image is this rectangle scaled to its width and height. */
  crop: RectSchema,
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

/** Formats and scale presets the export section of Figma's inspection panel offers. */
/** Most layers `get_visual_neighbors` returns. */
export const MAX_VISUAL_NEIGHBORS = 20;
export const DEFAULT_VISUAL_NEIGHBORS = 10;

export const VisualDirectionSchema = z.enum(["nearest", "right", "left", "below", "above"]);
export const VisualSideSchema = z.enum(["right", "left", "below", "above", "overlaps"]);

export const VisualNeighborsParamsSchema = z.object({
  expect: PageIdentitySchema,
  ref: z.string(),
  direction: VisualDirectionSchema,
  limit: z.number().int().positive().max(MAX_VISUAL_NEIGHBORS),
});
export type VisualNeighborsParams = z.infer<typeof VisualNeighborsParamsSchema>;

/** A sibling of the reference layer, placed by where both are on screen; lengths in design pixels. */
export const VisualNeighborSchema = LayerNodeSchema.extend({
  side: VisualSideSchema,
  /** Whether it shares a row (left or right) or a column (above or below) with the reference layer. */
  inLine: z.boolean(),
  /** Edge-to-edge distance, corner to corner for layers off to a diagonal; 0 when touching or overlapping. */
  gap: z.number().nonnegative(),
  /** Its top-left corner relative to the reference layer's. */
  offset: z.object({ x: z.number(), y: z.number() }),
  size: z.object({ width: z.number(), height: z.number() }),
});
export type VisualNeighbor = z.infer<typeof VisualNeighborSchema>;

export const VisualNeighborsResultSchema = z.object({
  identity: PageIdentitySchema,
  reference: z.object({ width: z.number(), height: z.number() }),
  /** Zoom used to turn screen pixels into design pixels, for example 0.61; null when every position came from the inspection panel. */
  zoom: z.number().positive().nullable(),
  neighbors: z.array(VisualNeighborSchema),
  /** Siblings that were measured, not counting the reference. */
  compared: z.number().int().nonnegative(),
  /** Siblings Figma gave no position on screen, such as hidden layers. */
  unplaced: z.array(z.string()),
  /** True when the parent has more children than one call compares. */
  siblingsHasMore: z.boolean(),
  userSelectionRestored: z.boolean(),
  uiOps: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
});
export type VisualNeighborsResult = z.infer<typeof VisualNeighborsResultSchema>;

export const VisualNeighborsOutputSchema = z.object({
  contextId: z.string(),
  ref: z.string(),
  direction: VisualDirectionSchema,
  reference: z.object({ width: z.number(), height: z.number() }),
  zoom: z.number().nullable(),
  neighbors: z.array(VisualNeighborSchema),
  compared: z.number().int().nonnegative(),
  unplaced: z.array(z.string()),
  siblingsHasMore: z.boolean(),
  userSelectionRestored: z.boolean(),
  uiOps: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
});
export type VisualNeighborsOutput = z.infer<typeof VisualNeighborsOutputSchema>;

export const ExportFormatSchema = z.enum(["svg", "png", "jpg", "pdf"]);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;
export const ExportScaleSchema = z.enum(["0.5x", "0.75x", "1x", "1.5x", "2x", "3x", "4x"]);
export type ExportScale = z.infer<typeof ExportScaleSchema>;

export const ExportParamsSchema = z.object({
  expect: PageIdentitySchema,
  ref: z.string(),
  /** When omitted, the layer's own export settings are used, or SVG when it has none. */
  format: ExportFormatSchema.optional(),
  /** PNG and JPG only; 1x when omitted. */
  scale: ExportScaleSchema.optional(),
  /** Identifies this export's captured files; set by the service worker. */
  token: z.string(),
});
export type ExportParams = z.infer<typeof ExportParamsSchema>;

/** What the MCP server asks for; the service worker adds the token. */
export const ExportRequestSchema = ExportParamsSchema.omit({ token: true });
export type ExportRequest = z.infer<typeof ExportRequestSchema>;

export const ExportSettingSchema = z.object({ format: z.string(), scale: z.string().nullable() });

/** What the tab did before Figma produced the files. */
export const ExportPlanSchema = z.object({
  identity: PageIdentitySchema,
  name: z.string(),
  settings: z.array(ExportSettingSchema),
  /** True when Figloo added a setting for this export; it is removed again afterwards. */
  temporary: z.boolean(),
  /** Only files in this format are returned when a temporary setting was added next to existing ones. */
  onlyFormat: ExportFormatSchema.nullable(),
});
export type ExportPlan = z.infer<typeof ExportPlanSchema>;

/** A file Figma exported, captured before it reached the download folder. */
export const CapturedFileSchema = z.object({ name: z.string(), mimeType: z.string(), data: z.string() });
export type CapturedFile = z.infer<typeof CapturedFileSchema>;

export const ExportFinishSchema = z.object({ files: z.array(CapturedFileSchema), userSelectionRestored: z.boolean() });

export const ExportResultSchema = z.object({
  identity: PageIdentitySchema,
  /** "direct": captured in the page and never saved by the browser; "download": read from the browser's download. */
  source: z.enum(["direct", "download"]),
  files: z.array(
    z.object({
      name: z.string(),
      mimeType: z.string(),
      /** Base64 contents when captured directly. */
      data: z.string().nullable(),
      /** Where the browser saved the file on the download path. */
      downloadPath: z.string().nullable(),
    }),
  ),
  /** Keep only files in this format, once any ZIP Figma packed them into is opened. */
  onlyFormat: ExportFormatSchema.nullable(),
  usedExistingSettings: z.boolean(),
  userSelectionRestored: z.boolean(),
  elapsedMs: z.number().nonnegative(),
});
export type ExportResult = z.infer<typeof ExportResultSchema>;

export const ExportOutputSchema = z.object({
  contextId: z.string(),
  ref: z.string(),
  source: z.enum(["direct", "download"]),
  files: z.array(
    z.object({
      name: z.string(),
      mimeType: z.string(),
      bytes: z.number().int().nonnegative(),
      /** Where Figloo wrote the file when saveTo was given. */
      savedTo: z.string().nullable(),
      /** Where the browser saved the file, or the ZIP it came in, on the download path. */
      downloadPath: z.string().nullable(),
      /** SVG markup, when the file is an SVG small enough to return inline. */
      svg: z.string().nullable(),
    }),
  ),
  usedExistingSettings: z.boolean(),
  userSelectionRestored: z.boolean(),
});
export type ExportOutput = z.infer<typeof ExportOutputSchema>;

/** Most layers a page snapshot reads, the root included: about two minutes of reading. */
export const MAX_SNAPSHOT_LAYERS = 400;
/** Time a page snapshot may take, screenshot included; below the five minutes Chrome allows one extension request. */
export const SNAPSHOT_TIME_BUDGET_MS = 180_000;

export const SnapshotParamsSchema = z.object({
  expect: PageIdentitySchema,
  /** The root layer; it must not be inside an instance. */
  ref: z.string(),
});
export type SnapshotParams = z.infer<typeof SnapshotParamsSchema>;

/** What the service worker asks the tab to read once it has captured the root. */
export const ReadSubtreeParamsSchema = SnapshotParamsSchema.extend({
  maxLayers: z.number().int().positive(),
  timeBudgetMs: z.number().int().positive(),
});
export type ReadSubtreeParams = z.infer<typeof ReadSubtreeParamsSchema>;

export const BoundsSourceSchema = z.enum(["mirror", "panel", "unknown"]);
export type BoundsSource = z.infer<typeof BoundsSourceSchema>;

/** A layer's place relative to the root's top-left corner, in design pixels. */
export const SnapshotBoundsSchema = z.object({
  /** null, together with y, when Figma shows no position, as for text placed by auto layout. */
  x: z.number().nullable(),
  y: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  /** "mirror": measured on screen; "panel": the inspection panel's Top and Left added to its frame's place; "unknown": the size at most. */
  source: BoundsSourceSchema,
});
export type SnapshotBounds = z.infer<typeof SnapshotBoundsSchema>;

/** One layer of a snapshot: where it sits in the tree, where it sits in the root, and its inspection panel. */
export const SnapshotLayerSchema = z.object({
  ref: z.string(),
  name: z.string(),
  type: z.string().nullable(),
  /** 0 for the root. */
  depth: z.number().int().nonnegative(),
  /** null for the root. */
  parentRef: z.string().nullable(),
  /** 1-based position among its siblings, in layers panel order. */
  position: z.number().int().positive(),
  siblingCount: z.number().int().positive(),
  /** For an instance, whether it has layers of its own; a snapshot does not read inside instances. */
  hasChildren: z.boolean(),
  /** Hidden in Figma, or inside a hidden layer; the layers panel greys both out. Its bounds are still measured. */
  hidden: z.boolean(),
  bounds: SnapshotBoundsSchema,
  sections: z.array(InspectedSectionSchema),
  /** What the designer set the layer up to export, such as "PNG 2x"; null when Figloo could not confirm the export section showed this layer. */
  exports: z.array(z.string()).nullable(),
});
export type SnapshotLayer = z.infer<typeof SnapshotLayerSchema>;

const SnapshotReadCompleteSchema = z.object({
  status: z.literal("complete"),
  identity: PageIdentitySchema,
  /** Every layer in layers panel order, the root first. */
  layers: z.array(SnapshotLayerSchema),
  /** The root on screen, in viewport CSS pixels; null without Figma's screen reader mirror. */
  rootOnScreen: RectSchema.nullable(),
  /** Screen pixels per design pixel. */
  zoom: z.number().positive().nullable(),
  /** Time spent walking the layers panel, before reading each layer. */
  walkMs: z.number().nonnegative(),
  userSelectionRestored: z.boolean(),
  uiOps: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
});

/** The subtree has more layers than a snapshot reads; nothing was read. */
const SnapshotTooLargeSchema = z.object({
  status: z.literal("too_large"),
  identity: PageIdentitySchema,
  maxLayers: z.number().int().positive(),
  /** The root's direct children, to pick a smaller root from. */
  children: z.array(LayerNodeSchema),
  childrenHasMore: z.boolean(),
  userSelectionRestored: z.boolean(),
  uiOps: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
});

/** How the root's place in a snapshot's screenshot was checked against the screenshot itself. */
export const ImageAlignmentSchema = z.enum(["confirmed", "corrected", "unconfirmed"]);
export type ImageAlignment = z.infer<typeof ImageAlignmentSchema>;

/** Result of the tab's `read_subtree` op. */
export const SnapshotReadResultSchema = z.discriminatedUnion("status", [SnapshotReadCompleteSchema, SnapshotTooLargeSchema]);
export type SnapshotReadResult = z.infer<typeof SnapshotReadResultSchema>;

/** Result of the `snapshot_layer` op: the root's screenshot and every layer below it. */
export const SnapshotResultSchema = z.discriminatedUnion("status", [
  SnapshotReadCompleteSchema.extend({
    image: CaptureImageSchema,
    /** The part of the viewport the image shows, in CSS pixels. */
    crop: RectSchema,
    /** The root in the image, in image pixels; null when its place on screen is unknown. */
    rootInImage: RectSchema.nullable(),
    /** Image pixels per design pixel, to place a layer's bounds in the image; null when the zoom is unknown. */
    imageScale: z.number().positive().nullable(),
    alignment: ImageAlignmentSchema,
  }),
  SnapshotTooLargeSchema,
]);
export type SnapshotResult = z.infer<typeof SnapshotResultSchema>;

/** Where the root sits in a snapshot's screenshot, to find a layer's bounds in the image. */
export const SnapshotImageInfoSchema = z.object({
  /** confirmed: the screenshot shows the root where Figma said; corrected: Figma's place was off and the root was found in the screenshot; unconfirmed: not checked, so rootInImage may be off. */
  alignment: ImageAlignmentSchema,
  width: z.number().int(),
  height: z.number().int(),
  /** The root in the image, in image pixels; null when Figma did not show where it is on screen. */
  rootInImage: RectSchema.nullable(),
  /** Image pixels per design pixel: a layer at (x, y) is at rootInImage + (x, y) × scale. */
  scale: z.number().positive().nullable(),
});

/** What `snapshot_layer` returns to the coding agent, next to the screenshot. */
export const SnapshotOutputSchema = z.object({
  contextId: z.string(),
  /** Pass it to query_snapshot, which reads the saved snapshot without the Figma tab. */
  snapshot: z.string(),
  fileKey: z.string(),
  page: z.string().nullable(),
  rootRef: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  /** True when an earlier snapshot was returned without reading Figma again. */
  fromCache: z.boolean(),
  layerCount: z.number().int().positive(),
  image: SnapshotImageInfoSchema,
  /** One line per layer in layers panel order, indented by depth. */
  outline: z.string(),
  /** Layers the outline lists; fewer than layerCount when it was cut to fit. */
  outlineLayers: z.number().int().nonnegative(),
  /** Continues the outline with query_snapshot when it was cut. */
  nextCursor: z.string().nullable(),
  elapsedMs: z.number().nonnegative(),
});
export type SnapshotOutput = z.infer<typeof SnapshotOutputSchema>;

/** Most layers `query_snapshot` returns in full per call. */
export const MAX_SNAPSHOT_DETAILS = 20;

export const QuerySnapshotOutputSchema = z.object({
  snapshot: z.string(),
  expiresAt: z.string(),
  /** Layers matching the query, over all pages. */
  matched: z.number().int().nonnegative(),
  /** 1-based number of the first returned match. */
  from: z.number().int().positive(),
  /** Outline lines of the matches; null when full layers are returned. */
  outline: z.string().nullable(),
  /** Full layers, for refs or details; null for an outline. */
  layers: z.array(SnapshotLayerSchema).nullable(),
  /** Requested refs the snapshot does not have. */
  missing: z.array(z.string()),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});
export type QuerySnapshotOutput = z.infer<typeof QuerySnapshotOutputSchema>;
