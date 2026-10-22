import type { Document } from "@trailstep/authoring";
import { state } from "@trailstep/authoring";

import type { ReviewResult } from "../shared/story/review-schema.js";
import { STORY_STATE_KEYS, type StoryRouterState } from "../shared/story/story-state.js";
import type { ValidateStoryOutput } from "../validate-story/prompt.js";
import {
  normalizeRetryCount,
  phaseAttemptFallback,
  routerStateEvidenceMatchesLatest,
} from "./router-state.js";
import type { RouterRetryCounts } from "./router-types.js";

export async function persistRetryRouterState(input: {
  readonly activeStory: Document;
  readonly route: "retrying" | "doctoring" | "exhausted";
  readonly targetPhase?: "implement-green" | "story-doctor";
  readonly sourceReason: "failed-review" | "failed-validation";
  readonly code: string;
  readonly counts: RouterRetryCounts;
  readonly retryLimit: number;
  readonly exhaustedReason?: "review" | "validation";
  readonly review?: ReviewResult;
  readonly validation?: ValidateStoryOutput;
}): Promise<StoryRouterState> {
  const routerState: StoryRouterState = {
    route: input.route,
    activeStory: input.activeStory,
    targetPhase: input.targetPhase,
    reviewRetryCount: input.counts.reviewRetryCount,
    validationRetryCount: input.counts.validationRetryCount,
    retryLimit: input.retryLimit,
    exhaustedReason: input.exhaustedReason,
    latestReview: input.review
      ? {
          score: input.review.score,
          summary: input.review.summary,
          requiredImprovements: input.review.requiredImprovements,
        }
      : undefined,
    latestValidation: input.validation
      ? {
          summary: input.validation.summary,
          commands: input.validation.commands,
        }
      : undefined,
    source: {
      reason: input.sourceReason,
      code: input.code,
    },
  };
  await state.set(STORY_STATE_KEYS.latestStoryRouterState, routerState);
  return routerState;
}

export async function loadRouterRetryCounts(input: {
  readonly reviewPhaseFallback?: "review-story-implementation";
  readonly validationPhaseFallback?: "validate-story";
}): Promise<RouterRetryCounts> {
  const activeStory = await state.get<Document | null>(STORY_STATE_KEYS.activeStory);
  const routerState = await state.get<Partial<StoryRouterState> | null>(
    STORY_STATE_KEYS.latestStoryRouterState,
  );
  const attemptsByPhase =
    (await state.get<Record<string, number> | null>(STORY_STATE_KEYS.attemptsByPhase)) ?? {};
  const routerStateMatchesActiveStory =
    activeStory &&
    routerState?.activeStory?.path === activeStory.path &&
    routerState.activeStory.content === activeStory.content;

  if (routerStateMatchesActiveStory) {
    const fallbackCounts = {
      reviewRetryCount: phaseAttemptFallback(attemptsByPhase, input.reviewPhaseFallback),
      validationRetryCount: phaseAttemptFallback(attemptsByPhase, input.validationPhaseFallback),
    };
    const replayingSameReviewEvidence =
      input.reviewPhaseFallback && routerState.source?.reason === "failed-review";
    const replayingSameValidationEvidence =
      input.validationPhaseFallback && routerState.source?.reason === "failed-validation";

    if (
      (replayingSameReviewEvidence || replayingSameValidationEvidence) &&
      !(await routerStateEvidenceMatchesLatest(routerState))
    ) {
      return fallbackCounts;
    }

    return {
      reviewRetryCount: normalizeRetryCount(routerState.reviewRetryCount),
      validationRetryCount: normalizeRetryCount(routerState.validationRetryCount),
    };
  }

  if (routerState?.activeStory) {
    return {
      reviewRetryCount: 0,
      validationRetryCount: 0,
    };
  }

  return {
    reviewRetryCount: phaseAttemptFallback(attemptsByPhase, input.reviewPhaseFallback),
    validationRetryCount: phaseAttemptFallback(attemptsByPhase, input.validationPhaseFallback),
  };
}
