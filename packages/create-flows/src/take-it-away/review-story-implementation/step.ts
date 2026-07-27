import type { StepNode } from "@stepkit/core";
import { type Document, done, fail, state, step } from "@stepkit/sdk";
import { implementStoryStep } from "../implement-story/step.js";
import { MAX_STORY_REVIEW_ATTEMPTS } from "../shared/constants.js";
import { extractStoryTitle, type TakeItAwayOutput } from "../shared/output-schema.js";
import type { ReviewResult } from "../shared/review-schema.js";
import { reviewOutput, reviewPasses } from "../shared/review-schema.js";
import { type ReviewStoryImplementationInput, reviewStoryImplementationPrompt } from "./prompt.js";

export function reviewStoryImplementationStep(input: ReviewStoryImplementationInput): StepNode {
  return step({ id: "review-story-implementation" })
    .prompt<ReviewStoryImplementationInput, ReviewResult>(reviewStoryImplementationPrompt, {
      agent: "reviewer",
      output: reviewOutput,
    })
    .do(async (review) => {
      if (!reviewPasses(review)) {
        if (input.attempt >= MAX_STORY_REVIEW_ATTEMPTS) {
          return fail({
            code: "story_review_exhausted",
            message: `Story failed review ${MAX_STORY_REVIEW_ATTEMPTS} times in a row (last score ${review.score}/5).`,
            details: { review, storyPath: input.currentStory.path },
          });
        }

        return implementStoryStep({
          currentStory: input.currentStory,
          previousStoryReview: review,
          attempt: input.attempt + 1,
        });
      }

      const completed = (await state.get<string[]>("completedStories")) ?? [];
      const updatedCompleted = [
        ...completed,
        extractStoryTitle(input.currentStory.content, completed.length + 1),
      ];
      await state.set("completedStories", updatedCompleted);

      const storyQueue = (await state.get<Document[]>("storyQueue")) ?? [];
      const [nextStory, ...remaining] = storyQueue;

      if (!nextStory) {
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

      await state.set("storyQueue", remaining);
      return implementStoryStep({ currentStory: nextStory, attempt: 1 });
    })(input);
}
