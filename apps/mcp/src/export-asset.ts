import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ExportAssetsOutputSchema,
  ExportFormatSchema,
  ExportOutputSchema,
  ExportResultSchema,
  ExportScaleSchema,
  MAX_EXPORT_BATCH,
  type ExportAssetsOutput,
  type ExportFormat,
  type ExportOutput,
  type ExportResult,
  type ExportScale,
} from "@figloo/protocol";
import { BridgeError, type Bridge } from "./bridge.js";
import { knownParents, type ContextStore, type ExplorationContext } from "./contexts.js";
import { SNAPSHOT_HINTS, adoptSnapshot, finishedSnapshot, inside } from "./snapshot-tools.js";
import type { SnapshotStore } from "./snapshots.js";

const EXPORT_TIMEOUT_MS = 70_000;
/** Inline SVG stays within the plan's output budget; larger files should go through saveTo. */
const MAX_INLINE_SVG_BYTES = 24 * 1024;
const MAX_INLINE_IMAGE_BYTES = 1_500_000;
/** Longest side of a PNG or JPG shown inline, the same limit as capture. */
const MAX_INLINE_IMAGE_SIDE = 1568;

const MIME_BY_EXTENSION: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".pdf": "application/pdf" };
const FORMAT_MIME: Record<ExportFormat, string> = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", pdf: "application/pdf" };
const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END = 0x06054b50;

export const EXPORT_HINTS: Record<string, string> = {
  EXPORT_BLOCKED:
    "Figma handed over no file and the browser started no download. If the browser blocked repeated downloads from figma.com, ask the user to allow them in the site settings, then retry.",
  EXPORT_PENDING: "The browser is waiting to save the export, probably behind a Save dialog. Ask the user to confirm it, or to turn off asking where to save each file.",
  SAVE_REFUSED: "saveTo must be a path inside the project directory, and existing files are only replaced with overwrite: true.",
  LAYER_HIDDEN: "Figma exports nothing for a hidden layer or one inside a hidden layer. Leave it out, or ask the user whether it should be shown in Figma.",
};

class SaveRefused extends Error {
  readonly code = "SAVE_REFUSED";
}

/** Resolves saveTo inside `root`; a directory (trailing slash, or several files) keeps the exported names. */
export function resolveSaveTarget(root: string, saveTo: string, fileName: string, asDirectory: boolean): string {
  const base = resolve(root, saveTo);
  const target = asDirectory || saveTo.endsWith("/") ? join(base, basename(fileName)) : base;
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new SaveRefused(`${saveTo} is outside the project directory ${root}`);
  return target;
}

/** Files inside a ZIP. In the browser Figma packs several files, or a layer whose name has a slash, into one. */
export function unzip(zip: Buffer): { name: string; data: Buffer }[] {
  // The end record is the last 22 bytes, followed by a comment of at most 64 KiB.
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff) && end < 0; at -= 1) {
    if (zip.readUInt32LE(at) === ZIP_END) end = at;
  }
  if (end < 0) throw new Error("the export is not a readable ZIP archive");
  const entries: { name: string; data: Buffer }[] = [];
  let at = zip.readUInt32LE(end + 16);
  for (let n = zip.readUInt16LE(end + 10); n > 0; n -= 1) {
    if (zip.readUInt32LE(at) !== ZIP_CENTRAL_HEADER) throw new Error("the export ZIP archive is damaged");
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (name.endsWith("/")) continue;
    if (zip.readUInt32LE(local) !== ZIP_LOCAL_HEADER) throw new Error("the export ZIP archive is damaged");
    // Sizes come from the central directory: local headers may leave them to a trailing descriptor.
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    if (method !== 0 && method !== 8) throw new Error(`the export ZIP archive uses unsupported compression ${method}`);
    entries.push({ name, data: method === 8 ? inflateRawSync(raw) : raw });
  }
  return entries;
}

