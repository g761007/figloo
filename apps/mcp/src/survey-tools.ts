import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_SURVEY_REFS, SURVEY_TIME_BUDGET_MS, SurveyOutputSchema, SurveyResultSchema, type SurveyOutput } from "@figloo/protocol";
import { BridgeError, type Bridge } from "./bridge.js";
import { knownParents, type ContextStore, type ExplorationContext } from "./contexts.js";
import type { ToolErrorResult } from "./export-asset.js";
import { fitOverview, surveyOverview } from "./survey-summary.js";
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
}
