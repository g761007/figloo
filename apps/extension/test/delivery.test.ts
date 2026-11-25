import { SNAPSHOT_TIME_BUDGET_MS, type TabOpResponse } from "@figloo/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/background/connection.js", () => ({ server: { version: null, protocolVersion: null } }));
vi.mock("../src/capture.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/capture.js")>()),
  cropCapture: async (_dataUrl: string, crop: unknown) => ({ data: "AAAA", width: 100, height: 80, crop }),
  trimToContent: async (_dataUrl: string, crop: unknown) => crop,
}));
vi.mock("../src/contact-sheet.js", () => ({
  ContactSheets: class {
    async add(): Promise<void> {}
    async finish(): Promise<unknown[]> {
      return [];
    }
  },
}));

const { captureTab, exportTab, snapshotTab, surveyThumbnailsTab } = await import("../src/background/delivery.js");

const TAB = 7;
const identity = { pageId: "page-1", fileKey: "AbCdEfGhIjKlMnOpQrStUv", page: "Page 1" };
const rect = { x: 0, y: 0, width: 100, height: 80 };
const plan = (token: string) => ({ identity, token, crop: rect, cropSource: "layer", canvas: rect, viewport: { width: 1200, height: 800 }, zoom: "100%", view: { x: 0, y: 0, zoom: 1 } });
const STOPPED = { code: "USER_INTERRUPTED" as const, message: "the user stopped Figloo with Stop or Esc on its overlay in Figma; what Figloo changed in Figma was put back" };

/** Messages the service worker sent to the tab, in order. */
let sent: { op: string; params: Record<string, unknown> }[];
/** How the tab answers each op; ops without an entry succeed with an empty result. */
let replies: Record<string, (params: Record<string, unknown>, call: number) => TabOpResponse>;
const ops = () => sent.map((message) => message.op);

beforeEach(() => {
  sent = [];
  replies = {};
  const calls = new Map<string, number>();
  vi.stubGlobal("chrome", {
    tabs: {
      get: async () => ({ id: TAB, windowId: 1, active: true }),
      captureVisibleTab: async () => "data:image/png;base64,AAAA",
      sendMessage: async (_tabId: number, message: { op: string; params: Record<string, unknown> }) => {
        sent.push({ op: message.op, params: message.params });
        const call = (calls.get(message.op) ?? 0) + 1;
        calls.set(message.op, call);
        return replies[message.op]?.(message.params, call) ?? { ok: true, result: {} };
      },
    },
    windows: { get: async () => ({ id: 1, state: "normal" }) },
    scripting: { executeScript: async () => [] },
    downloads: { onCreated: { addListener: () => undefined, removeListener: () => undefined }, search: async () => [] },
  });
});

const captured = () => ({ ok: true, result: plan("capture-1") });
const finished = (interrupted = false) => ({ ok: true, result: { userSelectionRestored: !interrupted, viewRestored: false, interrupted } });

