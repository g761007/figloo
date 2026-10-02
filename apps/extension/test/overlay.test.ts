// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadingOverlay, estimateRemainingMs, progressText } from "../src/adapter/overlay.js";

let overlay: ReadingOverlay;
beforeEach(() => {
  document.body.innerHTML = '<input id="figma-focus" />';
  document.querySelector<HTMLInputElement>("#figma-focus")!.focus();
  overlay = new ReadingOverlay(document);
});
afterEach(() => overlay.remove());

const host = () => document.querySelector("figloo-reading-overlay");
const stopButton = () => overlay.root.querySelector("button")!;
const statusText = () => overlay.root.querySelector('[aria-live="polite"]')?.textContent;

describe("the reading overlay", () => {
  it("covers the page from a closed shadow root and moves focus to Stop", () => {
    overlay.show();
    expect(host()?.parentElement).toBe(document.documentElement);
    expect(host()?.shadowRoot).toBeNull();
    expect(overlay.root.querySelector('[role="alertdialog"]')?.textContent).toContain("Figloo is reading this page for your coding agent");
    expect(statusText()).toBe("Finding layers: 0 so far");
    expect(overlay.root.activeElement).toBe(stopButton());
  });

  it("goes away and gives focus back to what had it", () => {
    overlay.show();
    overlay.remove();
    expect(host()).toBeNull();
    expect(document.activeElement?.id).toBe("figma-focus");
  });

  it("stops on the Stop button and on Esc, and ignores every other key", () => {
    overlay.show();
    for (const key of ["Enter", " ", "a", "Tab"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true });
      stopButton().dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(overlay.stopRequested).toBe(false);
    stopButton().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
    expect(overlay.stopRequested).toBe(true);
    expect(statusText()).toBe("Stopping and putting the layers panel back");

    const clicked = new ReadingOverlay(document);
    clicked.show();
    clicked.root.querySelector("button")!.click();
    expect(clicked.stopRequested).toBe(true);
    clicked.remove();
  });

  it("keeps clicks, scrolling, and keys on it from reaching Figma, and says which events were its own", () => {
    const reached: string[] = [];
    for (const type of ["pointerdown", "click", "wheel", "keydown"]) document.addEventListener(type, () => reached.push(type));
    overlay.show();
    const backdrop = overlay.root.firstElementChild!;
    const events = [new PointerEvent("pointerdown", { bubbles: true, composed: true }), new MouseEvent("click", { bubbles: true, composed: true }), new WheelEvent("wheel", { bubbles: true, composed: true, cancelable: true })];
    for (const event of events) backdrop.dispatchEvent(event);
    stopButton().dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, composed: true }));
    expect(reached).toEqual([]);
    expect(events.every((event) => overlay.owns(event))).toBe(true);

    const elsewhere = new PointerEvent("pointerdown", { bubbles: true, composed: true });
    document.body.dispatchEvent(elsewhere);
    expect(reached).toEqual(["pointerdown"]);
    expect(overlay.owns(elsewhere)).toBe(false);
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

  it("estimates the time left from the last 20 layers, rounded to 5 seconds", () => {
    expect(estimateRemainingMs([], 100)).toBeNull();
    // 30 slow layers at the start no longer count once 20 faster ones follow.
    const durations = [...Array(30).fill(1_000), ...Array(20).fill(100)];
    expect(estimateRemainingMs(durations, 120)).toBe(10_000);
    expect(estimateRemainingMs([130], 100)).toBe(15_000);
  });
});
