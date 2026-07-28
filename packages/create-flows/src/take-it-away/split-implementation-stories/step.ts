import { type Document, document, fail, state, step } from "@stepkit/authoring";
import type { ContinuationResult } from "@stepkit/core";
import { implementStoryStep } from "../implement-story/step.js";
import { STORY_BOUNDARY } from "../shared/constants.js";

export interface SplitImplementationStoriesInput extends Record<string, unknown> {
  readonly implementationDoc: Document;
}

export const splitImplementationStoriesStep = step({ id: "split-implementation-stories" }).do(
  async ({ implementationDoc }: SplitImplementationStoriesInput): Promise<ContinuationResult> => {
    const chunks = implementationDoc.content
      .split(STORY_BOUNDARY)
      .slice(1) // drop the overview section before the first boundary
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.length > 0);

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
    await state.set("storyQueue", remaining);
    await state.set("completedStories", []);

    return implementStoryStep({ currentStory: firstStory, attempt: 1 });
  },
);
