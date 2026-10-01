import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AnchorResultSchema,
  CaptureOutputSchema,
  CaptureResultSchema,
  DEFAULT_NEIGHBOR_LIMIT,
  ExplorePageOutputSchema,
  ExplorePageResultSchema,
  GetAnchorOutputSchema,
  GetNeighborsOutputSchema,
  InspectGroupSchema,
  InspectNodesOutputSchema,
  InspectResultSchema,
  ListPagesResultSchema,
  MAX_INSPECT_REFS,
  MAX_ANCHORS,
  MAX_NEIGHBOR_DEPTH,
  MAX_NEIGHBOR_LIMIT,
  NeighborRelationSchema,
  NeighborsResultSchema,
  ReleaseContextOutputSchema,
  DEFAULT_VISUAL_NEIGHBORS,
  MAX_VISUAL_NEIGHBORS,
  VisualDirectionSchema,
  VisualNeighborsOutputSchema,
  VisualNeighborsResultSchema,
  type CaptureOutput,
  type VisualNeighborsOutput,
  type ExplorePageOutput,
  type GetAnchorOutput,
  type GetNeighborsOutput,
  type InspectNodesOutput,
  type LayerNode,
  type NeighborRelation,
} from "@figloo/protocol";
import { BridgeError, type Bridge } from "./bridge.js";
import type { ContextStore } from "./contexts.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { registerExportTool } from "./export-asset.js";
import { registerSnapshotTools } from "./snapshot-tools.js";
import type { SnapshotStore } from "./snapshots.js";

/** The tab gets 15 s for UI work; the rest covers messaging. */
const OP_TIMEOUT_MS = 20_000;
/** Plan budget for one tool result. */
export const MAX_OUTPUT_BYTES = 32 * 1024;

export const HINTS: Record<string, string> = {
  NO_SELECTION: "Ask the user to select the layers to work on in Figma, then call get_anchor again.",
  NOT_CONNECTED: "Call get_status for setup steps.",
  TAB_NOT_FOUND: "Call get_status to list the open Figma tabs and their tabId.",
  CONTEXT_NOT_FOUND: "The context was released or expired; call get_anchor again.",
  CONTEXT_EXPIRED: "The Figma tab reloaded or switched files; call get_anchor again.",
  PAGE_CHANGED: "The user switched to another Figma page; call get_anchor again.",
  UNKNOWN_REF: "Pass a ref returned earlier in this context.",
  INVALID_CURSOR: "Pass nextCursor exactly as returned, with the same contextId, ref, and relation.",
  NODE_NOT_FOUND: "The layer is no longer in the layers panel; call get_anchor again.",
  USER_INTERRUPTED: "The user interacted with Figma during the operation. Check with the user before retrying.",
  UI_NOT_READY: "Call get_status to see what the Figma tab can do right now.",
  BUSY: "Another operation is running in this tab; retry after it finishes.",
  BUDGET_EXCEEDED: "The operation ran out of its time or UI budget; narrow the request or retry.",
  TIMEOUT: "The Figma tab did not answer in time; call get_status.",
  TAB_IN_BACKGROUND:
    "Ask the user to bring the Figma tab to the front (visible on screen, it may sit beside other windows), then retry. Reading pages, the selection, and already expanded layers still works from the background.",
  INVALID_ARGUMENT: "Check the tool's parameters against its description.",
  INSIDE_INSTANCE: "Layers inside an instance get new IDs when the page reloads, so a snapshot needs a root outside instances: use the instance itself or a layer above it.",
};

class ToolFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function toolError(error: unknown, extraHints: Record<string, string> = {}) {
  const code = error instanceof BridgeError || error instanceof ToolFailure ? error.code : typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "INTERNAL";
  const message = error instanceof Error ? error.message : String(error);
  const body = { error: { code, message, hint: extraHints[code] ?? HINTS[code] ?? null } };
  return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}

function toolResult<T extends object>(output: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output as Record<string, unknown> };
}

export interface ExplorationDeps {
  bridge: Bridge;
  contexts: ContextStore;
  log: (message: string) => void;
  /** Directory export_asset may write into; defaults to the working directory. */
  root?: string;
  snapshots: SnapshotStore;
}

