import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  MAX_SNAPSHOT_DETAILS,
  MAX_SNAPSHOT_LAYERS,
  QuerySnapshotOutputSchema,
  SNAPSHOT_TIME_BUDGET_MS,
  SnapshotOutputSchema,
  SnapshotResultSchema,
  SummarizeSnapshotOutputSchema,
  type QuerySnapshotOutput,
  type Rect,
  type SnapshotLayer,
  type SnapshotOutput,
  type SummarizeSnapshotOutput,
} from "@figloo/protocol";
import { BridgeError, type Bridge } from "./bridge.js";
import type { ContextStore } from "./contexts.js";
import type { ToolErrorResult } from "./export-asset.js";
import { summarizeLayers } from "./snapshot-summary.js";
import { isPlainRef, outlineLine, snapshotId, type SnapshotFile, type SnapshotStore } from "./snapshots.js";

/** The tab gets 180 s, the rest covers messaging; one long request, no polling. */
const SNAPSHOT_TIMEOUT_MS = SNAPSHOT_TIME_BUDGET_MS + 20_000;

export const SNAPSHOT_HINTS: Record<string, string> = {
  SUBTREE_TOO_LARGE: "Snapshot a smaller root: call snapshot_layer on one of the children listed in the message, or on a layer further down.",
  SNAPSHOT_NOT_FOUND: "Pass the snapshot id exactly as snapshot_layer returned it; without one, take a snapshot with snapshot_layer.",
  SNAPSHOT_EXPIRED: "Take a new snapshot with snapshot_layer, which needs a contextId from get_anchor or explore_page.",
};

/** Hints that differ for query_snapshot, which knows snapshots rather than contexts. */
const QUERY_HINTS: Record<string, string> = {
  ...SNAPSHOT_HINTS,
  UNKNOWN_REF: "Pass a ref from this snapshot's outline.",
  INVALID_CURSOR: "Pass nextCursor exactly as returned, with the same snapshot and filters.",
};

class SnapshotFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SnapshotDeps {
  bridge: Bridge;
  contexts: ContextStore;
  snapshots: SnapshotStore;
  log: (message: string) => void;
  /** Budget for one tool result. */
  maxOutputBytes: number;
}

const QueryCursorSchema = z.object({ s: z.string(), o: z.number().int().nonnegative(), q: z.string() });

function encodeQueryCursor(snapshot: string, offset: number, query: string): string {
  return Buffer.from(JSON.stringify({ s: snapshot, o: offset, q: query })).toString("base64url");
}

