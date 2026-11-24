import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SurveyResultSchema, SurveyRootSchema } from "@figloo/protocol";
import { DEFAULT_SNAPSHOT_TTL_HOURS } from "./snapshots.js";

/** Bumped whenever the file layout changes; files of another version count as missing. */
export const SURVEY_FORMAT_VERSION = 1;

const SurveyFileSchema = z.object({
  formatVersion: z.literal(SURVEY_FORMAT_VERSION),
  id: z.string(),
  fileKey: z.string(),
  page: z.string().nullable(),
  /** The frames and sections asked for, or null for the whole page. */
  refs: z.array(z.string()).nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  /** How long reading Figma took, over all calls. */
  elapsedMs: z.number().nonnegative(),
  /** False while layers of the scope are left; the next call goes on with them. */
  complete: z.boolean(),
  scope: SurveyResultSchema.shape.scope,
  sections: SurveyResultSchema.shape.sections,
  /** The layers of the scope surveyed so far, in layers panel order. */
  roots: z.array(SurveyRootSchema),
});
export type SurveyFile = z.infer<typeof SurveyFileSchema>;

const FILE_KEY = /^[A-Za-z0-9]+$/;
const SURVEY_ID = /^([A-Za-z0-9]+)\/((?:page|refs)-[0-9a-f]{16})$/;

/**
 * The survey of a page, or of some frames and sections of it, such as AbCd/page-1a2b3c4d5e6f7a8b.
 * The page name and refs are hashed, so file names never carry layer or page names.
 */
export function surveyId(fileKey: string, page: string | null, refs: string[] | null): string {
  if (!FILE_KEY.test(fileKey)) throw new Error(`no survey can be kept for file ${fileKey}`);
  const scope = refs === null ? "" : [...new Set(refs)].sort().join(",");
  const hash = createHash("sha256").update(`${page ?? ""}\n${scope}`).digest("hex").slice(0, 16);
  return `${fileKey}/${refs === null ? "page" : "refs"}-${hash}`;
}

export function parseSurveyId(id: string): { fileKey: string; name: string } | null {
  const match = SURVEY_ID.exec(id);
  return match ? { fileKey: match[1]!, name: match[2]! } : null;
}

/** Surveys saved as files outside the project, <dir>/<file key>/<scope>.json, readable by the user only. */
export class SurveyStore {
  constructor(
    readonly dir: string,
    readonly ttlMs: number = DEFAULT_SNAPSHOT_TTL_HOURS * 3_600_000,
    private readonly now: () => number = Date.now,
  ) {}

  path(id: string): string {
    const parsed = parseSurveyId(id);
    if (!parsed) throw new Error(`${id} is not a survey id`);
    return join(this.dir, parsed.fileKey, `${parsed.name}.json`);
  }

  /** The survey, finished or not, until it expires; null when there is none of this format. */
  async read(id: string): Promise<SurveyFile | null> {
    if (!parseSurveyId(id)) return null;
    const parsed = SurveyFileSchema.safeParse(await readFile(this.path(id), "utf8").then(JSON.parse, () => null));
    if (!parsed.success || parsed.data.id !== id || Date.parse(parsed.data.expiresAt) <= this.now()) return null;
    return parsed.data;
  }

  /** Saves a survey; one that goes on keeps the lifetime from its first call, `createdAt`. Removes expired surveys of the file. */
  async write(survey: Omit<SurveyFile, "formatVersion" | "createdAt" | "expiresAt">, createdAt?: string): Promise<SurveyFile> {
    const started = createdAt ? Date.parse(createdAt) : this.now();
    const file: SurveyFile = { formatVersion: SURVEY_FORMAT_VERSION, ...survey, createdAt: new Date(started).toISOString(), expiresAt: new Date(started + this.ttlMs).toISOString() };
    const folder = join(this.dir, survey.fileKey);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    // mkdir only sets the mode of folders it creates.
    await chmod(this.dir, 0o700);
    await chmod(folder, 0o700);
    const path = this.path(survey.id);
    await writeFile(path, JSON.stringify(file), { mode: 0o600 });
    await chmod(path, 0o600);
    await this.sweep(survey.fileKey);
    return file;
  }

  async remove(id: string): Promise<void> {
    if (parseSurveyId(id)) await unlink(this.path(id)).catch(() => undefined);
  }

  private async sweep(fileKey: string): Promise<void> {
    for (const name of await readdir(join(this.dir, fileKey)).catch(() => [])) {
      if (!name.endsWith(".json")) continue;
      const id = `${fileKey}/${name.slice(0, -".json".length)}`;
      if (parseSurveyId(id) && !(await this.read(id))) await this.remove(id);
    }
  }
}
