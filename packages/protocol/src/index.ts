import { z } from "zod";

export const PROTOCOL_VERSION = "0.1.0";

export const ConnectionStatusSchema = z.enum([
  "DISCONNECTED",
  "NO_DESIGN_TAB",
  "LOADING",
  "READY",
  "DEGRADED",
  "INCOMPATIBLE",
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

export const FieldStatusSchema = z.enum([
  "observed",
  "mixed",
  "not_exposed",
  "unsupported",
  "read_failed",
]);
export type FieldStatus = z.infer<typeof FieldStatusSchema>;

export const NeighborRelationSchema = z.enum(["parent", "ancestors", "siblings", "children"]);
export type NeighborRelation = z.infer<typeof NeighborRelationSchema>;

export const ErrorCodeSchema = z.enum(["USER_INTERRUPTED"]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
