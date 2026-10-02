// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { renderDiagnostics, renderPopup } from "../src/popup-view.js";
import { cardSelection, figmaTab, layer, severalSelected, snapshot } from "./popup-fixtures.js";

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<main id="app"></main>';
  root = document.querySelector("#app")!;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the toolbar popup", () => {
  it("shows the selected layer's path and children", () => {
    renderPopup(root, snapshot({ selection: cardSelection(), selectionError: null }), { copy: async () => true });
    expect([...root.querySelectorAll(".crumb")].map((el) => el.textContent)).toEqual(["Checkout", "Checkout screen", "Order list"]);
    expect(root.querySelector("h2.layer")?.textContent).toBe("Order cardFrame");
    expect(root.querySelectorAll("ul.children li")).toHaveLength(12);
    expect(root.textContent).toContain("Children: 12");
    expect(root.textContent).toContain("Agent: connected");
  });

  it("names the agent session the extension serves", () => {
    const session = { client: "Claude Code", project: "shop", pid: 1, startedAt: new Date(2026, 9, 2, 9, 15).getTime(), serverVersion: "0.2.0" };
    renderPopup(root, snapshot({ connection: { ...snapshot().connection, session } }), { copy: async () => true });
    expect(root.querySelector(".agent")?.textContent).toBe("Agent: Claude Code · shop (started 09:15)");
  });

  it("shows layer names as text, never as markup", () => {
    const named = layer("2:5", '<img src=x onerror="window.hacked=1">', "Frame");
    const selection = { ...cardSelection(), anchor: named, anchors: [named] };
    renderPopup(root, snapshot({ selection, selectionError: null }), { copy: async () => true });
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("h2.layer")?.textContent).toContain("<img src=x");
  });

  it("lists several selected layers and says when some were not found", () => {
    renderPopup(root, snapshot({ selection: severalSelected(), selectionError: null }), { copy: async () => true });
    expect(root.textContent).toContain("4 layers selected; 3 found in the layers panel");
    expect([...root.querySelectorAll("ul.anchors li")].map((li) => li.firstChild?.textContent)).toEqual(["Order card", "Order card", "Total"]);
    expect(root.querySelector(".crumb")).toBeNull();
  });

  it("explains an empty selection and still offers a prompt to explore the file", () => {
    renderPopup(root, snapshot(), { copy: async () => true });
    expect(root.querySelector(".hint")?.textContent).toMatch(/No layer is selected/);
    expect(root.querySelector<HTMLTextAreaElement>("textarea.preview")?.value).toContain("explore the Figma file");
  });

  it("confirms the copy when the clipboard took the prompt", async () => {
    let copied = "";
    renderPopup(root, snapshot(), {
      copy: async (text) => {
        copied = text;
        return true;
      },
    });
    root.querySelector<HTMLButtonElement>("button.copy")!.click();
    await settle();
    expect(copied).toContain("tabId 42");
    expect(root.querySelector("button.copy")?.textContent).toBe("Copied");
  });

  it("selects the prompt for a manual copy when the clipboard refused it", async () => {
    renderPopup(root, snapshot(), { copy: async () => false });
    root.querySelector<HTMLButtonElement>("button.copy")!.click();
    await settle();
    const preview = root.querySelector<HTMLTextAreaElement>("textarea.preview")!;
    expect(document.activeElement).toBe(preview);
    expect(preview.selectionEnd - preview.selectionStart).toBe(preview.value.length);
    expect(root.textContent).toMatch(/press Cmd\+C or Ctrl\+C/);
  });

  it("shows only the status for a tab Figloo cannot read yet", () => {
    renderPopup(root, snapshot({ tab: { ...figmaTab, readiness: "LOADING", detail: "layers panel not found yet" } }), { copy: async () => true });
    expect(root.textContent).toContain("Loading: layers panel not found yet");
    expect(root.querySelector("button.copy")).toBeNull();
  });

  it("asks for a Figma tab when there is none", () => {
    renderPopup(root, snapshot({ tab: null, connection: { ...snapshot().connection, phase: "unpaired", port: null, connectedAt: null, tabCount: 0 } }), { copy: async () => true });
    expect(root.textContent).toContain("This tab has no Figma design file");
    expect(root.textContent).toContain("Agent: not paired");
    expect(root.querySelector("button.copy")).toBeNull();
  });
});

describe("the popup's diagnostics", () => {
  it("shows the text before it is copied, then copies it", async () => {
    const panel = document.createElement("div");
    document.body.append(panel);
    let copied = "";
    renderDiagnostics(panel, "Figloo diagnostics\nExtension: 0.4.0\n", {
      copy: async (text) => {
        copied = text;
        return true;
      },
    });
    expect(panel.querySelector<HTMLTextAreaElement>("textarea.diagnostics-text")!.value).toBe("Figloo diagnostics\nExtension: 0.4.0\n");
    panel.querySelector<HTMLButtonElement>("button.diagnostics-copy")!.click();
    await settle();
    expect(copied).toBe("Figloo diagnostics\nExtension: 0.4.0\n");
    expect(panel.querySelector("button.diagnostics-copy")?.textContent).toBe("Copied");
    // The prompt's own button and preview keep their classes to themselves.
    expect(panel.querySelector("button.copy, textarea.preview")).toBeNull();
  });

  it("selects the text for a manual copy when the clipboard refused it", async () => {
    const panel = document.createElement("div");
    document.body.append(panel);
    renderDiagnostics(panel, "Figloo diagnostics\n", { copy: async () => false });
    panel.querySelector<HTMLButtonElement>("button.diagnostics-copy")!.click();
    await settle();
    const text = panel.querySelector<HTMLTextAreaElement>("textarea.diagnostics-text")!;
    expect(document.activeElement).toBe(text);
    expect(text.selectionEnd - text.selectionStart).toBe(text.value.length);
    expect(panel.textContent).toMatch(/press Cmd\+C or Ctrl\+C/);
  });
});
