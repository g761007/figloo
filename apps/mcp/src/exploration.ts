import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AnchorResultSchema,
  DEFAULT_NEIGHBOR_LIMIT,
  GetAnchorOutputSchema,
  GetNeighborsOutputSchema,
  MAX_NEIGHBOR_LIMIT,
  NeighborRelationSchema,
  NeighborsResultSchema,
  ReleaseContextOutputSchema,
  type GetAnchorOutput,
  type GetNeighborsOutput,
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
    "Ask the user to bring the Figma tab to the front (visible on screen, it may sit beside other windows), then retry. Layers that are already expanded can still be listed.",
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
        "Listing children may expand the layer in the Figma layers panel; it is collapsed again afterwards.",
      inputSchema: {
        contextId: z.string(),
        ref: z.string().describe("A ref returned earlier in this context"),
        relation: NeighborRelationSchema,
        cursor: z.string().optional().describe("nextCursor from the previous page of the same ref and relation"),
        limit: z.number().int().min(1).max(MAX_NEIGHBOR_LIMIT).optional(),
      },
      outputSchema: GetNeighborsOutputSchema,
    },
    async ({ contextId, ref, relation, cursor, limit }) => {
      try {
        const context = contexts.get(contextId);
        if (!context) throw new ToolFailure("CONTEXT_NOT_FOUND", `no context ${contextId}`);
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
              { expect: context.identity, ref, relation, from, limit: limit ?? DEFAULT_NEIGHBOR_LIMIT, ...(after ? { after } : {}) },
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
