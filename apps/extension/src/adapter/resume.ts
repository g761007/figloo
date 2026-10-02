import { StopExploration } from "./tree.js";

/**
 * Where a snapshot call starts reading. Earlier calls hand over the walk they saw, as "ref|parentRef"
 * in walk order; when the walk now differs, the design changed, and reading starts over from the root.
 */
export function resumePoint(walked: string[], resume: { readFrom: number; structure: string[] } | undefined): { start: number; restarted: boolean } {
  if (!resume || resume.readFrom === 0) return { start: 0, restarted: false };
  const same = resume.structure.length === walked.length && resume.structure.every((entry, i) => entry === walked[i]);
  return same ? { start: Math.min(resume.readFrom, walked.length), restarted: false } : { start: 0, restarted: true };
}

/**
 * Reads `indexes` in turn. With `canStop`, the read ends early and keeps what it has when `timeIsUp`
 * says so before a layer, or when a budget stops a layer halfway; that layer is read by the next call.
 * The first index, the root, is always read, and user input always ends the read.
 */
export async function readInTurn<T>(
  indexes: number[],
  readOne: (index: number) => Promise<T>,
  { canStop, timeIsUp }: { canStop: boolean; timeIsUp: () => boolean },
): Promise<{ read: T[]; stoppedAt: number | null }> {
  const read: T[] = [];
  for (const [n, index] of indexes.entries()) {
    if (canStop && n > 0 && timeIsUp()) return { read, stoppedAt: index };
    try {
      read.push(await readOne(index));
    } catch (error) {
      const budget = error instanceof StopExploration && (error.cause === "time_budget" || error.cause === "scan_budget");
      if (canStop && n > 0 && budget) return { read, stoppedAt: index };
      throw error;
    }
  }
  return { read, stoppedAt: null };
}