/** Width and height of a PNG or JPEG, or null when they cannot be read. */
function imageSize(bytes: Buffer, mimeType: string): { width: number; height: number } | null {
  if (mimeType === "image/png") {
    return bytes.length >= 24 && bytes.toString("latin1", 12, 16) === "IHDR" ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
  }
  if (mimeType !== "image/jpeg" || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  // Walk the segments to the start of frame, which holds the size.
  for (let at = 2; at + 9 < bytes.length && bytes[at] === 0xff; at += 2 + bytes.readUInt16BE(at + 2)) {
    const marker = bytes[at + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    }
  }
  return null;
}

export interface ExportDeps {
  bridge: Bridge;
  contexts: ContextStore;
  log: (message: string) => void;
  /** Directory saveTo is confined to; defaults to Claude Code's CLAUDE_PROJECT_DIR, then the working directory. */
  root?: string;
  snapshots: SnapshotStore;
  /** Clock for the time budget of export_assets. */
  now?: () => number;
}

export type ToolErrorResult = { isError: true; content: { type: "text"; text: string }[] };

/** Errors the export tools raise themselves, beside the bridge's. */
class ExportFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface ExportedFile {
  name: string;
  mimeType: string;
  bytes: Buffer;
  downloadPath: string | null;
}

/** Exports one layer through the tab and returns the files asked for, with any ZIP Figma packed them into opened. */
async function exportLayer(deps: ExportDeps, context: ExplorationContext, ref: string, format?: ExportFormat, scale?: ExportScale): Promise<{ result: ExportResult; files: ExportedFile[] }> {
  let result: ExportResult;
  try {
    result = ExportResultSchema.parse(
      await deps.bridge.request(
        "export_asset",
        { expect: context.identity, ref, ...(format ? { format } : {}), ...(scale ? { scale } : {}), ...knownParents(context, [ref]) },
        EXPORT_TIMEOUT_MS,
        context.tabId,
      ),
    );
  } catch (error) {
    if (error instanceof BridgeError && error.code === "CONTEXT_EXPIRED") deps.contexts.release(context.id);
    throw error;
  }
  const exported: ExportedFile[] = [];
  for (const file of result.files) {
    const bytes = file.data !== null ? Buffer.from(file.data, "base64") : await readFile(file.downloadPath!);
    const zipped = bytes.length >= 4 && bytes.readUInt32LE(0) === ZIP_LOCAL_HEADER;
    for (const { name, data } of zipped ? unzip(bytes) : [{ name: file.name, data: bytes }]) {
      const mimeType = MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? (zipped ? "application/octet-stream" : file.mimeType);
      exported.push({ name: basename(name), mimeType, bytes: data, downloadPath: file.downloadPath });
    }
  }
  // A temporary setting next to the designer's ones exports theirs too; keep only what was asked for.
  const kept = result.onlyFormat ? exported.filter((file) => file.mimeType === FORMAT_MIME[result.onlyFormat!]) : exported;
  if (kept.length === 0) {
    const names = exported.map((f) => f.name).join(", ");
    throw new BridgeError("INTERNAL", names ? `Figma exported ${names}, but no ${result.onlyFormat} file` : "Figma's export was an empty ZIP archive");
  }
  return { result, files: kept };
}

/** Writes a file, replacing one only with overwrite. */
async function save(path: string, bytes: Buffer, overwrite: boolean | undefined): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: overwrite ? "w" : "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new SaveRefused(`${path} already exists; pass overwrite: true to replace it`);
    throw error;
  });
}

/** Claude Code sets CLAUDE_PROJECT_DIR for the servers it starts; their working directory may differ. */
const projectRoot = (deps: ExportDeps) => deps.root ?? (process.env.CLAUDE_PROJECT_DIR || process.cwd());

