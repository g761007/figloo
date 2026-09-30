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
  MAX_NEIGHBOR_DEPTH,
  MAX_NEIGHBOR_LIMIT,
  NeighborRelationSchema,
  NeighborsResultSchema,
  ReleaseContextOutputSchema,
  type CaptureOutput,
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

/** The tab gets 15 s for UI work; the rest covers messaging. */
const OP_TIMEOUT_MS = 20_000;
/** Plan budget for one tool result. */
export const MAX_OUTPUT_BYTES = 32 * 1024;

const HINTS: Record<string, string> = {
  NO_SELECTION: "Ask the user to select one layer in Figma, then call get_anchor again.",
  MULTIPLE_SELECTION: "Ask the user to select a single layer in Figma, then call get_anchor again.",
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
};

class ToolFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function toolError(error: unknown) {
  const code = error instanceof BridgeError || error instanceof ToolFailure ? error.code : "INTERNAL";
  const message = error instanceof Error ? error.message : String(error);
  const body = { error: { code, message, hint: HINTS[code] ?? null } };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}

function toolResult<T extends object>(output: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output as Record<string, unknown> };
}

export interface ExplorationDeps {
  bridge: Bridge;
  contexts: ContextStore;
  log: (message: string) => void;
}

export function registerExplorationTools(server: McpServer, deps: ExplorationDeps): void {
  const { bridge, contexts, log } = deps;

  server.registerTool(
    "get_anchor",
    {
      description:
        "Start exploring from the layer the user selected in a Figma tab. Returns that layer (the anchor) and a contextId for get_neighbors. " +
        "Exactly one layer must be selected. Use a tabId from get_status.",
      inputSchema: { tabId: z.number().int().describe("Figma tab from get_status") },
      outputSchema: GetAnchorOutputSchema,
    },
    async ({ tabId }) => {
      try {
        const result = AnchorResultSchema.parse(await bridge.request("get_anchor", {}, OP_TIMEOUT_MS, tabId));
        const context = contexts.create(tabId, result.identity, result.anchor.ref);
        if (result.anchor.parentRef) context.knownRefs.add(result.anchor.parentRef);
        const output: GetAnchorOutput = {
          contextId: context.id,
          tabId,
          fileKey: result.identity.fileKey,
          page: result.identity.page,
          selectionCount: result.selectionCount,
          anchor: result.anchor,
        };
        log(`get_anchor tab=${tabId} depth=${result.anchor.depth} uiOps=${result.uiOps} ms=${Math.round(result.elapsedMs)}`);
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
