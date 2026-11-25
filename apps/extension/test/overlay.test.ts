// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CARD_DELAY_MS, ReadingOverlay, estimateRemainingMs, progressText } from "../src/adapter/overlay.js";

let overlay: ReadingOverlay;
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<input id="figma-focus" />';
  document.querySelector<HTMLInputElement>("#figma-focus")!.focus();
  overlay = new ReadingOverlay(document);
});
afterEach(() => {
  overlay.dispose();
  vi.useRealTimers();
});

const host = () => document.querySelector<HTMLElement>("figloo-reading-overlay");
const stopButton = () => overlay.root.querySelector("button")!;
const backdrop = () => overlay.root.firstElementChild!;
const statusText = () => overlay.root.querySelector('[aria-live="polite"]')?.textContent;
const figmaInput = () => document.querySelector<HTMLInputElement>("#figma-focus")!;

/** An event as the browser reports a real one from the user. */
function trusted<T extends Event>(event: T): T {
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
}
const press = (key: string) => trusted(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true }));

describe("the lock over the Figma page", () => {
  it("locks the page behind a clear layer at once and shows the card after half a second", () => {
    overlay.hold();
    expect(host()?.parentElement).toBe(document.documentElement);
    expect(host()?.shadowRoot).toBeNull();
    expect(host()?.style.opacity).toBe("0");
    // A short operation does not take the focus from Figma.
    expect(document.activeElement).toBe(figmaInput());

    vi.advanceTimersByTime(CARD_DELAY_MS);
    expect(host()?.style.opacity).toBe("1");
    expect(overlay.visible).toBe(true);
    expect(overlay.root.querySelector('[role="alertdialog"]')?.textContent).toContain("Figloo is reading this page for your coding agent");
    expect(statusText()).toBe("Working, this takes a few seconds");
    expect(overlay.root.activeElement).toBe(stopButton());
  });

  it("shows the card at once when the user reaches for Figma during the clear half second", () => {
    overlay.hold();
    backdrop().dispatchEvent(trusted(new PointerEvent("pointerdown", { bubbles: true, composed: true, cancelable: true })));
    expect(host()?.style.opacity).toBe("1");
  });

  it("stays locked until the last hold is released, then goes away and gives the focus back", () => {
    const outer = overlay.hold();
    const inner = overlay.hold();
    vi.advanceTimersByTime(CARD_DELAY_MS);
    inner();
    inner();
    expect(host()).not.toBeNull();
    outer();
    expect(host()).toBeNull();
    expect(overlay.held).toBe(false);
    expect(document.activeElement).toBe(figmaInput());
  });

  it("ends a hold with a lease once the lease runs out, for a holder that never comes back", () => {
    overlay.hold(30_000);
    vi.advanceTimersByTime(29_999);
    expect(host()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(host()).toBeNull();
  });

  it("stops on the Stop button and on Esc, ignores every other key, and forgets the stop once unlocked", () => {
    const release = overlay.hold();
    vi.advanceTimersByTime(CARD_DELAY_MS);
    for (const key of ["Enter", " ", "a", "Tab"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true });
      stopButton().dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(overlay.stopRequested).toBe(false);
    stopButton().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
    expect(overlay.stopRequested).toBe(true);
    expect(statusText()).toBe("Stopping and putting back what Figloo changed");
    release();
    expect(overlay.stopRequested).toBe(false);

    overlay.hold();
    vi.advanceTimersByTime(CARD_DELAY_MS);
    expect(stopButton().disabled).toBe(false);
    stopButton().click();
    expect(overlay.stopRequested).toBe(true);
  });

  it("keeps clicks, scrolling, and keys on it from reaching Figma, and says which events were its own", () => {
    const reached: string[] = [];
    for (const type of ["pointerdown", "click", "wheel", "keydown"]) document.addEventListener(type, () => reached.push(type));
    overlay.hold();
    vi.advanceTimersByTime(CARD_DELAY_MS);
    const events = [new PointerEvent("pointerdown", { bubbles: true, composed: true }), new MouseEvent("click", { bubbles: true, composed: true }), new WheelEvent("wheel", { bubbles: true, composed: true, cancelable: true })];
    for (const event of events) backdrop().dispatchEvent(event);
    stopButton().dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, composed: true }));
    expect(reached).toEqual([]);
    expect(events.every((event) => overlay.owns(event))).toBe(true);

    const elsewhere = new PointerEvent("pointerdown", { bubbles: true, composed: true });
    document.body.dispatchEvent(elsewhere);
    expect(reached).toEqual(["pointerdown"]);
    expect(overlay.owns(elsewhere)).toBe(false);
  });

  it("keeps the user's keys from Figma wherever the focus is, but lets Figloo's own keys through", () => {
    const reached: string[] = [];
    figmaInput().addEventListener("keydown", (event) => reached.push(event.key));
    // Not locked: the user's keys reach Figma.
    figmaInput().dispatchEvent(press("1"));
    expect(reached).toEqual(["1"]);

    overlay.hold();
    // Figloo moves the focus to Figma when it presses keys, so the user's keys land there.
    figmaInput().focus();
    const key = press("2");
    figmaInput().dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(overlay.visible).toBe(true);
    // Figloo's own keys, such as Shift+2 to zoom, are not trusted and go through.
    figmaInput().dispatchEvent(new KeyboardEvent("keydown", { key: "@", bubbles: true, composed: true, cancelable: true }));
    expect(reached).toEqual(["1", "@"]);
    figmaInput().dispatchEvent(press("Escape"));
    expect(overlay.stopRequested).toBe(true);
    expect(reached).toEqual(["1", "@"]);
  });

  it("keeps the user's keys on the Stop button from Figma's capture listeners too, where an Esc would clear the selection", () => {
    const seen: string[] = [];
    // Figma can listen for keys on the way down to whatever has the focus.
    document.addEventListener("keydown", (event) => seen.push(event.key), { capture: true });
    overlay.hold();
    vi.advanceTimersByTime(CARD_DELAY_MS);
    expect(overlay.root.activeElement).toBe(stopButton());
    for (const key of ["ArrowLeft", "!", "Escape"]) stopButton().dispatchEvent(press(key));
    expect(seen).toEqual([]);
    expect(overlay.stopRequested).toBe(true);
  });

  it("turns invisible for a screenshot but still keeps input from Figma, and shows again afterwards", async () => {
    const reached: string[] = [];
    document.addEventListener("pointerdown", () => reached.push("pointerdown"));
    overlay.hold();
    vi.advanceTimersByTime(CARD_DELAY_MS);
    const concealing = overlay.conceal();
    await vi.advanceTimersByTimeAsync(200);
    await concealing;
    expect(host()?.style.opacity).toBe("0");
    expect(overlay.visible).toBe(false);
    backdrop().dispatchEvent(trusted(new PointerEvent("pointerdown", { bubbles: true, composed: true })));
    expect(reached).toEqual([]);
    // A click during the screenshot does not bring the card into it.
    expect(host()?.style.opacity).toBe("0");
    overlay.reveal();
    expect(host()?.style.opacity).toBe("1");
  });

  it("unlocks and stops keeping keys from Figma once disposed, for a content script that is replaced", () => {
    overlay.hold();
    overlay.dispose();
    expect(host()).toBeNull();
    const key = press("2");
    figmaInput().dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
  });
});