function decodeQueryCursor(cursor: string): z.infer<typeof QueryCursorSchema> | null {
  try {
    return QueryCursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

/** The most of `items` from `offset` on, at most `max` and at least one, whose result still fits the budget. */
function fitPage<T>(items: T[], offset: number, max: number, budget: number, build: (page: T[], next: number | null) => object): { count: number; output: object } {
  const make = (count: number) => {
    const end = offset + count;
    return build(items.slice(offset, end), end < items.length ? end : null);
  };
  const fits = (count: number) => Buffer.byteLength(JSON.stringify(make(count))) <= budget;
  let low = Math.min(1, items.length - offset);
  let high = Math.min(max, items.length - offset);
  if (fits(high)) low = high;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return { count: low, output: make(low) };
}

const textOf = (layer: SnapshotLayer) => layer.sections.find((section) => section.kind === "content")?.text ?? "";

/** The layers inside the layer at `at`: in panel order they follow it until the depth comes back up. */
function inside(layers: SnapshotLayer[], at: number): SnapshotLayer[] {
  const depth = layers[at]!.depth;
  const end = layers.findIndex((layer, index) => index > at && layer.depth <= depth);
  return layers.slice(at + 1, end < 0 ? undefined : end);
}
const round = (rect: Rect | null): Rect | null =>
  rect && { x: Math.round(rect.x * 10) / 10, y: Math.round(rect.y * 10) / 10, width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 };

export function registerSnapshotTools(server: McpServer, deps: SnapshotDeps, toolError: (error: unknown, hints?: Record<string, string>) => ToolErrorResult): void {
  const { bridge, contexts, snapshots, log, maxOutputBytes } = deps;
  const outlineQuery = JSON.stringify({ text: null, type: null, under: null, details: false });

  server.registerTool(
    "snapshot_layer",
    {
      description:
        "Read a layer and everything inside it in one go, for implementing a page: a screenshot, and for each layer its place, size, and all that inspect_nodes shows, saved as a snapshot that query_snapshot reads without Figma. " +
        "Use it on the page's root, such as the frame the user selected (get_anchor). Instances count as one layer; read inside them with get_neighbors. " +
        "Returns the screenshot, the snapshot id, and an outline with one line per layer: ref, type, name, x,y and width×height in design pixels from the root's top-left corner (? when Figma shows no place), the start of its text, and marks for hidden layers, instances with layers of their own, and export settings. " +
        "A layer at (x, y) shows at image.rootInImage + (x, y) × image.scale in the screenshot. image.alignment says whether rootInImage was checked against the screenshot: confirmed, corrected (Figma reported a stale place), or unconfirmed (it may be off by a few dozen pixels; the outline's places, relative to the root, are not affected). " +
        "A saved snapshot comes back without reading Figma until expiresAt; pass refresh: true when the user says the design changed. " +
        `Reading takes about 40 s for 300 layers, at most 3 minutes, for up to ${MAX_SNAPSHOT_LAYERS} layers; a larger subtree fails and lists the root's children. ` +
        "The Figma tab must be on screen to start. Meanwhile Figma shows an overlay with the progress and a Stop button, and the user can use other windows; " +
        "if the tab goes to the background, reading pauses and goes on when it is back, within the 3 minutes. " +
        "To cancel, the user should press Stop or Esc on the overlay, which puts the layers panel back; a click elsewhere in Figma also stops it but keeps the user's new selection. " +
        "The user's selection is put back; the view stays zoomed to the root.",
      inputSchema: {
        contextId: z.string(),
        ref: z.string().describe("A ref returned earlier in this context, outside instances"),
        refresh: z.boolean().optional().describe("Read Figma again even when a saved snapshot has not expired"),
      },
      outputSchema: SnapshotOutputSchema,
    },
    async ({ contextId, ref, refresh }) => {
      try {
        const started = Date.now();
        const context = contexts.get(contextId);
        if (!context) throw new SnapshotFailure("CONTEXT_NOT_FOUND", `no context ${contextId}`);
        if (!context.knownRefs.has(ref)) throw new SnapshotFailure("UNKNOWN_REF", `ref ${ref} was not returned in context ${contextId}`);
        if (!isPlainRef(ref)) throw new SnapshotFailure("INSIDE_INSTANCE", `layer ${ref} is inside an instance, whose layer IDs only hold until the page reloads`);
        const id = snapshotId(context.identity.fileKey, ref);
        const saved = refresh ? null : await snapshots.read(id);
        let file: SnapshotFile | null = saved?.status === "found" ? saved.file : null;
        let jpeg = file ? await snapshots.readImage(id) : null;
        const fromCache = file !== null && jpeg !== null;
        if (!file || !jpeg) {
          let result;
          try {
            result = SnapshotResultSchema.parse(await bridge.request("snapshot_layer", { expect: context.identity, ref }, SNAPSHOT_TIMEOUT_MS, context.tabId));
          } catch (error) {
            if (error instanceof BridgeError && error.code === "CONTEXT_EXPIRED") contexts.release(contextId);
            throw error;
          }
          if (result.status === "too_large") {
            for (const child of result.children) context.knownRefs.add(child.ref);
            const children = result.children.map((child) => `${child.ref} ${child.type ?? "?"} ${JSON.stringify(child.name)}`).join("; ");
            throw new SnapshotFailure(
              "SUBTREE_TOO_LARGE",
              `layer ${ref} holds more than ${result.maxLayers} layers; its direct children${result.childrenHasMore ? " (first 50)" : ""}: ${children}`,
            );
          }
          jpeg = Buffer.from(result.image.data, "base64");
          file = await snapshots.write(
            {
              fileKey: context.identity.fileKey,
              page: context.identity.page,
              rootRef: ref,
              elapsedMs: result.elapsedMs,
              image: {
                alignment: result.alignment,
                width: result.image.width,
                height: result.image.height,
                rootInImage: round(result.rootInImage),
                scale: result.imageScale && Math.round(result.imageScale * 10_000) / 10_000,
              },
              zoom: result.zoom,
              layers: result.layers,
            },
            jpeg,
          );
          log(`snapshot_layer layers=${result.layers.length} walkMs=${Math.round(result.walkMs)} uiOps=${result.uiOps} alignment=${result.alignment} ms=${Math.round(result.elapsedMs)}`);
        }
        // Refs outside instances hold across page loads, so this context may use them all.
        for (const layer of file.layers) context.knownRefs.add(layer.ref);
        const snapshotFile = file;
        const { count, output } = fitPage(snapshotFile.layers, 0, Number.POSITIVE_INFINITY, maxOutputBytes, (page, next): SnapshotOutput => ({
          contextId,
          snapshot: id,
          fileKey: snapshotFile.fileKey,
          page: snapshotFile.page,
          rootRef: ref,
          createdAt: snapshotFile.createdAt,
          expiresAt: snapshotFile.expiresAt,
          fromCache,
          layerCount: snapshotFile.layers.length,
          image: snapshotFile.image,
          outline: page.map(outlineLine).join("\n"),
          outlineLayers: page.length,
          nextCursor: next === null ? null : encodeQueryCursor(id, next, outlineQuery),
          elapsedMs: Date.now() - started,
        }));
        log(`snapshot_layer fromCache=${fromCache} outline=${count}/${snapshotFile.layers.length} bytes=${Buffer.byteLength(JSON.stringify(output))}`);
        return {
          content: [
            { type: "image" as const, data: jpeg.toString("base64"), mimeType: "image/jpeg" },
            { type: "text" as const, text: JSON.stringify(output) },
          ],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return toolError(error, SNAPSHOT_HINTS);
      }
    },
  );

  server.registerTool(
    "query_snapshot",
    {
      description:
        "Look layers up in a snapshot from snapshot_layer. Reads the saved file only, so it needs no Figma tab and works after the page reloads. " +
        `refs: those layers in full, up to ${MAX_SNAPSHOT_DETAILS}: bounds with where they came from, hidden, export settings, and every inspection panel section as inspect_nodes returns them. ` +
        "Otherwise filter by text (in names and text content, ignoring case), type (such as Text, Instance, or Auto layout), and under (only layers inside that ref); filters combine, and none lists every layer. " +
        "Matches come as outline lines, or in full with details: true, one page at a time; pass nextCursor for the next page. An expired snapshot fails; take a new one with snapshot_layer.",
      inputSchema: {
        snapshot: z.string().describe("The snapshot id from snapshot_layer"),
        refs: z.array(z.string()).min(1).max(MAX_SNAPSHOT_DETAILS).optional().describe("Layers to return in full; not combined with the filters"),
        text: z.string().min(1).optional(),
        type: z.string().min(1).optional(),
        under: z.string().optional().describe("A ref in the snapshot"),
        details: z.boolean().optional().describe("Return matches in full instead of as outline lines"),
        cursor: z.string().optional().describe("nextCursor from the previous page of the same query"),
      },
      outputSchema: QuerySnapshotOutputSchema,
    },
    async ({ snapshot, refs, text, type, under, details = false, cursor }) => {
      try {
        const found = await snapshots.read(snapshot);
        if (found.status === "missing") throw new SnapshotFailure("SNAPSHOT_NOT_FOUND", `there is no snapshot ${snapshot}`);
        if (found.status === "expired") throw new SnapshotFailure("SNAPSHOT_EXPIRED", `snapshot ${snapshot} expired at ${found.expiresAt}`);
        const { file } = found;
        const base = { snapshot, expiresAt: file.expiresAt };
        if (refs) {
          if (text !== undefined || type !== undefined || under !== undefined || cursor !== undefined) {
            throw new SnapshotFailure("INVALID_ARGUMENT", "refs cannot be combined with text, type, under, or cursor");
          }
          const byRef = new Map(file.layers.map((layer) => [layer.ref, layer]));
          const layers = refs.map((ref) => byRef.get(ref)).filter((layer): layer is SnapshotLayer => layer !== undefined);
          const output: QuerySnapshotOutput = { ...base, matched: layers.length, from: 1, outline: null, layers, missing: refs.filter((ref) => !byRef.has(ref)), hasMore: false, nextCursor: null };
          return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output as unknown as Record<string, unknown> };
        }
        let matches = file.layers;
        if (under !== undefined) {
          const at = matches.findIndex((layer) => layer.ref === under);
          if (at < 0) throw new SnapshotFailure("UNKNOWN_REF", `snapshot ${snapshot} has no layer ${under}`);
          matches = inside(matches, at);
        }
        if (type !== undefined) matches = matches.filter((layer) => layer.type?.toLowerCase() === type.toLowerCase());
        if (text !== undefined) {
          const needle = text.toLowerCase();
          matches = matches.filter((layer) => layer.name.toLowerCase().includes(needle) || textOf(layer).toLowerCase().includes(needle));
        }
        const query = JSON.stringify({ text: text ?? null, type: type ?? null, under: under ?? null, details });
        let offset = 0;
        if (cursor !== undefined) {
          const state = decodeQueryCursor(cursor);
          if (!state || state.s !== snapshot || state.q !== query || state.o > matches.length) {
            throw new SnapshotFailure("INVALID_CURSOR", "the cursor does not belong to this snapshot and query");
          }
          offset = state.o;
        }
        const { output } = fitPage(matches, offset, details ? MAX_SNAPSHOT_DETAILS : Number.POSITIVE_INFINITY, maxOutputBytes, (page, next): QuerySnapshotOutput => ({
          ...base,
          matched: matches.length,
          from: offset + 1,
          outline: details ? null : page.map(outlineLine).join("\n"),
          layers: details ? page : null,
          missing: [],
          hasMore: next !== null,
          nextCursor: next === null ? null : encodeQueryCursor(snapshot, next, query),
        }));
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output as unknown as Record<string, unknown> };
      } catch (error) {
        return toolError(error, QUERY_HINTS);
      }
    },
  );

  server.registerTool(
    "summarize_snapshot",
    {
      description:
        "Summarize the design values of a snapshot from snapshot_layer, to map them onto the project's tokens and components before writing code: " +
        "colors with what they color (fill, text, border, shadow), text styles, auto layout gaps, padding sides, corner radii, border widths, shadows, " +
        "and the instances it uses by name with each combination of their component properties. Figma names an instance after its component unless the designer renamed it. " +
        "Reads the saved file only, like query_snapshot. Values are exactly as Figma shows them; a color is a hex code, or the name of a color style where the panel shows one. " +
        "Each value says how many layers use it and gives a few of their refs to look up with query_snapshot. Hidden layers are left out. " +
        "Long lists are cut to fit, the values fewest layers use first, and truncated says so; pass under to summarize one section.",
      inputSchema: {
        snapshot: z.string().describe("The snapshot id from snapshot_layer"),
        under: z.string().optional().describe("A ref in the snapshot: only that layer and the layers inside it"),
      },
      outputSchema: SummarizeSnapshotOutputSchema,
    },
    async ({ snapshot, under }) => {
      try {
        const found = await snapshots.read(snapshot);
        if (found.status === "missing") throw new SnapshotFailure("SNAPSHOT_NOT_FOUND", `there is no snapshot ${snapshot}`);
        if (found.status === "expired") throw new SnapshotFailure("SNAPSHOT_EXPIRED", `snapshot ${snapshot} expired at ${found.expiresAt}`);
        const { file } = found;
        let layers = file.layers;
        if (under !== undefined) {
          const at = layers.findIndex((layer) => layer.ref === under);
          if (at < 0) throw new SnapshotFailure("UNKNOWN_REF", `snapshot ${snapshot} has no layer ${under}`);
          layers = [layers[at]!, ...inside(layers, at)];
        }
        const base = { snapshot, expiresAt: file.expiresAt };
        const summary = summarizeLayers(layers, (candidate) => Buffer.byteLength(JSON.stringify({ ...base, ...candidate })) <= maxOutputBytes);
        const output: SummarizeSnapshotOutput = { ...base, ...summary };
        log(`summarize_snapshot layers=${summary.layers} truncated=${summary.truncated} bytes=${Buffer.byteLength(JSON.stringify(output))}`);
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output as unknown as Record<string, unknown> };
      } catch (error) {
        return toolError(error, QUERY_HINTS);
      }
    },
  );
}
