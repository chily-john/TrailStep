import type { Document } from "@stepkit/authoring";
import { done, fail, state, step } from "@stepkit/authoring";
import { implementStoryStep } from "../implement-story/step.js";
import { MAX_STORY_REVIEW_ATTEMPTS } from "../shared/constants.js";
import { extractStoryTitle, type TakeItAwayOutput } from "../shared/output-schema.js";
import type { ReviewResult } from "../shared/review-schema.js";
import { reviewOutput, reviewPasses } from "../shared/review-schema.js";
import {
  recordActiveStoryStartCommit,
  resetActiveStoryStartCommit,
  STORY_STATE_KEYS,
} from "../shared/story-state.js";
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

    const activeStory =
      (await state.get<Document | null>(STORY_STATE_KEYS.activeStory)) ?? input.currentStory;
    const completed = (await state.get<string[]>(STORY_STATE_KEYS.completedStories)) ?? [];
    const updatedCompleted = [
      ...completed,
      extractStoryTitle(activeStory.content, completed.length + 1),
    ];
    await state.set(STORY_STATE_KEYS.completedStories, updatedCompleted);

    const storyQueue = (await state.get<Document[]>(STORY_STATE_KEYS.storyQueue)) ?? [];
    const [nextStory, ...remaining] = storyQueue;

    if (!nextStory) {
      await state.set(STORY_STATE_KEYS.activeStory, null);
      await resetActiveStoryStartCommit();
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

    await state.set(STORY_STATE_KEYS.storyQueue, remaining);
    await state.set(STORY_STATE_KEYS.activeStory, nextStory);
    await resetActiveStoryStartCommit();
    await recordActiveStoryStartCommit();
    return implementStoryStep({ currentStory: nextStory, attempt: 1 });
  });
