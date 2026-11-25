import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  MAX_SURVEY_REFS,
  MAX_THUMBNAIL_FRAMES,
  SURVEY_TIME_BUDGET_MS,
  SurveyOutputSchema,
  SurveyResultSchema,
  SurveyThumbnailsOutputSchema,
  SurveyThumbnailsResultSchema,
  type SurveyOutput,
  type SurveyThumbnailsOutput,
} from "@figloo/protocol";
import { BridgeError, type Bridge } from "./bridge.js";
import { knownParents, type ContextStore, type ExplorationContext } from "./contexts.js";
import type { ToolErrorResult } from "./export-asset.js";
import { fitOverview, numberedFrames, surveyOverview } from "./survey-summary.js";
import { surveyId, type SurveyFile, type SurveyStore } from "./surveys.js";

/** The tab gets 180 s, the rest covers messaging; one long request, no polling. */
const SURVEY_TIMEOUT_MS = SURVEY_TIME_BUDGET_MS + 20_000;
/** For tests on real Figma: a shorter call, so a page takes several calls. */
const testTimeBudgetMs = (() => {
  const ms = Number(process.env.FIGLOO_SURVEY_TIME_BUDGET_MS);
  return Number.isInteger(ms) && ms > 0 && ms < SURVEY_TIME_BUDGET_MS ? ms : null;
})();

class SurveyFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SurveyDeps {
  bridge: Bridge;
  contexts: ContextStore;
  surveys: SurveyStore;
  log: (message: string) => void;
  /** Budget for one tool result. */
  maxOutputBytes: number;
}

/** Every ref of a survey works in the context; parents are kept where the survey knows them, for finding layers again. */
function adoptSurvey(context: ExplorationContext, file: SurveyFile): void {
  const wholePage = file.refs === null;
  for (const section of file.sections) {
    context.knownRefs.add(section.ref);
    if (section.parentRef !== null || wholePage) context.parents.set(section.ref, section.parentRef);
  }
  for (const root of file.roots) {
    context.knownRefs.add(root.ref);
    if (root.sectionRef !== null || wholePage) context.parents.set(root.ref, root.sectionRef);
    for (const layer of root.layers) {
      context.knownRefs.add(layer.ref);
      context.parents.set(layer.ref, layer.parentRef);
    }
  }
}

