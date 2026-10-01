import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/popup-model.js";
import { cardSelection, layer, severalSelected, snapshot } from "./popup-fixtures.js";

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
    const label = layer("I2:9;4:1", "Label", "Text", { insideInstance: true });
    const selection = { ...cardSelection(), anchor: label, anchors: [label] };
    const text = buildPrompt(snapshot({ selection, selectionError: null }))!;
    expect(text).toContain("Layer: Label (Text), ref I2:9;4:1");
    expect(text).not.toContain("Link:");
  });

  it("lists every selected layer with its ref, so same-named ones stay apart", () => {
    const text = buildPrompt(snapshot({ selection: severalSelected(), selectionError: null }))!;
    expect(text).toContain("work on the 3 Figma layers I selected");
    expect(text).toContain("- Order card (Frame), ref 2:5\n- Order card (Frame), ref 2:6\n- Total (Text), ref 7:1");
    expect(text).toContain("4 layers are selected; these are the ones Figloo found");
    expect(text).toContain("its anchors should be 2:5, 2:6, 7:1");
    expect(text).not.toContain("Path:");
  });

  it("asks for a snapshot when the selection is a frame on the canvas or in a section", () => {
    const screen = layer("2:1", "Checkout screen", "Frame", { depth: 0, hasChildren: true });
    const inSection = layer("2:2", "Profile screen", "Auto layout", { depth: 1, hasChildren: true });
    for (const selection of [
      { ...cardSelection(), anchor: screen, anchors: [screen], ancestors: [] },
      { ...cardSelection(), anchor: inSection, anchors: [inSection], ancestors: [layer("9:1", "Flows", "Section", { depth: 0 })] },
    ]) {
      const text = buildPrompt(snapshot({ selection, selectionError: null }))!;
      expect(text).toMatch(/^I want to implement the Figma page I selected/);
      expect(text).toContain(`it should return ref ${selection.anchor.ref}. If it returns another layer, ask me to select this one again. Then call snapshot_layer on it`);
      expect(text).toContain("query_snapshot");
    }
  });

  it("keeps the layer prompt for a card inside a screen, an instance, or a frame whose path is unknown", () => {
    const instance = layer("3:1", "Header", "Instance", { depth: 0 });
    const lost = layer("4:1", "Card", "Frame", { depth: 3 });
    for (const selection of [cardSelection(), { ...cardSelection(), anchor: instance, anchors: [instance], ancestors: [] }, { ...cardSelection(), anchor: lost, anchors: [lost], ancestors: [] }]) {
      const text = buildPrompt(snapshot({ selection, selectionError: null }))!;
      expect(text).toMatch(/^Use the Figloo MCP tools to work on the Figma layer I selected/);
      expect(text).not.toContain("snapshot_layer");
    }
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
