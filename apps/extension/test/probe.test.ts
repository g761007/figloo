// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { parseSelectedCount, probeFigmaPage } from "../src/probe.js";

describe("parseSelectedCount", () => {
  it("reads the count Figma puts on the canvas keyboard target", () => {
    expect(parseSelectedCount("Figma Design, 1 item selected")).toBe(1);
    expect(parseSelectedCount("Figma Design, 3 items selected")).toBe(3);
  });

  it("treats the bare label as no selection and anything else as unknown", () => {
    expect(parseSelectedCount("Figma Design")).toBe(0);
    expect(parseSelectedCount("Something else")).toBeNull();
    expect(parseSelectedCount(null)).toBeNull();
  });
});

describe("access from the page", () => {
  const page = (sidebarTabs: string[], toolbar = "") => {
    document.body.innerHTML = `
      <div data-testid="objects-panel"></div>
      <div role="region" aria-label="Right sidebar"><div role="tablist">${sidebarTabs.map((tab, i) => `<button role="tab" aria-selected="${i === 0}">${tab}</button>`).join("")}</div></div>
      ${toolbar}`;
    return probeFigmaPage(document, window).access;
  };

  it("reads edit access from the Design tab of the right sidebar, which view-only sessions do not have", () => {
    expect(page(["Design", "Prototype"])).toBe("edit");
  });

  it("keeps view access and unknown sessions as before", () => {
    expect(page(["Properties"], "<button>View only</button>")).toBe("view");
    expect(page(["Properties"])).toBe("unknown");
  });
});

describe("parts of Figma's page Figloo expects", () => {
  const signedIn = `
    <input class="focus-target" aria-label="Figma Design">
    <span data-testid="filename">File</span>
    <div data-testid="PagesRowWrapper"><button aria-current="page">Page 1</button></div>
    <div data-testid="objects-panel"><div role="row" aria-rowindex="1"><div data-testid="1:2-layers-panel-row"></div></div></div>
    <div role="region" aria-label="Right sidebar"><div data-testid="properties-panel"></div></div>`;

  it("finds every part on a signed-in page, the screen reader mirror being a setting", () => {
    document.body.innerHTML = signedIn;
    expect(probeFigmaPage(document, window).missingAnchors).toEqual([]);
  });

  it("names the parts it cannot find, as after Figma renamed the right sidebar", () => {
    document.body.innerHTML = signedIn.replace('aria-label="Right sidebar"', 'aria-label="Inspector"');
    expect(probeFigmaPage(document, window).missingAnchors).toEqual(["rightSidebar"]);
  });
});