export function registerSurveyTools(server: McpServer, deps: SurveyDeps, toolError: (error: unknown) => ToolErrorResult): void {
  const { bridge, contexts, surveys, log, maxOutputBytes } = deps;

  server.registerTool(
    "survey_frames",
    {
      description:
        "Survey many frames at once for an overview, before choosing which to snapshot: when a request spans several frames, such as a new app, a new feature, or a redesign. " +
        "Returns text in parts: each frame's ref, name, size, and how many layers, instances, and text layers it holds, the instances it uses most, the start of its text, and how long its snapshot would take; " +
        "frames grouped by the start of their names, which usually names a flow; sections; the notes designers wrote on the canvas, in full; the components used across frames, with names that may mean one component; " +
        "and what is worth a look: layers named like components that are not instances (maybe detached), pasted screenshots, frames whose layer names are mostly auto-named, and hidden frames. " +
        "It reads the layers panel and selects each frame once for its size; it does not read colors, text styles, or spacing: snapshot_layer reads those, for the frames you pick. " +
        "Agree on the scope with the user first. Without refs it surveys every layer directly on the context's page, in sections too; with refs, those frames, a section standing for the frames in it. It never switches Figma pages. " +
        `A page of 70 frames holding 7,600 layers took about 30 s. One call works for at most ${SURVEY_TIME_BUDGET_MS / 60_000} minutes and returns complete: false and no overview when layers are left: call survey_frames again with the same contextId and refs to go on. ` +
        "The survey is saved and comes back without reading Figma until expiresAt; pass refresh: true when the user says the design changed. " +
        "The Figma tab must be on screen to start; Figma shows an overlay with a Stop button meanwhile, and the user's selection is put back. Every ref the survey names works in this context.",
      inputSchema: {
        contextId: z.string(),
        refs: z.array(z.string()).min(1).max(MAX_SURVEY_REFS).optional().describe("Frames or sections returned earlier in this context; omit for every layer on the page"),
        refresh: z.boolean().optional().describe("Read Figma again even when a saved survey has not expired"),
      },
      outputSchema: SurveyOutputSchema,
    },
    async ({ contextId, refs, refresh }) => {
      try {
        const started = Date.now();
        const context = contexts.get(contextId);
        if (!context) throw new SurveyFailure("CONTEXT_NOT_FOUND", `no context ${contextId}`);
        const unknown = (refs ?? []).filter((ref) => !context.knownRefs.has(ref));
        if (unknown.length > 0) throw new SurveyFailure("UNKNOWN_REF", `ref ${unknown.join(", ")} was not returned in context ${contextId}`);
        const id = surveyId(context.identity.fileKey, context.identity.page, refs ?? null);
        if (refresh) await surveys.remove(id);
        let file = await surveys.read(id);
        const fromCache = file?.complete === true;
        let userSelectionRestored = true;
        if (!file?.complete) {
          const earlier = file;
          let result;
          try {
            result = SurveyResultSchema.parse(
              await bridge.request(
                "survey_frames",
                {
                  expect: context.identity,
                  refs: refs ?? null,
                  ...knownParents(context, refs ?? []),
                  done: earlier?.roots.map((root) => root.ref) ?? [],
                  ...(testTimeBudgetMs ? { timeBudgetMs: testTimeBudgetMs } : {}),
                },
                SURVEY_TIMEOUT_MS,
                context.tabId,
              ),
            );
          } catch (error) {
            if (error instanceof BridgeError && error.code === "CONTEXT_EXPIRED") contexts.release(contextId);
            throw error;
          }
          userSelectionRestored = result.userSelectionRestored;
          // Layers surveyed earlier stay when they are still in the scope; the scope's order is the panel's.
          const inScope = new Set(result.scope.map((entry) => entry.ref));
          const byRef = new Map([...(earlier?.roots ?? []).filter((root) => inScope.has(root.ref)), ...result.roots].map((root) => [root.ref, root]));
          const roots = result.scope.flatMap((entry) => byRef.get(entry.ref) ?? []);
          file = await surveys.write(
            {
              id,
              fileKey: context.identity.fileKey,
              page: context.identity.page,
              refs: refs ?? null,
              elapsedMs: (earlier?.elapsedMs ?? 0) + result.elapsedMs,
              complete: result.status === "complete",
              scope: result.scope,
              sections: result.sections,
              roots,
            },
            earlier?.createdAt,
          );
          log(
            `survey_frames ${result.status} surveyed=${result.roots.length} done=${roots.length}/${result.scope.length} uiOps=${result.uiOps} ms=${Math.round(result.elapsedMs)}` +
              (result.timings ? ` timings=${JSON.stringify(result.timings)}` : ""),
          );
        }
        const survey = file;
        adoptSurvey(context, survey);
        const overview = surveyOverview(survey);
        const make = (text: string, truncated: boolean): SurveyOutput => ({
          contextId,
          survey: id,
          fileKey: survey.fileKey,
          page: survey.page,
          createdAt: survey.createdAt,
          expiresAt: survey.expiresAt,
          fromCache,
          complete: survey.complete,
          progress: { surveyed: survey.roots.length, total: survey.scope.length },
          counts: overview.counts,
          overview: text,
          truncated,
          userSelectionRestored,
          elapsedMs: Date.now() - started,
        });
        const { text, truncated } = survey.complete ? fitOverview(overview, (candidate) => Buffer.byteLength(JSON.stringify(make(candidate, true))) <= maxOutputBytes) : { text: "", truncated: false };
        const output = make(text, truncated);
        log(`survey_frames fromCache=${fromCache} complete=${survey.complete} roots=${survey.roots.length} truncated=${truncated} bytes=${Buffer.byteLength(JSON.stringify(output))}`);
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output as unknown as Record<string, unknown> };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "survey_thumbnails",
    {
      description:
        "Contact sheets of the frames of a survey from survey_frames, to see what the screens look like before choosing which to snapshot: 12 frames to an image, each under its #n from the survey's overview. " +
        "Use it when names say too little, for example for frames the overview marks as mostly auto-named, or to compare frames that look alike by name; pass frames to take only those, or omit it for every frame. " +
        "Each frame is captured as capture does, about 2 s a frame, so the Figma tab must stay on screen and Figma's view moves from frame to frame meanwhile; tell the user before. Figma shows an overlay that keeps clicks and keys from it until the call ends, and Stop or Esc on it ends the call early. " +
        "The user's selection is put back after each frame and their zoom and place on the canvas at the end. " +
        `One call works for at most ${SURVEY_TIME_BUDGET_MS / 60_000} minutes; frames it did not get to come back as remaining: pass them as frames to go on. ` +
        "A frame that cannot be captured is listed in failed and the others go on; stoppedBy says what ended a call early, such as the user pressing Stop. " +
        "The sheets are for recognizing screens and layouts; read exact values from a snapshot.",
      inputSchema: {
        contextId: z.string(),
        survey: z.string().describe("The survey id from survey_frames, of the page this context is on"),
        frames: z.array(z.number().int().positive()).min(1).max(MAX_THUMBNAIL_FRAMES).optional().describe("Frame numbers (#n) from the survey's overview; omit for every frame"),
      },
      outputSchema: SurveyThumbnailsOutputSchema,
    },
    async ({ contextId, survey: id, frames: wanted }) => {
      try {
        const started = Date.now();
        const context = contexts.get(contextId);
        if (!context) throw new SurveyFailure("CONTEXT_NOT_FOUND", `no context ${contextId}`);
        const file = await surveys.read(id);
        if (!file) throw new SurveyFailure("SURVEY_NOT_FOUND", `there is no survey ${id}, or it expired`);
        if (!file.complete) throw new SurveyFailure("SURVEY_INCOMPLETE", `survey ${id} has layers left to survey`);
        if (file.fileKey !== context.identity.fileKey || file.page !== context.identity.page) {
          throw new SurveyFailure("INVALID_ARGUMENT", `survey ${id} is of another file or page than context ${contextId}; get a context on that page with explore_page`);
        }
        const numbered = numberedFrames(file);
        const byNumber = new Map(numbered.map((frame) => [frame.n, frame.root.ref]));
        const asked = wanted ?? numbered.map((frame) => frame.n).slice(0, MAX_THUMBNAIL_FRAMES);
        const unknown = asked.filter((n) => !byNumber.has(n));
        if (unknown.length > 0) throw new SurveyFailure("INVALID_ARGUMENT", `survey ${id} has no frame ${unknown.map((n) => `#${n}`).join(", ")}; it numbers ${numbered.length} frames`);
        adoptSurvey(context, file);
        const frames = asked.map((n) => ({ ref: byNumber.get(n)!, n }));
        let result;
        try {
          result = SurveyThumbnailsResultSchema.parse(
            await bridge.request(
              "survey_thumbnails",
              {
                expect: context.identity,
                frames,
                ...knownParents(
                  context,
                  frames.map((frame) => frame.ref),
                ),
                ...(testTimeBudgetMs ? { timeBudgetMs: testTimeBudgetMs } : {}),
              },
              SURVEY_TIMEOUT_MS,
              context.tabId,
            ),
          );
        } catch (error) {
          if (error instanceof BridgeError && error.code === "CONTEXT_EXPIRED") contexts.release(contextId);
          throw error;
        }
        const done = new Set([...result.captured, ...result.failed.map((failure) => failure.n)]);
        // Without frames, a page of more than MAX_THUMBNAIL_FRAMES frames leaves the rest for later calls too.
        const all = wanted ?? numbered.map((frame) => frame.n);
        const output: SurveyThumbnailsOutput = {
          contextId,
          survey: id,
          sheets: result.sheets.map((sheet) => ({ frames: sheet.frames, width: sheet.image.width, height: sheet.image.height })),
          captured: result.captured,
          remaining: all.filter((n) => !done.has(n)),
          failed: result.failed,
          stoppedBy: result.stoppedBy,
          userSelectionRestored: result.userSelectionRestored,
          viewRestored: result.viewRestored,
          elapsedMs: Date.now() - started,
        };
        log(
          `survey_thumbnails captured=${result.captured.length} failed=${result.failed.length} remaining=${output.remaining.length} sheets=${result.sheets.length} ` +
            `stoppedBy=${result.stoppedBy?.code ?? "none"} viewRestored=${result.viewRestored} ms=${Math.round(result.elapsedMs)}`,
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(output) },
            ...result.sheets.map((sheet) => ({ type: "image" as const, data: sheet.image.data, mimeType: sheet.image.mimeType })),
          ],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
