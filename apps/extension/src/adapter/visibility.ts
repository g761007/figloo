import { StopExploration } from "./tree.js";

/**
 * Lets a long read wait while its Figma tab is in the background, where Figma ignores selection and
 * expansion, instead of failing, until the read's deadline. It counts visibility changes, so a step
 * the tab was hidden during can be done again. It waits on visibilitychange, not on a timer, since
 * background tabs throttle timers.
 */
export class BackgroundPause {
  private changes = 0;
  private readonly onChange = () => {
    this.changes += 1;
  };

  constructor(
    private readonly doc: Document,
    private readonly deadline: number,
    private readonly onPause: (paused: boolean) => void = () => {},
  ) {
    doc.addEventListener("visibilitychange", this.onChange);
  }

  /** A mark to pass to `hidSince`. */
  mark(): number {
    return this.changes;
  }

  /** Whether the tab was hidden at some point since `mark`, or is hidden now. */
  hidSince(mark: number): boolean {
    return this.changes !== mark || this.doc.hidden;
  }

  /** Resolves once the tab is on screen; when the deadline passes first, stops the read on its time budget. */
  async untilVisible(): Promise<void> {
    if (!this.doc.hidden) return;
    this.onPause(true);
    await new Promise<void>((resolve) => {
      const done = () => {
        this.doc.removeEventListener("visibilitychange", onVisibility);
        clearTimeout(timer);
        resolve();
      };
      const onVisibility = () => {
        if (!this.doc.hidden) done();
      };
      const timer = setTimeout(done, Math.max(0, this.deadline - Date.now()));
      this.doc.addEventListener("visibilitychange", onVisibility);
    });
    this.onPause(false);
    if (this.doc.hidden) throw new StopExploration("time_budget");
  }

  dispose(): void {
    this.doc.removeEventListener("visibilitychange", this.onChange);
  }
}