describe("reading progress", () => {
  it("counts layers while walking, then layers read with the time left", () => {
    expect(progressText({ phase: "walking", found: 42 })).toBe("Finding layers: 42 so far");
    expect(progressText({ phase: "reading", done: 0, total: 278, remainingMs: null })).toBe("Read 0 of 278 layers");
    expect(progressText({ phase: "reading", done: 120, total: 278, remainingMs: 45_000 })).toBe("Read 120 of 278 layers, about 45 s left");
    expect(progressText({ phase: "reading", done: 20, total: 278, remainingMs: 90_000 })).toBe("Read 20 of 278 layers, about 1 min 30 s left");
    expect(progressText({ phase: "reading", done: 277, total: 278, remainingMs: 0 })).toBe("Read 277 of 278 layers, almost done");
    expect(progressText({ phase: "finishing" })).toBe("Putting the layers panel back");
  });

  it("says a short operation takes a few seconds, and counts the frames a thumbnail call captured", () => {
    expect(progressText({ phase: "working" })).toBe("Working, this takes a few seconds");
    expect(progressText({ phase: "capturing", done: 3, total: 12 })).toBe("Captured 3 of 12 frames");
  });

  it("estimates the time left from the last 20 layers, rounded to 5 seconds", () => {
    expect(estimateRemainingMs([], 100)).toBeNull();
    // 30 slow layers at the start no longer count once 20 faster ones follow.
    const durations = [...Array(30).fill(1_000), ...Array(20).fill(100)];
    expect(estimateRemainingMs(durations, 120)).toBe(10_000);
    expect(estimateRemainingMs([130], 100)).toBe(15_000);
  });
});
