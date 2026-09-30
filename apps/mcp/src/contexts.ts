import { randomUUID } from "node:crypto";
import type { PageIdentity } from "@figloo/protocol";

/** One exploration: the tab, page load, and anchor it is pinned to, and the refs it handed out. */
export interface ExplorationContext {
  id: string;
  tabId: number;
  identity: PageIdentity;
  anchorRef: string;
  /** Only refs returned in this context may be explored further, which keeps exploration local. */
  knownRefs: Set<string>;
  lastUsedAt: number;
}

const IDLE_TTL_MS = 30 * 60_000;
const MAX_CONTEXTS = 32;

export class ContextStore {
  private readonly contexts = new Map<string, ExplorationContext>();

  constructor(private readonly now: () => number = Date.now) {}

  create(tabId: number, identity: PageIdentity, anchorRef: string): ExplorationContext {
    this.sweep();
    const context: ExplorationContext = {
      id: `ctx_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      tabId,
      identity,
      anchorRef,
      knownRefs: new Set([anchorRef]),
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
