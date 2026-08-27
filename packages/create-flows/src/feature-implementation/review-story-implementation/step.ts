import { state, step } from "@trailstep/authoring";
import { commitReviewedStoryStep } from "../commit-reviewed-story/step.js";
import type { ReviewResult } from "../shared/review-schema.js";
import { reviewOutput, reviewPasses } from "../shared/review-schema.js";
import { STORY_STATE_KEYS } from "../shared/story-state.js";
import { type ReviewStoryImplementationInput, reviewStoryImplementationPrompt } from "./prompt.js";

export const reviewStoryImplementationStep = step({ id: "review-story-implementation" })
  .prompt<ReviewStoryImplementationInput, ReviewResult>(reviewStoryImplementationPrompt, {
    agent: "storyReviewer",
    output: reviewOutput,
  })
  .do(async (review, input) => {
    await state.set(STORY_STATE_KEYS.latestReviewResult, review);
    if (!reviewPasses(review)) {
      const { storyRouterStep } = await import("../story-router/step.js");
      return storyRouterStep({ reason: "failed-review", currentStory: input.currentStory });
    }

    return commitReviewedStoryStep({
      currentStory: input.currentStory,
      implementationSummary: input.implementationSummary,
    });
  });
