// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { hideToasts, toastShowing } from "../src/adapter/capture-ops.js";

/** Figma's toast as seen on 2026-10-12: the message inside a root that holds the dark box. */
function toast(text: string) {
  document.head.innerHTML = "";
  document.body.innerHTML = `<div data-testid="visual-bell-root" role="presentation"><div role="group"><span><div data-testid="visual-bell-message" role="alert">${text}</div></span></div></div>`;
}

describe("Figma's toasts during a capture", () => {
  it("counts a toast with text as on screen, so the capture waits for it", () => {
    toast("Zoom to selection");
    expect(toastShowing(document)).toBe(true);
  });

  it("does not wait for a toast it hid, and shows toasts again afterwards", () => {
    toast("Zoom to selection");
    const showToasts = hideToasts(document);
    expect(toastShowing(document)).toBe(false);
    showToasts();
    expect(toastShowing(document)).toBe(true);
  });

  it("still waits for a toast outside the root it knows, in case Figma changes it", () => {
    document.body.innerHTML = `<div data-testid="visual-bell-message" role="alert">Zoom to selection</div>`;
    hideToasts(document);
    expect(toastShowing(document)).toBe(true);
  });

  it("does not wait once the toast has no text", () => {
    toast("");
    expect(toastShowing(document)).toBe(false);
  });
});
