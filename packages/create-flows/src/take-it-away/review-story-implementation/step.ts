import type { StepNode } from "@stepkit/core";
import { type Document, done, fail, state, step } from "@stepkit/sdk";
import { implementStoryStep } from "../implement-story/step.js";
import { MAX_STORY_REVIEW_ATTEMPTS } from "../shared/constants.js";
import { extractStoryTitle, type TakeItAwayOutput } from "../shared/output-schema.js";
import { type ReviewResult, reviewOutput, reviewPasses } from "../shared/review-schema.js";
import { type ReviewStoryImplementationInput, reviewStoryImplementationPrompt } from "./prompt.js";

export async function reviewStoryImplementationStep(): Promise<StepNode> {
  const storyQueue = (await state.get<Document[]>("storyQueue")) ?? [];
  const currentStory = storyQueue[0];
  if (!currentStory) {
    throw new Error("review-story-implementation: storyQueue is empty in state.");
  }

  const promptInput: ReviewStoryImplementationInput = { currentStory };

  return step({ id: "review-story-implementation" })
    .prompt<ReviewStoryImplementationInput, ReviewResult>(reviewStoryImplementationPrompt, {
      agent: "reviewer",
      output: reviewOutput,
    })
    .do(async (review) => {
      const attempt = (await state.get<number>("storyReviewAttempts")) ?? 1;

      if (!reviewPasses(review)) {
        if (attempt >= MAX_STORY_REVIEW_ATTEMPTS) {
          return fail({
            code: "story_review_exhausted",
            message: `Story failed review ${MAX_STORY_REVIEW_ATTEMPTS} times in a row (last score ${review.score}/5).`,
            details: { review, storyPath: currentStory.path },
          });
        }

        await state.set("storyReview", review);
        await state.set("storyReviewAttempts", attempt + 1);
        return implementStoryStep();
      }

      const remaining = storyQueue.slice(1);
      const completed = (await state.get<string[]>("completedStories")) ?? [];
      const updatedCompleted = [
        ...completed,
        extractStoryTitle(currentStory.content, completed.length + 1),
      ];

      await state.set("storyQueue", remaining);
      await state.set("completedStories", updatedCompleted);
      await state.set("storyReview", undefined);
      await state.set("storyReviewAttempts", 1);

      if (remaining.length === 0) {
        const featureDoc = await state.get<Document>("featureDoc");
        const implementationDoc = await state.get<Document>("implementationDoc");
        const output: TakeItAwayOutput = {
          status: "implemented",
          featureDocPath: featureDoc?.path ?? "",
          implementationDocPath: implementationDoc?.path ?? "",
          storyCount: updatedCompleted.length,
          completedStories: updatedCompleted,
          summary: `Implemented and reviewed ${updatedCompleted.length} ${updatedCompleted.length === 1 ? "story" : "stories"}.`,
        };
        return done(output);
      }

      return implementStoryStep();
    })(promptInput);
}
