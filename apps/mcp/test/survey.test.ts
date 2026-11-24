import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { GetAnchorOutputSchema, SurveyOutputSchema, SurveyThumbnailsOutputSchema, type LayerNode, type RequestMessage, type SurveyResult, type SurveyRoot, type SurveyThumbnailsResult } from "@figloo/protocol";
import type { Bridge } from "../src/bridge.js";
import { MAX_OUTPUT_BYTES } from "../src/exploration.js";
import { createServer } from "../src/server.js";
import { SnapshotStore } from "../src/snapshots.js";
import { SurveyStore, parseSurveyId, surveyId } from "../src/surveys.js";
import { pairFakeExtension, startBridge } from "./helpers.js";

const identity = { pageId: "page-1", fileKey: "abc", page: "Secret page name" };
const HOUR = 3_600_000;

const frame = (ref: string, name: string, layers = 3): SurveyRoot => ({
  ref,
  name,
  type: "Frame",
  sectionRef: null,
  hidden: false,
  size: { width: 393, height: 852 },
  complete: true,
  layers: Array.from({ length: layers }, (_, i) => ({ ref: `${ref}${i}`, parentRef: ref, name: i === 0 ? "Status Bar" : `Text ${i}`, type: i === 0 ? "Instance" : "Text", hidden: false })),
});

const frames = [frame("1:1", "Likes – Fans"), frame("1:2", "Likes – Following"), frame("1:3", "Messages")];

function result(roots: SurveyRoot[], status: "complete" | "partial", scope = frames): SurveyResult {
  return { identity, status, scope: scope.map((root) => ({ ref: root.ref, sectionRef: null })), sections: [], roots, userSelectionRestored: true, uiOps: 12, elapsedMs: 2_000 };
}

const anchorNode: LayerNode = { ref: "1:1", name: "Likes – Fans", nameTruncated: false, type: "Frame", depth: 0, position: 1, siblingCount: 3, parentRef: null, hasChildren: true, childCount: null, insideInstance: false, link: null };

const bridges: Bridge[] = [];
const clients: Client[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(answer: (request: RequestMessage, calls: number) => unknown) {
  const dir = mkdtempSync(join(tmpdir(), "figloo-surveys-"));
  dirs.push(dir);
  const clock = { now: Date.parse("2026-11-24T09:00:00Z") };
  const surveys = new SurveyStore(join(dir, "surveys"), 24 * HOUR, () => clock.now);
  const bridge = await startBridge();
  bridges.push(bridge);
  const ext = await pairFakeExtension(bridge.port);
  const requests: RequestMessage[] = [];
  ext.ws.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { type: string };
    if (message.type !== "request") return;
    const request = message as RequestMessage;
    requests.push(request);
    const reply =
      request.op === "get_anchor"
        ? { identity, selectionCount: 1, anchor: anchorNode, anchors: [anchorNode], uiOps: 1, elapsedMs: 5 }
        : answer(request, requests.filter((r) => r.op === "survey_frames").length);
    ext.send({ type: "response", id: request.id, ok: true, result: reply } as never);
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ bridge, version: "test", log: () => {}, snapshots: new SnapshotStore(join(dir, "snapshots")), surveys }).connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  clients.push(client);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const contextId = GetAnchorOutputSchema.parse((await call("get_anchor", { tabId: 7 })).structuredContent).contextId;
  const survey = async (args: Record<string, unknown> = {}) => {
    const reply = await call("survey_frames", { contextId, ...args });
    return { output: reply.isError ? null : SurveyOutputSchema.parse(reply.structuredContent), reply };
  };
  const surveyRequests = () => requests.filter((request) => request.op === "survey_frames");
  const thumbnails = async (args: Record<string, unknown>) => {
    const reply = await call("survey_thumbnails", { contextId, ...args });
    return { output: reply.isError ? null : SurveyThumbnailsOutputSchema.parse(reply.structuredContent), reply };
  };
  const thumbnailRequests = () => requests.filter((request) => request.op === "survey_thumbnails");
  return { dir: join(dir, "surveys"), clock, call, contextId, survey, surveyRequests, thumbnails, thumbnailRequests };
}

