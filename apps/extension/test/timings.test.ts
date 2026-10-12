// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { DomRowSource } from "../src/adapter/dom-source.js";
import { ExplorerCore } from "../src/adapter/explorer-core.js";
import { inspectionSignature } from "../src/adapter/inspect.js";
import type { Row } from "../src/adapter/row.js";
import { Timings } from "../src/timings.js";

/** A right sidebar whose inspection panel shows `header` above one section. */
function panel(header: string, section: string) {
  document.body.innerHTML = `<div role="region" aria-label="Right sidebar"><div><div id="header">${header}</div><div data-testid="layout-inspection-panel" id="section">${section}</div></div></div>`;
  const core = new ExplorerCore("page-1", document, window);
  const set = (id: string, text: string) => setTimeout(() => (document.getElementById(id)!.textContent = text), 30);
  return { core, source: new DomRowSource(document), previous: inspectionSignature(document), set };
}

const layer = (name: string) => ({ id: "1:2", name }) as Row;

describe("how the panel wait knew it shows the layer, which the benchmark counts", () => {
  it("answers at once when the header names the layer and the content changed", async () => {
    const { core, source, previous, set } = panel("Title", "W 100");
    set("header", "Subtitle");
    set("section", "W 200");
    const started = Date.now();
    expect(await core.waitForPanel(layer("Subtitle"), previous, source)).toBe("named");
    expect(Date.now() - started).toBeLessThan(300);
  });

  it("waits out 400 ms for a layer that looks like the previous one", async () => {
    const { core, source, previous } = panel("Card", "W 100");
    const started = Date.now();
    expect(await core.waitForPanel(layer("Card"), previous, source)).toBe("unchanged");
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });

  it("waits out 500 ms when the header shows something else, such as an image's file name", async () => {
    const { core, source, previous, set } = panel("photo.png", "W 100");
    set("section", "W 200");
    const started = Date.now();
    expect(await core.waitForPanel(layer("Hero"), previous, source)).toBe("unnamed");
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  });
});

describe("Timings", () => {
  it("adds up phases and counts across the tab's and the worker's parts, rounded to milliseconds", () => {
    const tab = new Timings();
    tab.add("layer.select", 10.4);
    tab.add("layer.select", 10.4);
    tab.count("mirror.timeout");
    const worker = new Timings();
    worker.add("capture.screen", 99.6);
    worker.count("mirror.timeout");
    worker.merge(tab.toJSON());
    expect(worker.toJSON()).toEqual({ ms: { "capture.screen": 100, "layer.select": 21 }, counts: { "mirror.timeout": 2 } });
  });
});
