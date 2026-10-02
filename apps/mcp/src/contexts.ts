import { randomUUID } from "node:crypto";
import { MAX_KNOWN_LAYERS, type KnownLayers, type PageIdentity } from "@figloo/protocol";

/** One exploration: the tab, page load, and anchor it is pinned to, and the refs it handed out. */
export interface ExplorationContext {
  id: string;
  tabId: number;
  identity: PageIdentity;
  /** null for contexts opened from a page rather than from the user's selection. */
  anchorRef: string | null;
  /** Only refs returned in this context may be explored further, which keeps exploration local. */
  knownRefs: Set<string>;
  /** Parents of layers from saved snapshots, null for a layer on the page, so the tab can find them after a reload. */
  parents: Map<string, string | null>;
  lastUsedAt: number;
}

/** The parents that lead to `refs`, from what saved snapshots told this context, for an op's `known`. */
export function knownParents(context: ExplorationContext, refs: Iterable<string>): { known?: KnownLayers } {
  const known = new Map<string, string | null>();
  for (const ref of refs) {
    // The layers panel nests far less deep than this; the bound only guards against a loop.
    for (let at: string | null = ref, steps = 0; at !== null && context.parents.has(at) && !known.has(at) && steps < MAX_KNOWN_LAYERS; steps += 1) {
      const parent: string | null = context.parents.get(at)!;
      known.set(at, parent);
      at = parent;
    }
  }
  const list = [...known].map(([ref, parentRef]) => ({ ref, parentRef })).slice(0, MAX_KNOWN_LAYERS);
  return list.length > 0 ? { known: list } : {};
}

const IDLE_TTL_MS = 30 * 60_000;
const MAX_CONTEXTS = 32;

export class ContextStore {
  private readonly contexts = new Map<string, ExplorationContext>();

  constructor(private readonly now: () => number = Date.now) {}

  create(tabId: number, identity: PageIdentity, anchorRef: string | null): ExplorationContext {
    this.sweep();
    const context: ExplorationContext = {
      id: `ctx_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      tabId,
      identity,
      anchorRef,
      knownRefs: new Set(anchorRef ? [anchorRef] : []),
      parents: new Map(),
      lastUsedAt: this.now(),
    };
    this.contexts.set(context.id, context);
    while (this.contexts.size > MAX_CONTEXTS) {
      const oldest = [...this.contexts.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]!;
      this.contexts.delete(oldest.id);
    }
    return context;
  }

  get(id: string): ExplorationContext | undefined {
    this.sweep();
    const context = this.contexts.get(id);
    if (context) context.lastUsedAt = this.now();
    return context;
  }

  release(id: string): boolean {
    return this.contexts.delete(id);
  }

  private sweep(): void {
    const cutoff = this.now() - IDLE_TTL_MS;
    for (const [id, context] of this.contexts) if (context.lastUsedAt < cutoff) this.contexts.delete(id);
  }
}