describe("survey_frames", () => {
  it("goes on where a call that ran out of time stopped, then answers from the saved survey", async () => {
    const { survey, surveyRequests } = await setup((_request, n) => (n === 1 ? result(frames.slice(0, 1), "partial") : result(frames.slice(1), "complete")));

    const first = (await survey()).output!;
    expect(first).toMatchObject({ complete: false, overview: "", progress: { surveyed: 1, total: 3 }, fromCache: false });
    expect(surveyRequests()[0]!.params).toMatchObject({ refs: null, done: [] });

    const second = (await survey()).output!;
    expect(second).toMatchObject({ complete: true, progress: { surveyed: 3, total: 3 }, counts: { frames: 3, notes: 0, sections: 0, other: 0, layers: 9 }, fromCache: false, truncated: false });
    expect(surveyRequests()[1]!.params).toMatchObject({ done: ["1:1"] });
    expect(second.overview).toContain('"Likes" (2): #1 #2');
    expect(second.overview).toContain("#3 1:3 Frame \"Messages\"");

    const third = (await survey()).output!;
    expect(third).toMatchObject({ complete: true, fromCache: true, overview: second.overview });
    expect(surveyRequests()).toHaveLength(2);
  });

  it("keeps the panel's order and drops frames removed from the page between calls", async () => {
    const { survey } = await setup((_request, n) =>
      n === 1 ? result([frames[2]!], "partial", [frames[2]!, frames[0]!]) : result([frames[0]!], "complete", [frames[0]!, frames[1]!]),
    );
    await survey();
    const done = (await survey()).output!;
    // 1:3 went away in between, and 1:2 was not surveyed by this scope's calls.
    expect(done.progress).toEqual({ surveyed: 1, total: 2 });
    expect(done.overview).toContain("#1 1:1 ");
    expect(done.overview).not.toContain("1:3");
  });

  it("reads Figma again on refresh and once the survey expired", async () => {
    const { survey, surveyRequests, clock } = await setup(() => result(frames, "complete"));
    await survey();
    await survey({ refresh: true });
    expect(surveyRequests()).toHaveLength(2);
    clock.now += 25 * HOUR;
    expect((await survey()).output!.fromCache).toBe(false);
    expect(surveyRequests()).toHaveLength(3);
  });

  it("surveys only refs the context returned, and every ref of a survey works afterwards", async () => {
    const { survey, surveyRequests } = await setup((request) => {
      const refs = (request.params as { refs: string[] | null }).refs;
      return result(refs === null ? frames : frames.filter((root) => refs.includes(root.ref)), "complete", refs === null ? frames : frames.filter((root) => refs.includes(root.ref)));
    });
    const unknown = (await survey({ refs: ["1:2"] })).reply;
    expect(unknown.isError).toBe(true);
    expect(JSON.parse((unknown.content as { text: string }[])[0]!.text).error.code).toBe("UNKNOWN_REF");
    expect(surveyRequests()).toHaveLength(0);

    await survey();
    // 1:2 and the layers inside it came from the survey of the page.
    const some = (await survey({ refs: ["1:2", "1:20"] })).output!;
    expect(some.complete).toBe(true);
    expect(surveyRequests()[1]!.params).toMatchObject({ refs: ["1:2", "1:20"] });
  });

  it("saves surveys where only the user can read them, named without the page's name", async () => {
    const { survey, dir } = await setup(() => result(frames, "complete"));
    const { output } = await survey();
    expect(output!.survey).toBe(surveyId("abc", "Secret page name", null));
    expect(parseSurveyId(output!.survey)).not.toBeNull();
    const names = readdirSync(join(dir, "abc"));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^page-[0-9a-f]{16}\.json$/);
    expect(statSync(join(dir, "abc")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "abc", names[0]!)).mode & 0o777).toBe(0o600);
  });

  it("names the same survey for the same refs in any order, and another for other refs or another page", () => {
    expect(surveyId("abc", "App", ["1:2", "1:1"])).toBe(surveyId("abc", "App", ["1:1", "1:2", "1:1"]));
    expect(surveyId("abc", "App", ["1:1"])).not.toBe(surveyId("abc", "App", ["1:2"]));
    expect(surveyId("abc", "App", null)).not.toBe(surveyId("abc", "Other", null));
    expect(() => surveyId("../x", "App", null)).toThrow();
  });

  it("fits the overview of a large page into one result, saying it was cut", async () => {
    const many = Array.from({ length: 300 }, (_, i) => frame(`2:${i}`, `Flow ${i % 7} – Screen number ${i} with a long descriptive name`, 40));
    const { survey } = await setup(() => result(many, "complete", many));
    const { output, reply } = await survey();
    expect(output!.truncated).toBe(true);
    expect(Buffer.byteLength((reply.content as { text: string }[])[0]!.text)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(output!.overview).toContain("## Frames\n#1 2:0 ");
  });
});

