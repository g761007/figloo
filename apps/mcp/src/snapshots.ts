import { chmod, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { RectSchema, SnapshotLayerSchema, type SnapshotLayer } from "@figloo/protocol";

/** Bumped whenever the file layout changes; files of another version count as missing. */
export const SNAPSHOT_FORMAT_VERSION = 1;
export const DEFAULT_SNAPSHOT_TTL_HOURS = 24;

const SnapshotFileSchema = z.object({
  formatVersion: z.literal(SNAPSHOT_FORMAT_VERSION),
  id: z.string(),
  fileKey: z.string(),
  page: z.string().nullable(),
  rootRef: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  /** How long reading Figma took. */
  elapsedMs: z.number().nonnegative(),
  image: z.object({ width: z.number().int(), height: z.number().int(), rootInImage: RectSchema.nullable(), scale: z.number().positive().nullable() }),
  zoom: z.number().positive().nullable(),
  layers: z.array(SnapshotLayerSchema).min(1),
});
export type SnapshotFile = z.infer<typeof SnapshotFileSchema>;

const FILE_KEY = /^[A-Za-z0-9]+$/;
/** Layers outside instances have plain IDs such as 570:14192; those inside look like I570:1;2:3. */
const PLAIN_REF = /^\d+:\d+$/;
const SNAPSHOT_ID = /^([A-Za-z0-9]+)\/(\d+)-(\d+)$/;

/** Only layers outside instances keep their ID across page loads, so only they can root a snapshot. */
export function isPlainRef(ref: string): boolean {
  return PLAIN_REF.test(ref);
}

/** The snapshot of a root, such as AbCd/570-14192: the colon becomes a dash, which file names on every system accept. */
export function snapshotId(fileKey: string, ref: string): string {
  if (!FILE_KEY.test(fileKey) || !PLAIN_REF.test(ref)) throw new Error(`no snapshot can be kept for layer ${ref} of file ${fileKey}`);
  return `${fileKey}/${ref.replace(":", "-")}`;
}

export function parseSnapshotId(id: string): { fileKey: string; ref: string } | null {
  const match = SNAPSHOT_ID.exec(id);
  return match ? { fileKey: match[1]!, ref: `${match[2]}:${match[3]}` } : null;
}

export type SnapshotLookup = { status: "found"; file: SnapshotFile } | { status: "missing" } | { status: "expired"; expiresAt: string };

/**
 * Snapshots saved as files outside the project: <dir>/<file key>/<root>.json with the screenshot
 * next to it as <root>.jpg. Folders are readable by the user only, files likewise.
 */
export class SnapshotStore {
  constructor(
    readonly dir: string,
    readonly ttlMs: number = DEFAULT_SNAPSHOT_TTL_HOURS * 3_600_000,
    private readonly now: () => number = Date.now,
  ) {}

  paths(id: string): { json: string; jpg: string } {
    const parsed = parseSnapshotId(id);
    if (!parsed) throw new Error(`${id} is not a snapshot id`);
    const base = join(this.dir, parsed.fileKey, parsed.ref.replace(":", "-"));
    return { json: `${base}.json`, jpg: `${base}.jpg` };
  }

  async read(id: string): Promise<SnapshotLookup> {
    if (!parseSnapshotId(id)) return { status: "missing" };
    let json: unknown;
    try {
      json = JSON.parse(await readFile(this.paths(id).json, "utf8"));
    } catch {
      return { status: "missing" };
    }
    const parsed = SnapshotFileSchema.safeParse(json);
    if (!parsed.success || parsed.data.id !== id) return { status: "missing" };
    if (Date.parse(parsed.data.expiresAt) <= this.now()) return { status: "expired", expiresAt: parsed.data.expiresAt };
    return { status: "found", file: parsed.data };
  }

  async readImage(id: string): Promise<Buffer | null> {
    return readFile(this.paths(id).jpg).catch(() => null);
  }

  /** Saves a snapshot read just now and removes the expired ones of the same file. */
  async write(snapshot: Omit<SnapshotFile, "formatVersion" | "id" | "createdAt" | "expiresAt">, jpeg: Buffer): Promise<SnapshotFile> {
    const id = snapshotId(snapshot.fileKey, snapshot.rootRef);
    const now = this.now();
    const file: SnapshotFile = { formatVersion: SNAPSHOT_FORMAT_VERSION, id, ...snapshot, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.ttlMs).toISOString() };
    const folder = join(this.dir, snapshot.fileKey);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    // mkdir only sets the mode of folders it creates.
    await chmod(this.dir, 0o700);
    await chmod(folder, 0o700);
    const { json, jpg } = this.paths(id);
    // The screenshot goes first: a snapshot file always has its screenshot.
    await writePrivate(jpg, jpeg);
    await writePrivate(json, JSON.stringify(file));
    await this.sweep(snapshot.fileKey);
    return file;
  }

  private async sweep(fileKey: string): Promise<void> {
    const folder = join(this.dir, fileKey);
    for (const name of await readdir(folder).catch(() => [])) {
      if (!name.endsWith(".json")) continue;
      const id = `${fileKey}/${name.slice(0, -".json".length)}`;
      if ((await this.read(id)).status !== "expired") continue;
      const { json, jpg } = this.paths(id);
      await unlink(json).catch(() => undefined);
      await unlink(jpg).catch(() => undefined);
    }
  }
}

async function writePrivate(path: string, data: string | Buffer): Promise<void> {
  await writeFile(path, data, { mode: 0o600 });
  // writeFile only sets the mode of files it creates.
  await chmod(path, 0o600);
}

const MAX_OUTLINE_NAME = 60;
const MAX_OUTLINE_TEXT = 40;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * One outline line: indent by depth, ref, type, name, place and size in design pixels from the
 * root's corner, then the start of a text layer's content when it differs from its name, and marks.
 */
export function outlineLine(layer: SnapshotLayer): string {
  const { x, y, width, height } = layer.bounds;
  const parts = [`${"  ".repeat(layer.depth)}${layer.ref}`, layer.type ?? "?", JSON.stringify(clip(layer.name, MAX_OUTLINE_NAME))];
  parts.push(x === null || y === null ? "?,?" : `${x},${y}`);
  if (width !== null && height !== null) parts.push(`${width}×${height}`);
  const text = layer.sections.find((section) => section.kind === "content")?.text?.replace(/\s+/g, " ").trim();
  if (text && !layer.name.startsWith(text.slice(0, MAX_OUTLINE_NAME))) parts.push(`text ${JSON.stringify(clip(text, MAX_OUTLINE_TEXT))}`);
  if (layer.hidden) parts.push("[hidden]");
  if (layer.type === "Instance" && layer.hasChildren) parts.push("[has layers]");
  if (layer.exports?.length) parts.push(`[export ${layer.exports.join(", ")}]`);
  return parts.join(" ");
}
