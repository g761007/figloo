/** What the overlay reports while Figloo works in the page. */
export type ReadingProgress =
  | { phase: "working" }
  | { phase: "walking"; found: number }
  | { phase: "reading"; done: number; total: number; remainingMs: number | null }
  | { phase: "surveying"; done: number; total: number; remainingMs: number | null }
  | { phase: "capturing"; done: number; total: number }
  | { phase: "finishing" };

const WORKING: ReadingProgress = { phase: "working" };

/** The overlay text changes at most this often, so reading hundreds of layers does not churn the DOM. */
const RENDER_INTERVAL_MS = 250;
/** How long the page stays locked behind a clear layer before the card shows, so short operations do not flash it. */
export const CARD_DELAY_MS = 500;
/** A hidden tab draws no frames, so waiting for them ends after this long. */
const FRAME_WAIT_MS = 100;
/** Layers the remaining time is averaged over. */
const ESTIMATE_WINDOW = 20;
/** Keys are kept from Figma wherever the focus is, since Figma takes the focus when Figloo selects layers or presses keys. */
const KEY_EVENTS = ["keydown", "keyup", "keypress"];
/** Input the overlay keeps from Figma; pointer moves pass, so the cursor still shows. */
const BLOCKED_EVENTS = [
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "wheel",
  "touchstart",
  "touchmove",
  "touchend",
  ...KEY_EVENTS,
];

/** Time left from the average of the last 20 layers, rounded to 5 s; null before any layer was read. */
export function estimateRemainingMs(durations: number[], remaining: number): number | null {
  const recent = durations.slice(-ESTIMATE_WINDOW);
  if (recent.length === 0) return null;
  const average = recent.reduce((sum, ms) => sum + ms, 0) / recent.length;
  return Math.round((average * remaining) / 5_000) * 5_000;
}

export function progressText(progress: ReadingProgress): string {
  switch (progress.phase) {
    case "working":
      return "Working, this takes a few seconds";
    case "walking":
      return `Finding layers: ${progress.found} so far`;
    case "reading":
      return `Read ${progress.done} of ${progress.total} layers${progress.remainingMs === null ? "" : `, ${remainingText(progress.remainingMs)}`}`;
    case "surveying":
      return `Looked through ${progress.done} of ${progress.total} frames and other layers${progress.remainingMs === null ? "" : `, ${remainingText(progress.remainingMs)}`}`;
    case "capturing":
      return `Captured ${progress.done} of ${progress.total} frames`;
    case "finishing":
      return "Putting the layers panel back";
  }
}

function remainingText(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  if (seconds <= 0) return "almost done";
  if (seconds < 60) return `about ${seconds} s left`;
  const rest = seconds % 60;
  return `about ${Math.floor(seconds / 60)} min${rest ? ` ${rest} s` : ""} left`;
}

/**
 * Locks the Figma page while Figloo works in it: a layer over the whole page keeps stray clicks,
 * scrolling, and keys from Figma, says what is going on, and offers Stop, which Esc also triggers.
 * The page is locked from the first hold until the last one is released; the layer stays clear
 * for the first half second, so short operations do not flash it. It lives in a closed shadow
 * root, so Figma's styles and scripts cannot reach it; styles are set through CSSOM, which Figma's
 * content security policy allows. Figloo's own clicks and keys are dispatched straight to their
 * targets and do not pass through it.
 */
export class ReadingOverlay {
  /** Only this object holds the closed root; page scripts cannot reach it. Tests read it. */
  readonly root: ShadowRoot;
  private readonly host: HTMLElement;
  private readonly status: HTMLElement;
  private readonly stopButton: HTMLButtonElement;
  private progress: ReadingProgress = WORKING;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cardTimer: ReturnType<typeof setTimeout> | null = null;
  private previousFocus: Element | null = null;
  private stopping = false;
  private paused = false;
  private holds = 0;
  private cardShown = false;
  private concealed = false;
  /**
   * Registered once, before any watch for the user's input, so keys it keeps from Figma never count
   * as the user stepping in. Keys aimed at the Stop button are stopped here too: on their way to it
   * they would pass Figma's own capture listeners, and an Esc there clears the selection.
   */
  private readonly onKey = (event: Event) => {
    if (this.holds === 0 || !event.isTrusted) return;
    event.stopImmediatePropagation();
    this.block(event);
  };

