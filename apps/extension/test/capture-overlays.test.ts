// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { hideOverlays, toastShowing } from "../src/adapter/capture-ops.js";

/** Figma's toast as seen on 2026-10-12: the message inside a root that holds the dark box. */
function toast(text: string) {
  document.head.innerHTML = "";
  document.body.innerHTML = `<div data-testid="visual-bell-root" role="presentation"><div role="group"><span><div data-testid="visual-bell-message" role="alert">${text}</div></span></div></div>`;
}

/** What Figma drew over the canvas of a view-only file on 2026-11-24, reduced to the attributes Figloo relies on. */
function overCanvas() {
  document.head.innerHTML = "";
  document.body.innerHTML = [
    `<div class="view container-view"><canvas></canvas></div>`,
    `<div><div data-testid="multiplayer-cursor-2563"><div class="multiplayer_cursors--nameContainer--GARRM">Anonymous</div></div></div>`,
    `<div data-testid="positioned-design-toolbelt" class="positioned_design_toolbelt--root--kfNki"><div>You can only view and comment on this file.</div><div role="toolbar" aria-label="Editor"></div></div>`,
    `<div class="comments_view--outerAnchorContainer--rIEo2 comments_view--_container--0M5kB"><div class="pin"></div></div>`,
  ].join("");
}

const visibility = (selector: string) => getComputedStyle(document.querySelector(selector)!).visibility;

describe("Figma's toasts during a capture", () => {
  it("counts a toast with text as on screen, so the capture waits for it", () => {
    toast("Zoom to selection");
    expect(toastShowing(document)).toBe(true);
  });

  it("does not wait for a toast it hid, and shows toasts again afterwards", () => {
    toast("Zoom to selection");
    const showOverlays = hideOverlays(document);
    expect(toastShowing(document)).toBe(false);
    showOverlays();
    expect(toastShowing(document)).toBe(true);
  });

  it("still waits for a toast outside the root it knows, in case Figma changes it", () => {
    document.body.innerHTML = `<div data-testid="visual-bell-message" role="alert">Zoom to selection</div>`;
    hideOverlays(document);
    expect(toastShowing(document)).toBe(true);
  });

  it("does not wait once the toast has no text", () => {
    toast("");
    expect(toastShowing(document)).toBe(false);
  });
});

describe("what Figma draws over the canvas during a capture", () => {
  it("hides other people's cursors, the toolbar with the view-only banner, and comment pins, but not the canvas", () => {
    overCanvas();
    const showOverlays = hideOverlays(document);
    expect(visibility('[data-testid="multiplayer-cursor-2563"]')).toBe("hidden");
    expect(visibility(".multiplayer_cursors--nameContainer--GARRM")).toBe("hidden");
    expect(visibility('[data-testid="positioned-design-toolbelt"]')).toBe("hidden");
    expect(visibility(".pin")).toBe("hidden");
    expect(visibility("canvas")).not.toBe("hidden");
    showOverlays();
    expect(visibility('[data-testid="multiplayer-cursor-2563"]')).not.toBe("hidden");
    expect(visibility('[data-testid="positioned-design-toolbelt"]')).not.toBe("hidden");
    expect(visibility(".pin")).not.toBe("hidden");
  });
});