describe("survey_thumbnails", () => {
  const sheet = (numbers: number[]) => ({ image: { data: Buffer.from("jpeg").toString("base64"), mimeType: "image/jpeg" as const, width: 1568, height: 788 }, frames: numbers });
  const note: SurveyRoot = { ref: "1:9", name: "Primary color for buttons", type: "Text", sectionRef: null, hidden: false, size: null, complete: true, layers: [] };
  const withNote = [frames[0]!, note, frames[1]!, frames[2]!];

  function answer(thumbnails: (request: RequestMessage) => SurveyThumbnailsResult) {
    return (request: RequestMessage) => (request.op === "survey_thumbnails" ? thumbnails(request) : result(withNote, "complete", withNote));
  }

  it("captures frames by their numbers in the overview, notes left out, and hands the sheets over as images", async () => {
    const { survey, thumbnails, thumbnailRequests } = await setup(
      answer(() => ({ identity, sheets: [sheet([1, 2, 3])], captured: [1, 2, 3], failed: [], stoppedBy: null, userSelectionRestored: true, viewRestored: true, elapsedMs: 6_000 })),
    );
    const id = (await survey()).output!.survey;
    const { output, reply } = await thumbnails({ survey: id });
    expect(thumbnailRequests()[0]!.params).toMatchObject({ frames: [{ ref: "1:1", n: 1 }, { ref: "1:2", n: 2 }, { ref: "1:3", n: 3 }] });
    expect(output).toMatchObject({ captured: [1, 2, 3], remaining: [], sheets: [{ frames: [1, 2, 3], width: 1568, height: 788 }], viewRestored: true });
    expect((reply.content as { type: string }[]).map((part) => part.type)).toEqual(["text", "image"]);
  });

  it("says which frames are left when a call stopped early, and which failed", async () => {
    const { survey, thumbnails, thumbnailRequests } = await setup(
      answer(() => ({
        identity,
        sheets: [sheet([3])],
        captured: [3],
        failed: [{ n: 1, code: "NODE_NOT_FOUND", message: "layer 1:1 is no longer in the layers panel" }],
        stoppedBy: { code: "TAB_IN_BACKGROUND", message: "the Figma tab went to the background" },
        userSelectionRestored: true,
        viewRestored: false,
        elapsedMs: 4_000,
      })),
    );
    const id = (await survey()).output!.survey;
    const { output } = await thumbnails({ survey: id, frames: [3, 1, 2] });
    expect(thumbnailRequests()[0]!.params).toMatchObject({ frames: [{ ref: "1:3", n: 3 }, { ref: "1:1", n: 1 }, { ref: "1:2", n: 2 }] });
    expect(output).toMatchObject({ captured: [3], remaining: [2], failed: [{ n: 1, code: "NODE_NOT_FOUND" }], stoppedBy: { code: "TAB_IN_BACKGROUND" } });
  });

  it("refuses an unknown survey, one still in progress, and frame numbers the survey does not have, before touching Figma", async () => {
    const { survey, thumbnails, thumbnailRequests } = await setup((request, n) =>
      request.op === "survey_frames" && n === 1 ? result(frames.slice(0, 1), "partial") : result(frames, "complete"),
    );
    const codeOf = (reply: { content: unknown }) => JSON.parse((reply.content as { text: string }[])[0]!.text).error.code;
    expect(codeOf((await thumbnails({ survey: "abc/page-0123456789abcdef" })).reply)).toBe("SURVEY_NOT_FOUND");
    const id = (await survey()).output!.survey;
    expect(codeOf((await thumbnails({ survey: id })).reply)).toBe("SURVEY_INCOMPLETE");
    await survey();
    expect(codeOf((await thumbnails({ survey: id, frames: [4] })).reply)).toBe("INVALID_ARGUMENT");
    expect(thumbnailRequests()).toHaveLength(0);
  });
});