  constructor(private readonly doc: Document) {
    this.host = doc.createElement("figloo-reading-overlay");
    style(this.host, { all: "initial", position: "fixed", inset: "0", zIndex: "2147483647" });
    this.root = this.host.attachShadow({ mode: "closed" });

    const backdrop = this.el("div");
    style(backdrop, {
      position: "fixed",
      inset: "0",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "rgba(15, 23, 42, 0.35)",
      font: "14px/1.5 system-ui, -apple-system, sans-serif",
      color: "#111827",
    });
    const card = this.el("div");
    card.setAttribute("role", "alertdialog");
    card.setAttribute("aria-modal", "true");
    style(card, {
      background: "#ffffff",
      borderRadius: "12px",
      boxShadow: "0 10px 30px rgba(0, 0, 0, 0.25)",
      padding: "20px 24px",
      width: "min(360px, calc(100vw - 32px))",
      boxSizing: "border-box",
    });
    const title = this.el("h2", "Figloo is reading this page for your coding agent");
    title.id = "figloo-title";
    style(title, { margin: "0 0 8px", fontSize: "15px", fontWeight: "600" });
    this.status = this.el("p");
    this.status.setAttribute("aria-live", "polite");
    style(this.status, { margin: "0 0 8px", fontVariantNumeric: "tabular-nums" });
    const note = this.el("p", "Keep this tab on screen. You can use other windows meanwhile.");
    note.id = "figloo-note";
    style(note, { margin: "0 0 16px", color: "#4b5563" });
    this.stopButton = this.el("button", "Stop");
    this.stopButton.type = "button";
    this.stopButton.setAttribute("aria-keyshortcuts", "Escape");
    style(this.stopButton, { font: "inherit", padding: "6px 16px", borderRadius: "6px", border: "1px solid #d1d5db", background: "#f9fafb", color: "inherit", cursor: "pointer" });
    card.setAttribute("aria-labelledby", title.id);
    card.setAttribute("aria-describedby", note.id);
    card.append(title, this.status, note, this.stopButton);
    backdrop.append(card);
    this.root.append(backdrop);

    this.stopButton.addEventListener("click", () => this.stop());
    // The Stop button's own click listener runs first; nothing on the overlay then reaches Figma.
    for (const type of BLOCKED_EVENTS) this.host.addEventListener(type, (event) => this.block(event), { passive: false });
    for (const type of KEY_EVENTS) doc.defaultView?.addEventListener(type, this.onKey, { capture: true });
  }

  /** Stop or Esc was pressed since the page was locked; it holds until the last hold is released. */
  get stopRequested(): boolean {
    return this.stopping;
  }

  get held(): boolean {
    return this.holds > 0;
  }

  /** Whether the card shows: once the clear first half second is over, and not while a screenshot is taken. */
  get visible(): boolean {
    return this.held && this.cardShown && !this.concealed;
  }