export function registerExportTool(server: McpServer, deps: ExportDeps, toolError: (error: unknown, hints?: Record<string, string>) => ToolErrorResult): void {
  const { contexts, log } = deps;
  server.registerTool(
    "export_asset",
    {
      description:
        "Export a layer of a context with Figma's Export button and hand the files over: SVG markup inline, and PNG or JPG up to 1568 px as an image. " +
        "Choose format and scale for the project, for example by checking how it already stores icons: SVG for web or Android vector drawables, PDF or PNG at 1x, 2x, and 3x for iOS, PNG at 1x to 4x for Android densities. One call exports one scale. " +
        "With format, a temporary setting in that format and scale is added and removed again, unless the layer already has that exact setting, and only files in that format are returned. " +
        "Without format, the designer's own export settings decide, and a layer without settings exports as SVG. " +
        "With saveTo, the files are also written inside the project directory. Figma names files after the layer without a scale suffix, so give a full file name such as icons/close@2x.png for each scale, or end saveTo with a slash to keep Figma's name. " +
        "Figloo normally receives the file inside the page, so the browser saves nothing; if that fails it falls back to the browser's download and reports its path. The Figma tab must be visible. " +
        "For many layers, such as every icon of a page, use export_assets.",
      inputSchema: {
        contextId: z.string(),
        ref: z.string().describe("A ref returned earlier in this context"),
        format: ExportFormatSchema.optional().describe("Pick it for the project; without it the designer's export settings decide"),
        scale: ExportScaleSchema.optional().describe("Default 1x"),
        saveTo: z.string().optional().describe("Path inside the project, for example src/assets/icons/close.svg or src/assets/icons/"),
        overwrite: z.boolean().optional(),
      },
      outputSchema: ExportOutputSchema,
    },
    async ({ contextId, ref, format, scale, saveTo, overwrite }) => {
      try {
        const context = contexts.get(contextId);
        if (!context) throw new BridgeError("CONTEXT_NOT_FOUND", `no context ${contextId}`);
        if (!context.knownRefs.has(ref)) throw new BridgeError("UNKNOWN_REF", `ref ${ref} was not returned in context ${contextId}`);
        const { result, files: kept } = await exportLayer(deps, context, ref, format, scale);
        const root = projectRoot(deps);
        const images: { type: "image"; data: string; mimeType: string }[] = [];
        const files: ExportOutput["files"] = [];
        for (const file of kept) {
          const { bytes } = file;
          let savedTo: string | null = null;
          if (saveTo !== undefined) {
            savedTo = resolveSaveTarget(root, saveTo, file.name, kept.length > 1);
            await save(savedTo, bytes, overwrite);
          }
          const size = imageSize(bytes, file.mimeType);
          if (size && Math.max(size.width, size.height) <= MAX_INLINE_IMAGE_SIDE && bytes.length <= MAX_INLINE_IMAGE_BYTES) {
            images.push({ type: "image", data: bytes.toString("base64"), mimeType: file.mimeType });
          }
          files.push({
            name: file.name,
            mimeType: file.mimeType,
            bytes: bytes.length,
            savedTo,
            downloadPath: file.downloadPath,
            svg: file.mimeType === "image/svg+xml" && bytes.length <= MAX_INLINE_SVG_BYTES ? bytes.toString("utf8") : null,
          });
        }
        const output: ExportOutput = { contextId, ref, source: result.source, files, usedExistingSettings: result.usedExistingSettings, userSelectionRestored: result.userSelectionRestored };
        log(`export_asset source=${result.source} files=${files.length} bytes=${files.reduce((sum, f) => sum + f.bytes, 0)} saved=${saveTo !== undefined} ms=${Math.round(result.elapsedMs)}`);
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }, ...images], structuredContent: output as unknown as Record<string, unknown> };
      } catch (error) {
        return toolError(error, EXPORT_HINTS);
      }
    },
  );
}

