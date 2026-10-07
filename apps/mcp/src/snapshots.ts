import { chmod, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SnapshotChangesSchema, SnapshotImageInfoSchema, SnapshotLayerSchema, type SnapshotLayer } from "@figloo/protocol";

/** Bumped whenever the file layout changes; files of another version count as missing. */
export const SNAPSHOT_FORMAT_VERSION = 2;
export const DEFAULT_SNAPSHOT_TTL_HOURS = 24;
/** An expired snapshot stays this long as what the next snapshot of its root is compared with. */
export const SNAPSHOT_RETENTION_DAYS = 30;
const RETENTION_MS = SNAPSHOT_RETENTION_DAYS * 24 * 3_600_000;

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
  image: SnapshotImageInfoSchema,
  zoom: z.number().positive().nullable(),
  /** The root's ancestors from the layer on the page down; missing from snapshots saved before 0.4.0. */
  rootPath: z.array(z.string()).optional(),
  layers: z.array(SnapshotLayerSchema).min(1),
  /** What changed since the previous snapshot of the root; missing when there was none to compare with. */
  changes: SnapshotChangesSchema.optional(),
});
export type SnapshotFile = z.infer<typeof SnapshotFileSchema>;

/** A snapshot still being read: the layers read so far, and the whole walk to read on from. */
const PartialFileSchema = z.object({
  formatVersion: z.literal(SNAPSHOT_FORMAT_VERSION),
  id: z.string(),
  fileKey: z.string(),
  page: z.string().nullable(),
  rootRef: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  elapsedMs: z.number().nonnegative(),
  /** The first call's screenshot, which the finished snapshot keeps. */
  image: SnapshotImageInfoSchema,
  zoom: z.number().positive().nullable(),
  rootPath: z.array(z.string()),
  /** Every layer of the subtree in walk order; the layers read so far are the first ones. */
  walked: z.array(z.object({ ref: z.string(), parentRef: z.string().nullable() })),
  layers: z.array(SnapshotLayerSchema).min(1),
});
export type PartialSnapshot = z.infer<typeof PartialFileSchema>;

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

  paths(id: string): { json: string; jpg: string; partialJson: string; partialJpg: string } {
    const parsed = parseSnapshotId(id);
    if (!parsed) throw new Error(`${id} is not a snapshot id`);
    const base = join(this.dir, parsed.fileKey, parsed.ref.replace(":", "-"));
    return { json: `${base}.json`, jpg: `${base}.jpg`, partialJson: `${base}.partial.json`, partialJpg: `${base}.partial.jpg` };
  }

  async read(id: string): Promise<SnapshotLookup> {
    const file = await this.readSaved(id);
    if (!file) return { status: "missing" };
    if (Date.parse(file.expiresAt) <= this.now()) return { status: "expired", expiresAt: file.expiresAt };
    return { status: "found", file };
  }

  /** The saved file whether or not it has expired, or null when there is none of this format. */
  async readSaved(id: string): Promise<SnapshotFile | null> {
    if (!parseSnapshotId(id)) return null;
    let json: unknown;
    try {
      json = JSON.parse(await readFile(this.paths(id).json, "utf8"));
    } catch {
      return null;
    }
    const parsed = SnapshotFileSchema.safeParse(json);
    return parsed.success && parsed.data.id === id ? parsed.data : null;
  }

  async readImage(id: string): Promise<Buffer | null> {
    return readFile(this.paths(id).jpg).catch(() => null);
  }

  /** The snapshot still being read, with its screenshot, until it expires like a finished one. */
  async readPartial(id: string): Promise<{ file: PartialSnapshot; jpeg: Buffer } | null> {
    if (!parseSnapshotId(id)) return null;
    const { partialJson, partialJpg } = this.paths(id);
    const parsed = PartialFileSchema.safeParse(await readFile(partialJson, "utf8").then(JSON.parse, () => null));
    if (!parsed.success || parsed.data.id !== id || Date.parse(parsed.data.expiresAt) <= this.now()) return null;
    const jpeg = await readFile(partialJpg).catch(() => null);
    return jpeg ? { file: parsed.data, jpeg } : null;
  }

  /** Saves how far a snapshot got; it lives as long as a snapshot from its first call, `createdAt`. */
  async writePartial(snapshot: Omit<PartialSnapshot, "formatVersion" | "id" | "createdAt" | "expiresAt">, jpeg: Buffer, createdAt?: string): Promise<PartialSnapshot> {
    const id = snapshotId(snapshot.fileKey, snapshot.rootRef);
    const started = createdAt ? Date.parse(createdAt) : this.now();
    const file: PartialSnapshot = { formatVersion: SNAPSHOT_FORMAT_VERSION, id, ...snapshot, createdAt: new Date(started).toISOString(), expiresAt: new Date(started + this.ttlMs).toISOString() };
    await this.privateFolder(snapshot.fileKey);
    const { partialJson, partialJpg } = this.paths(id);
    await writePrivate(partialJpg, jpeg);
    await writePrivate(partialJson, JSON.stringify(file));
    return file;
  }

  async removePartial(id: string): Promise<void> {
    if (!parseSnapshotId(id)) return;
    const { partialJson, partialJpg } = this.paths(id);
    await unlink(partialJson).catch(() => undefined);
    await unlink(partialJpg).catch(() => undefined);
  }

  /** Saves a snapshot read just now and removes the expired ones of the same file. */
  async write(snapshot: Omit<SnapshotFile, "formatVersion" | "id" | "createdAt" | "expiresAt">, jpeg: Buffer): Promise<SnapshotFile> {
    const id = snapshotId(snapshot.fileKey, snapshot.rootRef);
    const now = this.now();
    const file: SnapshotFile = { formatVersion: SNAPSHOT_FORMAT_VERSION, id, ...snapshot, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.ttlMs).toISOString() };
    await this.privateFolder(snapshot.fileKey);
    const { json, jpg } = this.paths(id);
    // The screenshot goes first: a snapshot file always has its screenshot.
    await writePrivate(jpg, jpeg);
    await writePrivate(json, JSON.stringify(file));
    await this.sweep(snapshot.fileKey);
    return file;
  }

  private async privateFolder(fileKey: string): Promise<void> {
    const folder = join(this.dir, fileKey);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    // mkdir only sets the mode of folders it creates.
    await chmod(this.dir, 0o700);
    await chmod(folder, 0o700);
  }

  private async sweep(fileKey: string): Promise<void> {
    const folder = join(this.dir, fileKey);
    for (const name of await readdir(folder).catch(() => [])) {
      if (name.endsWith(".partial.json")) {
        const id = `${fileKey}/${name.slice(0, -".partial.json".length)}`;
        if (!(await this.readPartial(id))) await this.removePartial(id);
        continue;
      }
      if (!name.endsWith(".json")) continue;
      const id = `${fileKey}/${name.slice(0, -".json".length)}`;
      // Expired snapshots stay a while as the baseline the next snapshot of their root is compared with.
      const saved = await this.readSaved(id);
      if (!saved || Date.parse(saved.expiresAt) + RETENTION_MS > this.now()) continue;
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

/** Parts of a layer's inspection panel Figloo saw but could not read: section kinds, and "export". */
export function unreadableParts(layer: SnapshotLayer): string[] {
  return [...layer.sections.filter((section) => section.unreadable).map((section) => section.kind), ...(layer.exportsUnreadable ? ["export"] : [])];
}

/**
 * One outline line: indent by depth, ref, type, name, place and size in design pixels from the
 * root's corner, then the start of a text layer's content when it differs from its name, and marks,
 * with `change` saying what changed since the previous snapshot.
 */
export function outlineLine(layer: SnapshotLayer, change?: string): string {
  const { x, y, width, height } = layer.bounds;
  const parts = [`${"  ".repeat(layer.depth)}${layer.ref}`, layer.type ?? "?", JSON.stringify(clip(layer.name, MAX_OUTLINE_NAME))];
  parts.push(x === null || y === null ? "?,?" : `${x},${y}`);
  if (width !== null && height !== null) parts.push(`${width}×${height}`);
  const text = layer.sections.find((section) => section.kind === "content")?.text?.replace(/\s+/g, " ").trim();
  if (text && !layer.name.startsWith(text.slice(0, MAX_OUTLINE_NAME))) parts.push(`text ${JSON.stringify(clip(text, MAX_OUTLINE_TEXT))}`);
  if (layer.hidden) parts.push("[hidden]");
  if (layer.type === "Instance" && layer.hasChildren) parts.push("[has layers]");
  if (layer.exports?.length) parts.push(`[export ${layer.exports.join(", ")}]`);
  const unreadable = unreadableParts(layer);
  if (unreadable.length > 0) parts.push(`[unreadable: ${unreadable.join(", ")}]`);
  if (change) parts.push(change);
  return parts.join(" ");
}