export function registerExplorationTools(server: McpServer, deps: ExplorationDeps): void {
  const { bridge, contexts, log } = deps;

  server.registerTool(
    "get_anchor",
    {
      description:
        "Start exploring from the layers the user selected in a Figma tab. Returns the selected layers (the anchors) and a contextId for get_neighbors. " +
        `anchor is the first selected layer; anchors lists every selected layer found, in layers panel order, at most ${MAX_ANCHORS}. ` +
        "Fewer anchors than selectionCount means the rest are hidden in collapsed groups; ask the user to reveal them if they matter. Use a tabId from get_status.",
      inputSchema: { tabId: z.number().int().describe("Figma tab from get_status") },
      outputSchema: GetAnchorOutputSchema,
    },
    async ({ tabId }) => {
      try {
        const result = AnchorResultSchema.parse(await bridge.request("get_anchor", {}, OP_TIMEOUT_MS, tabId));
        const context = contexts.create(tabId, result.identity, result.anchor.ref);
        for (const anchor of result.anchors) {
          context.knownRefs.add(anchor.ref);
          if (anchor.parentRef) context.knownRefs.add(anchor.parentRef);
        }
        const output: GetAnchorOutput = {
          contextId: context.id,
          tabId,
          fileKey: result.identity.fileKey,
          page: result.identity.page,
          selectionCount: result.selectionCount,
          anchor: result.anchor,
          anchors: result.anchors,
        };
        log(`get_anchor tab=${tabId} anchors=${result.anchors.length}/${result.selectionCount} depth=${result.anchor.depth} uiOps=${result.uiOps} ms=${Math.round(result.elapsedMs)}`);
        return toolResult(output);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_neighbors",
    {
      description:
        "List layers related to a ref within a context. relation is one of: parent; ancestors (nearest first, up to the layer on the page); " +
        "siblings (all children of the ref's parent in layer order, including the ref); children (direct children only). " +
        `Returns at most limit summaries (default ${DEFAULT_NEIGHBOR_LIMIT}, max ${MAX_NEIGHBOR_LIMIT}); pass nextCursor to continue. ` +
        "Only refs returned in this context are accepted, and nothing beyond the requested relation is read. " +
        `For children, depth (max ${MAX_NEIGHBOR_DEPTH}) also lists deeper levels breadth first within the same limit; such a tree has no cursor, so query deeper layers directly when hasMore is true. ` +
        "Listing children may expand layers in the Figma layers panel; they are collapsed again afterwards, and collapsed layers can only be expanded while the Figma tab is visible.",
      inputSchema: {
        contextId: z.string(),
        ref: z.string().describe("A ref returned earlier in this context"),
        relation: NeighborRelationSchema,
        cursor: z.string().optional().describe("nextCursor from the previous page of the same ref and relation"),
        limit: z.number().int().min(1).max(MAX_NEIGHBOR_LIMIT).optional(),
        depth: z.number().int().min(1).max(MAX_NEIGHBOR_DEPTH).optional().describe("children only: levels to include, default 1"),
      },
      outputSchema: GetNeighborsOutputSchema,
    },
    async ({ contextId, ref, relation, cursor, limit, depth }) => {
      try {
        const context = contexts.get(contextId);
        if (!context) throw new ToolFailure("CONTEXT_NOT_FOUND", `no context ${contextId}`);
        if (depth !== undefined && depth > 1 && relation !== "children") throw new ToolFailure("INVALID_ARGUMENT", "depth only applies to relation children");
        if (depth !== undefined && depth > 1 && cursor !== undefined) throw new ToolFailure("INVALID_ARGUMENT", "a tree listed with depth cannot be continued with a cursor");
        let from = 1;
        let after: string | null = null;
        if (cursor !== undefined) {
          const state = decodeCursor(cursor);
          if (!state || state.contextId !== contextId || state.ref !== ref || state.relation !== relation) {
            throw new ToolFailure("INVALID_CURSOR", "the cursor does not belong to this context, ref, and relation");
          }
          ({ from, after } = state);
        }
        if (!context.knownRefs.has(ref)) throw new ToolFailure("UNKNOWN_REF", `ref ${ref} was not returned in context ${contextId}`);

        let result;
        try {
          result = NeighborsResultSchema.parse(
            await bridge.request(
              "list_neighbors",
              { expect: context.identity, ref, relation, from, limit: limit ?? DEFAULT_NEIGHBOR_LIMIT, ...(after ? { after } : {}), ...(depth !== undefined && depth > 1 ? { depth } : {}) },
              OP_TIMEOUT_MS,
              context.tabId,
            ),
          );
        } catch (error) {
          if (error instanceof BridgeError && error.code === "CONTEXT_EXPIRED") contexts.release(contextId);
          throw error;
        }
        for (const node of result.nodes) context.knownRefs.add(node.ref);

        const output = fitToBudget(
          {
            contextId,
            ref,
            relation,
            nodes: result.nodes,
            coverage: { fromPosition: result.from, toPosition: lastPosition(relation, result.from, result.nodes), total: result.total },
            hasMore: result.hasMore,
            nextCursor: result.hasMore && result.nextFrom !== null ? encodeCursor({ contextId, ref, relation, from: result.nextFrom, after: afterRef(relation, result.nodes) }) : null,
            stopReason: result.stopReason,
            uiOps: result.uiOps,
            elapsedMs: result.elapsedMs,
          },
          (nodes) => encodeCursor({ contextId, ref, relation, from: (lastPosition(relation, result.from, nodes) ?? result.from - 1) + 1, after: afterRef(relation, nodes) }),
        );
        log(
          `get_neighbors relation=${relation} returned=${output.nodes.length} total=${output.coverage.total ?? "?"} stop=${output.stopReason} ` +
            `uiOps=${output.uiOps} ms=${Math.round(output.elapsedMs)} bytes=${Buffer.byteLength(JSON.stringify(output))}`,
        );
        return toolResult(output);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list_pages",
    {
      description: "List the pages of the Figma file open in a tab and which one is shown. Works while the tab is in the background.",
      inputSchema: { tabId: z.number().int().describe("Figma tab from get_status") },
      outputSchema: z.object({ tabId: z.number().int(), fileKey: z.string(), pages: ListPagesResultSchema.shape.pages }),
    },
    async ({ tabId }) => {
      try {
        const result = ListPagesResultSchema.parse(await bridge.request("list_pages", {}, OP_TIMEOUT_MS, tabId));
        return toolResult({ tabId, ...result });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "explore_page",
    {
      description:
        "Open a page of the Figma file (the shown page when page is omitted) and list the layers directly on it, usually frames and sections. " +
        "Returns a contextId for get_neighbors, inspect_nodes, and capture, so exploring does not depend on what the user selected. " +
        "Switching pages needs the Figma tab visible on screen and changes the page the user sees. " +
        "When hasMore is true, continue with get_neighbors(ref = nodes[0].ref, relation = siblings, cursor = nextCursor).",
      inputSchema: {
        tabId: z.number().int().describe("Figma tab from get_status"),
        page: z.string().optional().describe("Page name from list_pages"),
        limit: z.number().int().min(1).max(MAX_NEIGHBOR_LIMIT).optional(),
      },
      outputSchema: ExplorePageOutputSchema,
    },
    async ({ tabId, page, limit }) => {
      try {
        const result = ExplorePageResultSchema.parse(
          await bridge.request("explore_page", { ...(page !== undefined ? { page } : {}), limit: limit ?? MAX_NEIGHBOR_LIMIT }, OP_TIMEOUT_MS, tabId),
        );
        const context = contexts.create(tabId, result.identity, null);
        for (const node of result.nodes) context.knownRefs.add(node.ref);
        const first = result.nodes[0];
        const output: ExplorePageOutput = {
          contextId: context.id,
          tabId,
          fileKey: result.identity.fileKey,
          page: result.identity.page,
          nodes: result.nodes,
          total: result.total,
          hasMore: result.hasMore,
          nextCursor:
            result.hasMore && first && result.nextFrom !== null
              ? encodeCursor({ contextId: context.id, ref: first.ref, relation: "siblings", from: result.nextFrom, after: result.nodes.at(-1)!.ref })
              : null,
        };
        log(`explore_page tab=${tabId} returned=${result.nodes.length} total=${result.total ?? "?"} uiOps=${result.uiOps} ms=${Math.round(result.elapsedMs)}`);
        return toolResult(output);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_visual_neighbors",
    {
      description:
        "List the siblings of a layer by where they are on screen: direction right, left, below, or above, or nearest (default) for all of them by distance. " +
        "Each one has its side, whether it shares a row or column with the layer (inLine), the edge-to-edge gap, and its offset and size. " +
        "Lengths are design pixels, measured on screen and divided by the zoom; text layers, which Figma does not place on screen, are placed from the inspection panel instead. Use inspect_nodes for exact values. " +
        "Only layers in the same parent are compared; call it again on an ancestor to look further out. " +
        "Needs Figma's Adapt content for screen readers setting and the Figma tab on screen. Siblings are selected in turn, and the user's selection is put back afterwards.",
      inputSchema: {
        contextId: z.string(),
        ref: z.string().describe("A ref returned earlier in this context"),
        direction: VisualDirectionSchema.optional().describe("Default nearest"),
        limit: z.number().int().min(1).max(MAX_VISUAL_NEIGHBORS).optional().describe(`Default ${DEFAULT_VISUAL_NEIGHBORS}`),
      },
      outputSchema: VisualNeighborsOutputSchema,
    },
    async ({ contextId, ref, direction = "nearest", limit = DEFAULT_VISUAL_NEIGHBORS }) => {
      try {
        const context = contexts.get(contextId);
        if (!context) throw new ToolFailure("CONTEXT_NOT_FOUND", `no context ${contextId}`);
        if (!context.knownRefs.has(ref)) throw new ToolFailure("UNKNOWN_REF", `ref ${ref} was not returned in context ${contextId}`);
        let result;
        try {
          result = VisualNeighborsResultSchema.parse(
            await bridge.request("visual_neighbors", { expect: context.identity, ref, direction, limit }, OP_TIMEOUT_MS, context.tabId),
          );
        } catch (error) {
          if (error instanceof BridgeError && error.code === "CONTEXT_EXPIRED") contexts.release(contextId);
          throw error;
        }
        for (const neighbor of result.neighbors) context.knownRefs.add(neighbor.ref);
        const output: VisualNeighborsOutput = {
          contextId,
          ref,
          direction,
          reference: result.reference,
          zoom: result.zoom,
          neighbors: result.neighbors,
          compared: result.compared,
          unplaced: result.unplaced,
          siblingsHasMore: result.siblingsHasMore,
          userSelectionRestored: result.userSelectionRestored,
          uiOps: result.uiOps,
          elapsedMs: result.elapsedMs,
        };
        log(`get_visual_neighbors direction=${direction} returned=${result.neighbors.length} compared=${result.compared} uiOps=${result.uiOps} ms=${Math.round(result.elapsedMs)}`);
        return toolResult(output);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "inspect_nodes",
    {
      description:
        `Read what Figma's inspection panel shows for up to ${MAX_INSPECT_REFS} layers of a context. ` +
        "layout: size and sizing mode, position in the parent, auto layout flow, padding, gap, corner radius. " +
        "appearance: fills, borders, shadows, image file names. typography: text content and, per style run, font, weight, style, size, line height, letter spacing. " +
        "component: component properties and the parent component. Values are exactly as Figma displays them; groups a layer does not have are listed in notShown. " +
        "Each layer is selected in turn, so the Figma tab must be visible; the user's selection is put back afterwards.",
      inputSchema: {
        contextId: z.string(),
        refs: z.array(z.string()).min(1).max(MAX_INSPECT_REFS).describe("Refs returned earlier in this context"),
        groups: z.array(InspectGroupSchema).min(1).optional().describe("Default: all groups"),
      },
      outputSchema: InspectNodesOutputSchema,
    },
    async ({ contextId, refs, groups }) => {
      try {
        const context = contexts.get(contextId);
        if (!context) throw new ToolFailure("CONTEXT_NOT_FOUND", `no context ${contextId}`);
        const unknown = refs.filter((ref) => !context.knownRefs.has(ref));
        if (unknown.length > 0) throw new ToolFailure("UNKNOWN_REF", `refs ${unknown.join(", ")} were not returned in context ${contextId}`);
        let result;
        try {
          result = InspectResultSchema.parse(
            await bridge.request("inspect_nodes", { expect: context.identity, refs, ...(groups ? { groups } : {}) }, OP_TIMEOUT_MS, context.tabId),
          );
        } catch (error) {
          if (error instanceof BridgeError && error.code === "CONTEXT_EXPIRED") contexts.release(contextId);
          throw error;
        }
        const output: InspectNodesOutput = { contextId, nodes: result.nodes, userSelectionRestored: result.userSelectionRestored, uiOps: result.uiOps, elapsedMs: result.elapsedMs };
        log(`inspect_nodes refs=${refs.length} uiOps=${result.uiOps} ms=${Math.round(result.elapsedMs)} bytes=${Buffer.byteLength(JSON.stringify(output))}`);
        return toolResult(output);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "capture",
    {
      description:
        "Screenshot a layer of a context, zoomed to fit the screen, or the whole page when ref is omitted. " +
        "Returns a JPEG at most 1568 px on its long edge as visual reference; read exact values with inspect_nodes. " +
        "The Figma tab must be visible. The view zooms to the target and stays there; the user's selection is put back.",
      inputSchema: {
        contextId: z.string(),
        ref: z.string().optional().describe("A ref returned earlier in this context; omit for the whole page"),
      },
      outputSchema: CaptureOutputSchema,
    },
    async ({ contextId, ref }) => {
      try {
        const context = contexts.get(contextId);
        if (!context) throw new ToolFailure("CONTEXT_NOT_FOUND", `no context ${contextId}`);
        if (ref !== undefined && !context.knownRefs.has(ref)) throw new ToolFailure("UNKNOWN_REF", `ref ${ref} was not returned in context ${contextId}`);
        let result;
        try {
          result = CaptureResultSchema.parse(await bridge.request("capture", { expect: context.identity, ref: ref ?? null }, OP_TIMEOUT_MS, context.tabId));
        } catch (error) {
          if (error instanceof BridgeError && error.code === "CONTEXT_EXPIRED") contexts.release(contextId);
          throw error;
        }
        const output: CaptureOutput = {
          contextId,
          ref: ref ?? null,
          width: result.image.width,
          height: result.image.height,
          cropSource: result.cropSource,
          zoom: result.zoom,
          userSelectionRestored: result.userSelectionRestored,
        };
        log(`capture ref=${ref ? "layer" : "page"} ${output.width}x${output.height} crop=${output.cropSource} bytes=${Math.round((result.image.data.length * 3) / 4)} ms=${Math.round(result.elapsedMs)}`);
        return {
          content: [
            { type: "image" as const, data: result.image.data, mimeType: result.image.mimeType },
            { type: "text" as const, text: JSON.stringify(output) },
          ],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerExportTool(server, deps, toolError);
  registerSnapshotTools(server, { bridge, contexts, snapshots: deps.snapshots, log, maxOutputBytes: MAX_OUTPUT_BYTES }, toolError);

  server.registerTool(
    "release_context",
    {
      description: "Forget an exploration context and the refs it returned.",
      inputSchema: { contextId: z.string() },
      outputSchema: ReleaseContextOutputSchema,
    },
    async ({ contextId }) => toolResult({ released: contexts.release(contextId) }),
  );
}

/** Ancestors are paged by distance from the ref; the other relations by sibling position. */
function lastPosition(relation: NeighborRelation, from: number, nodes: LayerNode[]): number | null {
  if (nodes.length === 0) return null;
  return relation === "ancestors" || relation === "parent" ? from + nodes.length - 1 : nodes.at(-1)!.position;
}

function afterRef(relation: NeighborRelation, nodes: LayerNode[]): string | null {
  return relation === "siblings" || relation === "children" ? (nodes.at(-1)?.ref ?? null) : null;
}

/** Drops trailing layers until the result fits the output budget; the cursor resumes at the first dropped one. */
export function fitToBudget(output: GetNeighborsOutput, cursorFor: (kept: LayerNode[]) => string): GetNeighborsOutput {
  const size = (candidate: GetNeighborsOutput) => Buffer.byteLength(JSON.stringify(candidate));
  if (size(output) <= MAX_OUTPUT_BYTES) return output;
  const nodes = [...output.nodes];
  let candidate = output;
  while (nodes.length > 0) {
    nodes.pop();
    candidate = {
      ...output,
      nodes: [...nodes],
      coverage: { ...output.coverage, toPosition: lastPosition(output.relation, output.coverage.fromPosition, nodes) },
      hasMore: true,
      nextCursor: cursorFor(nodes),
      stopReason: "output_budget",
    };
    if (size(candidate) <= MAX_OUTPUT_BYTES) return candidate;
  }
  return candidate;
}
