// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StopExploration } from "../src/adapter/tree.js";
import { BackgroundPause } from "../src/adapter/visibility.js";

let hidden = false;
function setHidden(value: boolean): void {
  hidden = value;
  document.dispatchEvent(new Event("visibilitychange"));
}
beforeEach(() => {
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});
afterEach(() => {
  delete (document as unknown as { hidden?: boolean }).hidden;
});

describe("pausing a read while the tab is in the background", () => {
  it("goes on at once while the tab is on screen", async () => {
    const pause = new BackgroundPause(document, Date.now() + 1_000);
    await expect(pause.untilVisible()).resolves.toBeUndefined();
    pause.dispose();
  });

  it("waits for the tab to come back and says when it pauses and resumes", async () => {
    const states: boolean[] = [];
    const pause = new BackgroundPause(document, Date.now() + 5_000, (paused) => states.push(paused));
    setHidden(true);
    let resumed = false;
    const waiting = pause.untilVisible().then(() => (resumed = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(resumed).toBe(false);
    expect(states).toEqual([true]);
    setHidden(false);
    await waiting;
    expect(states).toEqual([true, false]);
    pause.dispose();
  });

  it("stops the read on its time budget when the deadline passes in the background", async () => {
    const pause = new BackgroundPause(document, Date.now() + 50);
    setHidden(true);
    await expect(pause.untilVisible()).rejects.toEqual(new StopExploration("time_budget"));
    pause.dispose();
  });

  it("notices a step the tab went to the background during, even once it is back", () => {
    const pause = new BackgroundPause(document, Date.now() + 1_000);
    const mark = pause.mark();
    expect(pause.hidSince(mark)).toBe(false);
    setHidden(true);
    setHidden(false);
    expect(pause.hidSince(mark)).toBe(true);
    expect(pause.hidSince(pause.mark())).toBe(false);
    pause.dispose();
  });
});
