import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/popup-model.js";
import { cardSelection, layer, snapshot } from "./popup-fixtures.js";

describe("the prompt the popup copies", () => {
  it("tells the agent which layer the user means and how to find it with Figloo", () => {
    const text = buildPrompt(snapshot({ selection: cardSelection(), selectionError: null }))!;
    expect(text).toContain("File: Sample app (tab 42)");
    expect(text).toContain("Page: Checkout");
    expect(text).toContain("Layer: Order card (Frame), ref 2:5");
    expect(text).toContain("Path: Checkout > Checkout screen > Order list > Order card");
    expect(text).toContain("Link: https://www.figma.com/design/abc123/Sample-app?node-id=2-5");
    expect(text).toContain("Call get_anchor with tabId 42 first; it should return ref 2:5.");
  });

  it("names the first ten children and counts the rest", () => {
    const text = buildPrompt(snapshot({ selection: cardSelection(), selectionError: null }))!;
    const children = text.split("\n").find((line) => line.startsWith("Children: "))!;
    expect(children).toContain("Item 1 (Text), Item 2 (Instance)");
    expect(children).toContain("Item 10 (Instance), and 2 more");
    expect(children).not.toContain("Item 11");
  });

  it("leaves out the link for layers inside an instance, whose IDs do not last", () => {
    const selection = { ...cardSelection()!, anchor: layer("I2:9;4:1", "Label", "Text", { insideInstance: true }) };
    const text = buildPrompt(snapshot({ selection, selectionError: null }))!;
    expect(text).toContain("Layer: Label (Text), ref I2:9;4:1");
    expect(text).not.toContain("Link:");
  });

  it("lets the agent explore the file when nothing is selected", () => {
    const text = buildPrompt(snapshot())!;
    expect(text).toContain("explore the Figma file open in my browser");
    expect(text).toContain("Call list_pages and explore_page with tabId 42");
    expect(text).not.toContain("Layer:");
  });

  it("offers nothing to copy for a tab without a design file", () => {
    expect(buildPrompt(snapshot({ tab: null }))).toBeNull();
  });
});