/** export_assets starts no new export after this long, so a call stays within the time agents give it. */
export const BATCH_BUDGET_MS = 150_000;
/** Errors after which the next exports would fail the same way, so the batch stops. */
const STOPS_BATCH = new Set(["TAB_IN_BACKGROUND", "USER_INTERRUPTED", "NOT_CONNECTED", "TIMEOUT", "TAB_NOT_FOUND", "CONTEXT_EXPIRED", "PAGE_CHANGED", "BUSY", "EXPORT_PENDING"]);

const codeOf = (error: unknown) => (typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "INTERNAL");

/** `target`, or when this call already wrote that path, the same name with the ref and then a count before the extension. */
function unusedPath(target: string, ref: string, used: Set<string>): string {
  if (!used.has(target)) return target;
  const extension = extname(target);
  const stem = `${target.slice(0, target.length - extension.length)}-${ref.replace(/[^A-Za-z0-9]+/g, "-")}`;
  for (let n = 1; ; n += 1) {
    const candidate = `${stem}${n > 1 ? `-${n}` : ""}${extension}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function registerExportAssetsTool(server: McpServer, deps: ExportDeps, toolError: (error: unknown, hints?: Record<string, string>) => ToolErrorResult): void {
  const { contexts, snapshots, log } = deps;
  const now = deps.now ?? Date.now;
  server.registerTool(
    "export_assets",
    {
      description:
        "Export several layers of a context with Figma's Export button, one after another, and save their files into one folder of the project, such as every icon and image of a page. " +
        "Pass refs, or a snapshot from snapshot_layer to export each of its layers with export settings (the outline's [export …] marks), optionally only those inside one layer with under; hidden layers are skipped. " +
        "format and scale work as in export_asset, for every layer; without format each layer exports as the designer set it up. " +
        "Files keep Figma's names; when this call would write one path twice, the later file gets its layer's ref added, such as Vector-570-14192.svg. Existing files are only replaced with overwrite: true. " +
        `A call exports at most ${MAX_EXPORT_BATCH} layers and starts none after about ${BATCH_BUDGET_MS / 1000} seconds; the layers it did not get to come back in remaining, to pass as refs in the next call. ` +
        "It stops early, with stoppedBy, when the Figma tab goes to the background, the user steps in, or the browser waits for a Save dialog; other failures, such as a layer Figma hands no file over for, are listed in failed and the rest still export. " +
        "Returns where each file went, not the files themselves. The Figma tab must be visible.",
      inputSchema: {
        contextId: z.string(),
        refs: z.array(z.string()).min(1).max(MAX_EXPORT_BATCH).optional().describe("Refs returned earlier in this context; not combined with snapshot"),
        snapshot: z.string().optional().describe("A snapshot id from snapshot_layer, of the context's file and page: export its layers with export settings"),
        under: z.string().optional().describe("With snapshot: only that layer and the layers inside it"),
        saveTo: z.string().describe("Folder inside the project, for example src/assets/icons/"),
        format: ExportFormatSchema.optional().describe("Pick it for the project; without it the designer's export settings decide"),
        scale: ExportScaleSchema.optional().describe("Default 1x"),
        overwrite: z.boolean().optional(),
      },
      outputSchema: ExportAssetsOutputSchema,
    },
    async ({ contextId, refs, snapshot, under, saveTo, format, scale, overwrite }) => {
      try {
        const started = now();
        const context = contexts.get(contextId);
        if (!context) throw new BridgeError("CONTEXT_NOT_FOUND", `no context ${contextId}`);
        if ((refs === undefined) === (snapshot === undefined)) throw new ExportFailure("INVALID_ARGUMENT", "pass either refs or snapshot");
        if (under !== undefined && snapshot === undefined) throw new ExportFailure("INVALID_ARGUMENT", "under only applies to a snapshot");
        const skipped: ExportAssetsOutput["skipped"] = [];
        let queue: string[];
        if (snapshot !== undefined) {
          const found = await finishedSnapshot(snapshots, snapshot);
          if (!("file" in found)) throw new ExportFailure(found.code, found.message);
          const { file } = found;
          if (file.fileKey !== context.identity.fileKey) throw new ExportFailure("INVALID_ARGUMENT", `snapshot ${snapshot} is of another file than context ${contextId}`);
          if (file.page !== null && context.identity.page !== null && file.page !== context.identity.page) {
            throw new ExportFailure("INVALID_ARGUMENT", `snapshot ${snapshot} is of page "${file.page}", and context ${contextId} of page "${context.identity.page}"; open that page with explore_page first`);
          }
          adoptSnapshot(context, file);
          let layers = file.layers;
          if (under !== undefined) {
            const at = layers.findIndex((layer) => layer.ref === under);
            if (at < 0) throw new ExportFailure("UNKNOWN_REF", `snapshot ${snapshot} has no layer ${under}`);
            layers = [layers[at]!, ...inside(layers, at)];
          }
          queue = [];
          for (const layer of layers.filter((l) => l.exports?.length)) {
            if (layer.hidden) skipped.push({ ref: layer.ref, reason: "hidden" });
            else queue.push(layer.ref);
          }
        } else {
          const unknown = refs!.filter((ref) => !context.knownRefs.has(ref));
          if (unknown.length > 0) throw new BridgeError("UNKNOWN_REF", `refs ${unknown.join(", ")} were not returned in context ${contextId}`);
          queue = [...new Set(refs)];
        }

        const root = projectRoot(deps);
        const used = new Set<string>();
        const saved: ExportAssetsOutput["saved"] = [];
        const failed: ExportAssetsOutput["failed"] = [];
        const remaining: string[] = [];
        let stoppedBy: ExportAssetsOutput["stoppedBy"] = null;
        let restored = true;
        for (const [i, ref] of queue.entries()) {
          if (i >= MAX_EXPORT_BATCH || now() - started >= BATCH_BUDGET_MS) {
            remaining.push(...queue.slice(i));
            break;
          }
          try {
            const { result, files } = await exportLayer(deps, context, ref, format, scale);
            restored &&= result.userSelectionRestored;
            const targets = files.map((file) => {
              const target = unusedPath(resolveSaveTarget(root, saveTo, file.name, true), ref, used);
              used.add(target);
              return target;
            });
            // Nothing of a layer is written when one of its files would replace one that is there.
            if (!overwrite) {
              for (const target of targets) {
                if (await access(target).then(() => true, () => false)) throw new SaveRefused(`${target} already exists; pass overwrite: true to replace it`);
              }
            }
            for (const [n, file] of files.entries()) await save(targets[n]!, file.bytes, overwrite);
            saved.push({
              ref,
              source: result.source,
              usedExistingSettings: result.usedExistingSettings,
              files: files.map((file, n) => ({ name: basename(targets[n]!), mimeType: file.mimeType, bytes: file.bytes.length, savedTo: targets[n]!, downloadPath: file.downloadPath })),
            });
          } catch (error) {
            const code = codeOf(error);
            const message = error instanceof Error ? error.message : String(error);
            if (STOPS_BATCH.has(code)) {
              stoppedBy = { code, message };
              remaining.push(...queue.slice(i));
              break;
            }
            failed.push({ ref, code, message });
          }
        }
        const output: ExportAssetsOutput = { contextId, saved, failed, skipped, remaining, stoppedBy, userSelectionRestored: restored, elapsedMs: now() - started };
        log(`export_assets layers=${queue.length} saved=${saved.length} failed=${failed.length} skipped=${skipped.length} remaining=${remaining.length} stoppedBy=${stoppedBy?.code ?? "-"} ms=${output.elapsedMs}`);
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output as unknown as Record<string, unknown> };
      } catch (error) {
        return toolError(error, { ...EXPORT_HINTS, ...SNAPSHOT_HINTS });
      }
    },
  );
}
