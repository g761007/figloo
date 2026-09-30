import { z } from "zod";
import { NeighborRelationSchema, type NeighborRelation } from "@figloo/protocol";

const CursorSchema = z.object({
  c: z.string(),
  r: z.string(),
  rel: NeighborRelationSchema,
  from: z.number().int().positive(),
  after: z.string().nullable(),
});

export interface CursorState {
  contextId: string;
  ref: string;
  relation: NeighborRelation;
  from: number;
  /** Ref of the last layer already returned, so the tab can resume without rescanning. */
  after: string | null;
}

/** Opaque to the agent; only valid for the context, ref, and relation it was issued for. */
export function encodeCursor(state: CursorState): string {
  const payload = { c: state.contextId, r: state.ref, rel: state.relation, from: state.from, after: state.after };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeCursor(cursor: string): CursorState | null {
  try {
    const parsed = CursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return { contextId: parsed.c, ref: parsed.r, relation: parsed.rel, from: parsed.from, after: parsed.after };
  } catch {
    return null;
  }
}
