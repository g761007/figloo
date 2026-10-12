import type { SnapshotTimings } from "@figloo/protocol";

/**
 * Adds up where a snapshot's time goes, for `pnpm bench:snapshot`: milliseconds per phase and how
 * often each slow path ran. Numbers only, never layer names or refs.
 *
 * - capture.prepare (in the tab: capture.select, capture.zoom, capture.toast), capture.screen,
 *   capture.crop, capture.finish.
 * - read, the whole read in the tab: read.inspectionPanel, walk, then per layer layer.find,
 *   layer.select, layer.panel, layer.parse, layer.mirror, then finish (closing what the walk opened
 *   and putting the selection back, finish.selection being the latter) and finish.view.
 * - align, checking the screenshot against the mirror.
 * - Counts: panel.unnamed and panel.unchanged (panel waits that ran to 500 or 400 ms),
 *   panel.timeout, mirror.timeout and mirror.hiddenTimeout (300 ms each), pausedRetry.
 */
export class Timings {
  private readonly ms: Record<string, number> = {};
  private readonly counts: Record<string, number> = {};

  add(phase: string, ms: number): void {
    this.ms[phase] = (this.ms[phase] ?? 0) + ms;
  }

  count(name: string): void {
    this.counts[name] = (this.counts[name] ?? 0) + 1;
  }

  async time<T>(phase: string, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await work();
    } finally {
      this.add(phase, performance.now() - started);
    }
  }

  merge(other: SnapshotTimings | undefined): void {
    for (const [phase, ms] of Object.entries(other?.ms ?? {})) this.add(phase, ms);
    for (const [name, n] of Object.entries(other?.counts ?? {})) this.counts[name] = (this.counts[name] ?? 0) + n;
  }

  toJSON(): SnapshotTimings {
    return { ms: Object.fromEntries(Object.entries(this.ms).map(([phase, ms]) => [phase, Math.round(ms)])), counts: { ...this.counts } };
  }
}
