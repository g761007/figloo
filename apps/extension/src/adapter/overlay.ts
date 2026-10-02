/** What the overlay reports while a snapshot reads the page. */
export type ReadingProgress =
  | { phase: "walking"; found: number }
  | { phase: "reading"; done: number; total: number; remainingMs: number | null }
  | { phase: "finishing" };

/** The overlay text changes at most this often, so reading hundreds of layers does not churn the DOM. */
const RENDER_INTERVAL_MS = 250;
/** Layers the remaining time is averaged over. */
const ESTIMATE_WINDOW = 20;
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
  "keydown",
  "keyup",
  "keypress",
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
    case "walking":
      return `Finding layers: ${progress.found} so far`;
    case "reading":
      return `Read ${progress.done} of ${progress.total} layers${progress.remainingMs === null ? "" : `, ${remainingText(progress.remainingMs)}`}`;
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
 * A layer over the whole Figma page while a snapshot reads it: it says what is going on, keeps
 * stray clicks, scrolling, and keys from Figma, and offers Stop, which Esc also triggers. It lives
 * in a closed shadow root, so Figma's styles and scripts cannot reach it; styles are set through
 * CSSOM, which Figma's content security policy allows. Figloo's own clicks go straight to layer
 * rows and do not pass through it.
 */
export class ReadingOverlay {
  /** Only this object holds the closed root; page scripts cannot reach it. Tests read it. */
  readonly root: ShadowRoot;
  private readonly host: HTMLElement;
  private readonly status: HTMLElement;
  private readonly stopButton: HTMLButtonElement;
  private progress: ReadingProgress = { phase: "walking", found: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;
  private previousFocus: Element | null = null;
  private stopping = false;

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
  }

  get stopRequested(): boolean {
    return this.stopping;
  }

  show(): void {
    if (this.host.isConnected) return;
    this.previousFocus = this.doc.activeElement;
    this.doc.documentElement.append(this.host);
    this.render();
    this.timer = setInterval(() => this.render(), RENDER_INTERVAL_MS);
  }

  update(progress: ReadingProgress): void {
    this.progress = progress;
  }

  remove(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.host.isConnected) return;
    this.host.remove();
    const previous = this.previousFocus as HTMLElement | null;
    if (previous?.isConnected && typeof previous.focus === "function") previous.focus({ preventScroll: true });
  }

  /** Whether an event happened on the overlay, so it does not count as the user stepping in. */
  owns(event: Event): boolean {
    return event.composedPath().includes(this.host);
  }

  private stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.stopButton.disabled = true;
    this.render();
  }

  private block(event: Event): void {
    event.stopPropagation();
    // Only Esc stops; every other key is ignored, so a stray key press does not end a long read.
    if (event.type === "keydown" && (event as KeyboardEvent).key === "Escape") this.stop();
    if (event.cancelable) event.preventDefault();
  }

  private render(): void {
    const text = this.stopping ? "Stopping and putting the layers panel back" : progressText(this.progress);
    if (this.status.textContent !== text) this.status.textContent = text;
    // Keys reach the overlay only while it has focus; Figma may take focus when a layer is selected.
    if (!this.stopping && this.doc.activeElement !== this.host) this.stopButton.focus({ preventScroll: true });
  }

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const node = this.doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }
}

function style(el: HTMLElement, properties: Partial<Record<keyof CSSStyleDeclaration, string>>): void {
  Object.assign(el.style, properties);
}