describe("Figma locked across the steps of one tool call", () => {
  it("locks a capture from before it moves the view until it has put the view back, and unlocks after a failure too", async () => {
    replies = { prepare_capture: captured, finish_capture: () => finished() };
    await expect(captureTab(TAB, { expect: identity, ref: "1:2" })).resolves.toMatchObject({ ok: true });
    expect(ops()).toEqual(["lock", "prepare_capture", "finish_capture", "unlock"]);
    expect(sent[3]!.params.token).toBe(sent[0]!.params.token);
    expect(sent[0]!.params.leaseMs).toBeGreaterThan(20_000);

    sent = [];
    replies = { prepare_capture: () => ({ ok: false, error: { code: "NODE_NOT_FOUND", message: "gone" } }) };
    await expect(captureTab(TAB, { expect: identity, ref: "1:2" })).resolves.toMatchObject({ ok: false });
    expect(ops()).toEqual(["lock", "prepare_capture", "unlock"]);
  });

  it("locks a snapshot from its screenshot through the read, so the view cannot move in between", async () => {
    replies = { prepare_capture: captured, finish_capture: () => finished(), read_subtree: () => ({ ok: false, error: { code: "BUDGET_EXCEEDED", message: "out of time" } }) };
    await expect(snapshotTab(TAB, { expect: identity, ref: "1:2" })).resolves.toMatchObject({ ok: false });
    expect(ops()).toEqual(["lock", "prepare_capture", "finish_capture", "read_subtree", "unlock"]);
    expect(sent[0]!.params.leaseMs).toBeGreaterThan(SNAPSHOT_TIME_BUDGET_MS);
  });

  it("locks an export until the tab has its files and put the layer back", async () => {
    replies = {
      prepare_export: () => ({ ok: true, result: { identity, name: "Icon", settings: [{ format: "SVG", scale: null }], temporary: true, onlyFormat: null } }),
      finish_export: () => ({ ok: true, result: { files: [{ name: "Icon.svg", mimeType: "image/svg+xml", data: "PHN2Zz4=" }], notes: [], userSelectionRestored: true, stopped: false } }),
    };
    await expect(exportTab(TAB, { expect: identity, ref: "1:2" })).resolves.toMatchObject({ ok: true, result: { source: "direct" } });
    expect(ops()).toEqual(["lock", "prepare_export", "finish_export", "unlock"]);
  });

  it("reports an export the user stopped before any file arrived, without waiting for a download", async () => {
    replies = {
      prepare_export: () => ({ ok: true, result: { identity, name: "Icon", settings: [{ format: "SVG", scale: null }], temporary: true, onlyFormat: null } }),
      finish_export: () => ({ ok: true, result: { files: [], notes: [], userSelectionRestored: true, stopped: true } }),
    };
    const started = Date.now();
    await expect(exportTab(TAB, { expect: identity, ref: "1:2" })).resolves.toMatchObject({ ok: false, error: { code: "USER_INTERRUPTED", message: expect.stringMatching(/stopped Figloo/) } });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(ops()).toEqual(["lock", "prepare_export", "finish_export", "unlock"]);
  });

  it("keeps Figma locked between thumbnails, says how many frames are done, and puts the view back after Stop", async () => {
    replies = {
      prepare_capture: (_params, call) => (call === 1 ? captured() : { ok: false, error: STOPPED }),
      finish_capture: () => finished(),
      put_view_back: () => ({ ok: true, result: { viewRestored: true } }),
    };
    const frames = [1, 2, 3].map((n) => ({ ref: `1:${n}`, n }));
    const reply = await surveyThumbnailsTab(TAB, { expect: identity, frames });
    expect(reply).toMatchObject({ ok: true, result: { captured: [1], stoppedBy: { code: "USER_INTERRUPTED" }, viewRestored: true, userSelectionRestored: true } });
    expect(ops()).toEqual(["lock", "lock_progress", "prepare_capture", "finish_capture", "lock_progress", "prepare_capture", "put_view_back", "unlock"]);
    expect(sent.filter((message) => message.op === "lock_progress").map((message) => message.params.progress)).toEqual([
      { phase: "capturing", done: 0, total: 3 },
      { phase: "capturing", done: 1, total: 3 },
    ]);
  });

  it("leaves the view and selection to a user who used Figma during the thumbnails", async () => {
    replies = { prepare_capture: captured, finish_capture: () => finished(true) };
    const reply = await surveyThumbnailsTab(TAB, { expect: identity, frames: [1, 2].map((n) => ({ ref: `1:${n}`, n })) });
    expect(reply).toMatchObject({ ok: true, result: { captured: [1], stoppedBy: { code: "USER_INTERRUPTED" }, viewRestored: false, userSelectionRestored: false } });
    expect(ops()).toEqual(["lock", "lock_progress", "prepare_capture", "finish_capture", "unlock"]);
  });
});
