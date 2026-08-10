import { fail, step } from "@trailstep/authoring";
import { commitReviewedStoryStep } from "../commit-reviewed-story/step.js";
import { implementStoryStep } from "../implement-story/step.js";
import { MAX_STORY_REVIEW_ATTEMPTS } from "../shared/constants.js";
import type { ReviewResult } from "../shared/review-schema.js";
import { reviewOutput, reviewPasses } from "../shared/review-schema.js";
import { type ReviewStoryImplementationInput, reviewStoryImplementationPrompt } from "./prompt.js";

export const reviewStoryImplementationStep = step({ id: "review-story-implementation" })
  .prompt<ReviewStoryImplementationInput, ReviewResult>(reviewStoryImplementationPrompt, {
    agent: "reviewer",
    output: reviewOutput,
  })
  .do(async (review, input) => {
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

    return commitReviewedStoryStep({
      currentStory: input.currentStory,
      implementationSummary: input.implementationSummary,
    });
  });
