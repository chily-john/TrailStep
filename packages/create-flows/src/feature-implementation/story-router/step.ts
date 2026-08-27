import type { Document } from "@trailstep/authoring";
import { fail, state, step } from "@trailstep/authoring";
import type { ContinuationResult } from "@trailstep/core";
import { implementGreenStep } from "../implement-green/step.js";
import { MAX_STORY_REVIEW_ATTEMPTS } from "../shared/constants.js";
import type { ReviewResult } from "../shared/review-schema.js";
import { reviewPasses } from "../shared/review-schema.js";
import { incrementStoryPhaseAttempt, STORY_STATE_KEYS } from "../shared/story-state.js";
import { storyIsolationPreflightStep } from "../story-isolation-preflight/step.js";
import type { ValidateStoryOutput } from "../validate-story/prompt.js";

export interface StoryRouterInput extends Record<string, unknown> {
  readonly reason:
    | "start-story"
    | "retry-story"
    | "story-completed"
    | "failed-review"
    | "failed-validation";
  readonly currentStory?: Document;
}

export const storyRouterStep = step({ id: "story-router" }).do(
  async ({ currentStory, reason }: StoryRouterInput): Promise<ContinuationResult> => {
    await state.set(STORY_STATE_KEYS.activePhase, "story-router");
    await incrementStoryPhaseAttempt("story-router");

    if (reason === "failed-review") {
      return routeFailedReview(currentStory);
    }
    if (reason === "failed-validation") {
      return routeFailedValidation(currentStory);
    }

    const activeStory =
      currentStory ?? (await state.get<Document | null>(STORY_STATE_KEYS.activeStory));
    if (!activeStory) {
      const [nextStory, ...remaining] =
        (await state.get<Document[]>(STORY_STATE_KEYS.storyQueue)) ?? [];
      if (!nextStory) {
        return fail({
          code: "story_router_no_active_story",
          message:
            "Cannot route story implementation because no active story or queued story is available.",
        });
      }

      const [nextStoryContext = "", ...remainingStoryContexts] =
        (await state.get<string[]>(STORY_STATE_KEYS.storyContextQueue)) ?? [];
      await state.set(STORY_STATE_KEYS.storyQueue, remaining);
      await state.set(STORY_STATE_KEYS.storyContextQueue, remainingStoryContexts);
      await state.set(STORY_STATE_KEYS.activeStory, nextStory);
      await state.set(STORY_STATE_KEYS.activeStoryContext, nextStoryContext);
      return routeStoryAfterPreflight(nextStory);
    }

    await state.set(STORY_STATE_KEYS.activeStory, activeStory);
    return routeStoryAfterPreflight(activeStory);
  },
);

async function routeFailedReview(currentStory?: Document): Promise<ContinuationResult> {
  const activeStory =
    (await state.get<Document | null>(STORY_STATE_KEYS.activeStory)) ?? currentStory;
  if (!activeStory) {
    return fail({
      code: "story_router_no_active_story",
      message: "Cannot route failed story review because no active story is available for retry.",
    });
  }

  const review = await state.get<ReviewResult | null>(STORY_STATE_KEYS.latestReviewResult);
  if (!review) {
    return fail({
      code: "story_router_missing_review_result",
      message: "Cannot route failed story review because no latest review result is available.",
      details: { storyPath: activeStory.path },
    });
  }

  if (reviewPasses(review)) {
    return fail({
      code: "story_router_review_already_passed",
      message: "Cannot route failed story review because the latest review already passes.",
      details: { review, storyPath: activeStory.path },
    });
  }

  const attemptsByPhase =
    (await state.get<Record<string, number> | null>(STORY_STATE_KEYS.attemptsByPhase)) ?? {};
  const reviewAttempt = attemptsByPhase["review-story-implementation"] ?? 0;
  if (reviewAttempt >= MAX_STORY_REVIEW_ATTEMPTS) {
    return fail({
      code: "story_review_exhausted",
      message: `Story failed review ${MAX_STORY_REVIEW_ATTEMPTS} times in a row (last score ${review.score}/5).`,
      details: { review, storyPath: activeStory.path },
    });
  }

  await state.set(STORY_STATE_KEYS.activeStory, activeStory);
  await state.set(STORY_STATE_KEYS.activePhase, "implement-green");
  const attempt = await incrementStoryPhaseAttempt("implement-green");
  return implementGreenStep({
    currentStory: activeStory,
    explorationBrief: (await state.get(STORY_STATE_KEYS.latestExplorationBrief)) ?? undefined,
    redTestSummary: (await state.get(STORY_STATE_KEYS.latestRedTestSummary)) ?? undefined,
    attempt,
    previousReviewSummary: review.summary,
    requiredImprovements: review.requiredImprovements,
  });
}

async function routeFailedValidation(currentStory?: Document): Promise<ContinuationResult> {
  const activeStory =
    (await state.get<Document | null>(STORY_STATE_KEYS.activeStory)) ?? currentStory;
  if (!activeStory) {
    return fail({
      code: "story_router_no_active_story",
      message:
        "Cannot route failed story validation because no active story is available for retry.",
    });
  }

  const validation = await state.get<ValidateStoryOutput | null>(
    STORY_STATE_KEYS.latestValidationSummary,
  );
  if (!validation) {
    return fail({
      code: "story_router_missing_validation_result",
      message:
        "Cannot route failed story validation because no latest validation result is available.",
      details: { storyPath: activeStory.path },
    });
  }

  if (validation.blocked) {
    return fail({
      code: "story_validation_blocked",
      message: validation.blockedReason ?? "Story validation reported a blocked state.",
      details: { storyPath: activeStory.path, validation },
    });
  }

  if (validation.validationPassed) {
    return fail({
      code: "story_router_validation_already_passed",
      message: "Cannot route failed story validation because the latest validation already passes.",
      details: { storyPath: activeStory.path, validation },
    });
  }

  await state.set(STORY_STATE_KEYS.activeStory, activeStory);
  await state.set(STORY_STATE_KEYS.activePhase, "implement-green");
  const attempt = await incrementStoryPhaseAttempt("implement-green");
  return implementGreenStep({
    currentStory: activeStory,
    explorationBrief: (await state.get(STORY_STATE_KEYS.latestExplorationBrief)) ?? undefined,
    redTestSummary: (await state.get(STORY_STATE_KEYS.latestRedTestSummary)) ?? undefined,
    attempt,
    failedValidationSummary: validation.summary,
    failedValidationCommands: validation.commands,
  });
}

async function routeStoryAfterPreflight(activeStory: Document): Promise<ContinuationResult> {
  return storyIsolationPreflightStep({ currentStory: activeStory });
}