  /**
   * Locks the page until the returned function runs. Holds count: the page stays locked until the
   * last one is released, and Stop holds as long. With `leaseMs` the hold ends on its own after
   * that long, for a holder that may never release it, such as a service worker that stopped.
   */
  hold(leaseMs?: number): () => void {
    this.holds += 1;
    if (this.holds === 1) this.attach();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (lease) clearTimeout(lease);
      this.holds -= 1;
      if (this.holds === 0) this.detach();
    };
    const lease = leaseMs === undefined ? null : setTimeout(release, leaseMs);
    return release;
  }

  update(progress: ReadingProgress): void {
    this.progress = progress;
  }

  /** While the tab is in the background the read waits; the text says so when the user comes back. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.render();
  }

  /**
   * Makes the overlay invisible for a screenshot and resolves once the page has been drawn without
   * it. It still keeps input from Figma meanwhile.
   */
  async conceal(): Promise<void> {
    this.concealed = true;
    this.apply();
    await nextFrames(this.doc.defaultView, 2);
  }

  /** Shows the overlay again after a screenshot. */
  reveal(): void {
    this.concealed = false;
    this.apply();
    this.render();
  }

  /** Whether an event happened on the overlay, so it does not count as the user stepping in. */
  owns(event: Event): boolean {
    return event.composedPath().includes(this.host);
  }

  /** Unlocks the page and stops listening, for a content script that is being replaced. */
  dispose(): void {
    for (const type of KEY_EVENTS) this.doc.defaultView?.removeEventListener(type, this.onKey, { capture: true });
    this.holds = 0;
    this.detach();
  }

  private attach(): void {
    this.previousFocus = this.doc.activeElement;
    this.cardShown = false;
    this.concealed = false;
    this.apply();
    this.doc.documentElement.append(this.host);
    this.render();
    this.timer = setInterval(() => this.render(), RENDER_INTERVAL_MS);
    this.cardTimer = setTimeout(() => this.showCard(), CARD_DELAY_MS);
  }

  private detach(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.cardTimer) clearTimeout(this.cardTimer);
    this.timer = null;
    this.cardTimer = null;
    this.stopping = false;
    this.stopButton.disabled = false;
    this.paused = false;
    this.progress = WORKING;
    if (!this.host.isConnected) return;
    this.host.remove();
    const previous = this.previousFocus as HTMLElement | null;
    if (previous?.isConnected && typeof previous.focus === "function") previous.focus({ preventScroll: true });
  }

  private showCard(): void {
    if (this.cardShown || this.holds === 0) return;
    this.cardShown = true;
    this.apply();
    this.render();
  }

  /** The host stays in the page and keeps input from Figma whether or not it can be seen. */
  private apply(): void {
    this.host.style.opacity = this.cardShown && !this.concealed ? "1" : "0";
  }

  private stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.stopButton.disabled = true;
    this.render();
  }

  private block(event: Event): void {
    event.stopPropagation();
    // A user who reaches for Figma learns at once why nothing happens.
    if (event.isTrusted) this.showCard();
    // Only Esc stops; every other key is ignored, so a stray key press does not end a long read.
    if (event.type === "keydown" && (event as KeyboardEvent).key === "Escape") this.stop();
    if (event.cancelable) event.preventDefault();
  }

  private render(): void {
    const text = this.stopping
      ? "Stopping and putting back what Figloo changed"
      : this.paused
        ? "Paused: bring this tab back on screen to continue"
        : progressText(this.progress);
    if (this.status.textContent !== text) this.status.textContent = text;
    // The card takes the focus once it shows, so Tab and Enter reach Stop; Figma may take it back when a layer is selected.
    if (this.visible && !this.stopping && this.doc.activeElement !== this.host) this.stopButton.focus({ preventScroll: true });
  }

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const node = this.doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }
}

/** Resolves once the page has drawn `count` more frames, or after FRAME_WAIT_MS, since a hidden tab draws none. */
function nextFrames(win: Window | null, count: number): Promise<void> {
  return new Promise((resolve) => {
    const fallback = setTimeout(resolve, FRAME_WAIT_MS);
    if (!win?.requestAnimationFrame) return;
    let left = count;
    const step = () => {
      left -= 1;
      if (left > 0) {
        win.requestAnimationFrame(step);
        return;
      }
      clearTimeout(fallback);
      resolve();
    };
    win.requestAnimationFrame(step);
  });
}

function style(el: HTMLElement, properties: Partial<Record<keyof CSSStyleDeclaration, string>>): void {
  Object.assign(el.style, properties);
}
