import { type Document, document, fail, state, step } from "@stepkit/authoring";
import type { ContinuationResult } from "@stepkit/core";
import { implementStoryStep } from "../implement-story/step.js";
import { STORY_BOUNDARY, STORY_CONTEXT_END, STORY_CONTEXT_START } from "../shared/constants.js";
import { recordActiveStoryStartCommit, STORY_STATE_KEYS } from "../shared/story-state.js";

export interface SplitImplementationStoriesInput extends Record<string, unknown> {
  readonly implementationDoc: Document;
}

export const splitImplementationStoriesStep = step({ id: "split-implementation-stories" }).do(
  async ({ implementationDoc }: SplitImplementationStoriesInput): Promise<ContinuationResult> => {
    const contextStartCount = countOccurrences(implementationDoc.content, STORY_CONTEXT_START);
    const contextEndCount = countOccurrences(implementationDoc.content, STORY_CONTEXT_END);

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
    await recordActiveStoryStartCommit();

    return implementStoryStep({ currentStory: firstStory, attempt: 1 });
  },
);

function countOccurrences(value: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }

  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(needle, offset);
    if (index === -1) {
      return count;
    }

    count += 1;
    offset = index + needle.length;
  }
}

function storyContextPattern(): RegExp {
  return new RegExp(
    `${escapeRegExp(STORY_CONTEXT_START)}([\\s\\S]*?)${escapeRegExp(STORY_CONTEXT_END)}`,
    "g",
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
