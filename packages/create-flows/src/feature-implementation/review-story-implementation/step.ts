import { fail, state, step } from "@trailstep/authoring";
import { commitReviewedStoryStep } from "../commit-reviewed-story/step.js";
import { implementGreenStep } from "../implement-green/step.js";
import { MAX_STORY_REVIEW_ATTEMPTS } from "../shared/constants.js";
import type { ReviewResult } from "../shared/review-schema.js";
import { reviewOutput, reviewPasses } from "../shared/review-schema.js";
import { incrementStoryPhaseAttempt, STORY_STATE_KEYS } from "../shared/story-state.js";
import { type ReviewStoryImplementationInput, reviewStoryImplementationPrompt } from "./prompt.js";

export const reviewStoryImplementationStep = step({ id: "review-story-implementation" })
  .prompt<ReviewStoryImplementationInput, ReviewResult>(reviewStoryImplementationPrompt, {
    agent: "reviewer",
    output: reviewOutput,
  })
  .do(async (review, input) => {
    await state.set(STORY_STATE_KEYS.latestReviewResult, review);
    if (!reviewPasses(review)) {
      if (input.attempt >= MAX_STORY_REVIEW_ATTEMPTS) {
        return fail({
          code: "story_review_exhausted",
          message: `Story failed review ${MAX_STORY_REVIEW_ATTEMPTS} times in a row (last score ${review.score}/5).`,
          details: { review, storyPath: input.currentStory.path },
        });
      }

      await state.set(STORY_STATE_KEYS.activePhase, "implement-green");
      const attempt = await incrementStoryPhaseAttempt("implement-green");
      return implementGreenStep({
        currentStory: input.currentStory,
        attempt,
        previousReviewSummary: review.summary,
        requiredImprovements: review.requiredImprovements,
      });
    }

    return commitReviewedStoryStep({
      currentStory: input.currentStory,
      implementationSummary: input.implementationSummary,
    });
  });
