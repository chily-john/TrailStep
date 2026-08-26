import { type Document, document, fail, state, step } from "@trailstep/authoring";
import type { ContinuationResult } from "@trailstep/core";
import { STORY_BOUNDARY, STORY_CONTEXT_END, STORY_CONTEXT_START } from "../shared/constants.js";
import { STORY_STATE_KEYS } from "../shared/story-state.js";
import { storyRouterStep } from "../story-router/step.js";

export interface SplitImplementationStoriesInput extends Record<string, unknown> {
  readonly implementationDoc: Document;
}

export const splitImplementationStoriesStep = step({ id: "split-implementation-stories" }).do(
  async ({ implementationDoc }: SplitImplementationStoriesInput): Promise<ContinuationResult> => {
    const contextStartCount = countStandaloneMarkerLines(
      implementationDoc.content,
      STORY_CONTEXT_START,
    );
    const contextEndCount = countStandaloneMarkerLines(
      implementationDoc.content,
      STORY_CONTEXT_END,
    );

    if (contextStartCount !== contextEndCount) {
      return fail({
        code: "unbalanced_story_context",
        message: `Found ${contextStartCount} \`${STORY_CONTEXT_START}\` marker(s) and ${contextEndCount} \`${STORY_CONTEXT_END}\` marker(s) in implementation-doc.md. Context blocks must be balanced.`,
        details: { implementationDocPath: implementationDoc.path },
      });
    }

    const contextMatches = Array.from(implementationDoc.content.matchAll(storyContextPattern()));
    if (contextMatches.length !== contextStartCount) {
      return fail({
        code: "invalid_story_context_order",
        message: `Every \`${STORY_CONTEXT_START}\` marker in implementation-doc.md must be followed by a matching \`${STORY_CONTEXT_END}\` marker.`,
        details: { implementationDocPath: implementationDoc.path },
      });
    }

    const contextBlocks = contextMatches
      .map(([, context]) => context?.trim() ?? "")
      .filter((context) => context.length > 0);
    const sharedContext = contextBlocks.join("\n\n---\n\n");
    const contentWithoutContextBlocks = implementationDoc.content.replace(
      storyContextPattern(),
      "",
    );

    const chunks = contentWithoutContextBlocks
      .split(STORY_BOUNDARY)
      .slice(1) // drop overview-only text before the first boundary; <context> blocks are prepended below
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.length > 0)
      .map((chunk) => prependSharedContext(chunk, sharedContext));

    if (chunks.length === 0) {
      return fail({
        code: "no_stories_found",
        message: `No \`${STORY_BOUNDARY}\`-delimited stories found in implementation-doc.md.`,
        details: { implementationDocPath: implementationDoc.path },
      });
    }

    const storyDocs: Document[] = [];
    for (const chunk of chunks) {
      storyDocs.push(await document(chunk));
    }

    // storyDocs.length === chunks.length, already guarded above to be > 0.
    const [firstStory, ...remaining] = storyDocs as [Document, ...Document[]];
    await state.set(STORY_STATE_KEYS.storyQueue, remaining);
    await state.set(STORY_STATE_KEYS.completedStories, []);
    await state.set(STORY_STATE_KEYS.activeStory, firstStory);
    await state.set(STORY_STATE_KEYS.activePhase, "story-router");
    await state.set(STORY_STATE_KEYS.attemptsByPhase, {});
    await state.set(STORY_STATE_KEYS.storyBaseline, null);
    await state.set(STORY_STATE_KEYS.latestPreflightStatus, null);
    await state.set(STORY_STATE_KEYS.latestExplorationBrief, null);
    await state.set(STORY_STATE_KEYS.latestRedTestSummary, null);
    await state.set(STORY_STATE_KEYS.latestImplementationSummary, null);
    await state.set(STORY_STATE_KEYS.latestValidationSummary, null);
    await state.set(STORY_STATE_KEYS.latestReviewResult, null);
    await state.set(STORY_STATE_KEYS.blockedReason, null);

    return storyRouterStep({ reason: "start-story", currentStory: firstStory });
  },
);

function countStandaloneMarkerLines(value: string, marker: string): number {
  return Array.from(value.matchAll(standaloneMarkerLinePattern(marker))).length;
}

function standaloneMarkerLinePattern(marker: string): RegExp {
  return new RegExp(`^[ \\t]*${escapeRegExp(marker)}[ \\t]*$`, "gm");
}

function storyContextPattern(): RegExp {
  return new RegExp(
    `^[ \\t]*${escapeRegExp(STORY_CONTEXT_START)}[ \\t]*\\r?\\n([\\s\\S]*?)^[ \\t]*${escapeRegExp(STORY_CONTEXT_END)}[ \\t]*$`,
    "gm",
  );
}

function prependSharedContext(story: string, sharedContext: string): string {
  if (sharedContext.length === 0) {
    return story;
  }

  return ["## Shared implementation context", sharedContext, "## Active story", story].join("\n\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
