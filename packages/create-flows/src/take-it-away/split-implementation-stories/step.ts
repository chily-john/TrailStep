import type { ContinuationResult } from "@stepkit/core";
import { type Document, document, fail, state, step } from "@stepkit/sdk";
import { implementStoryStep } from "../implement-story/step.js";
import { STORY_BOUNDARY } from "../shared/constants.js";

export const splitImplementationStoriesStep = step({ id: "split-implementation-stories" }).do(
  async (): Promise<ContinuationResult> => {
    const implementationDoc = await state.get<Document>("implementationDoc");
    if (!implementationDoc) {
      throw new Error("split-implementation-stories: implementationDoc missing from state.");
    }

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

    const storyQueue: Document[] = [];
    for (const chunk of chunks) {
      storyQueue.push(await document(chunk));
    }

    await state.set("storyQueue", storyQueue);
    await state.set("completedStories", []);
    await state.set("storyReviewAttempts", 1);

    return implementStoryStep();
  },
);
