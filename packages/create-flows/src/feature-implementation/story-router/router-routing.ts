import type { Document } from "@trailstep/authoring";
import { fail, state } from "@trailstep/authoring";
import type { ContinuationResult } from "@trailstep/core";

import {
  MAX_STORY_REVIEW_ATTEMPTS,
  MAX_STORY_VALIDATION_ATTEMPTS,
  STORY_DOCTOR_VALIDATION_FAILURE_THRESHOLD,
} from "../../shared/constants.js";
import { implementGreenStep } from "../implement-green/step.js";
import type { ReviewResult } from "../shared/story/review-schema.js";
import { reviewPasses } from "../shared/story/review-schema.js";
import {
  incrementStoryPhaseAttempt,
  loadStoryPhaseContext,
  STORY_STATE_KEYS,
  type StoryRouterState,
} from "../shared/story/story-state.js";
import { storyDoctorStep } from "../story-doctor/step.js";
import type { ValidateStoryOutput } from "../validate-story/prompt.js";
import { loadRouterRetryCounts, persistRetryRouterState } from "./router-retry-state.js";
import { formatBlockedRouteFailure } from "./router-state.js";
import type { BlockedStoryRoute } from "./router-types.js";

export async function routeFailedReview(currentStory?: Document): Promise<ContinuationResult> {
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

  const previousCounts = await loadRouterRetryCounts({
    reviewPhaseFallback: "review-story-implementation",
  });
  const reviewRetryCount = previousCounts.reviewRetryCount + 1;
  const nextCounts = { ...previousCounts, reviewRetryCount };

  if (reviewRetryCount >= MAX_STORY_REVIEW_ATTEMPTS) {
    const routerState = await persistRetryRouterState({
      activeStory,
      route: "exhausted",
      sourceReason: "failed-review",
      code: "story_review_exhausted",
      counts: nextCounts,
      retryLimit: MAX_STORY_REVIEW_ATTEMPTS,
      exhaustedReason: "review",
      review,
    });
    return fail({
      code: "story_review_exhausted",
      message: `Story failed review ${reviewRetryCount} times; retry limit is ${MAX_STORY_REVIEW_ATTEMPTS} (last score ${review.score}/5).`,
      details: {
        review,
        storyPath: activeStory.path,
        reviewRetryCount,
        retryLimit: MAX_STORY_REVIEW_ATTEMPTS,
        routerState,
      },
    });
  }

  await state.set(STORY_STATE_KEYS.activeStory, activeStory);
  await state.set(STORY_STATE_KEYS.activePhase, "implement-green");
  await persistRetryRouterState({
    activeStory,
    route: "retrying",
    targetPhase: "implement-green",
    sourceReason: "failed-review",
    code: "story_review_retry",
    counts: nextCounts,
    retryLimit: MAX_STORY_REVIEW_ATTEMPTS,
    review,
  });
  const attempt = await incrementStoryPhaseAttempt("implement-green");
  return implementGreenStep({
    currentStory: activeStory,
    explorationBrief: (await state.get(STORY_STATE_KEYS.latestExplorationBrief)) ?? undefined,
    redTestSummary: (await state.get(STORY_STATE_KEYS.latestRedTestSummary)) ?? undefined,
    attempt,
    previousReviewSummary: review.summary,
    requiredImprovements: review.requiredImprovements,
    implementationContext: await loadStoryPhaseContext("implement-green"),
  });
}

export async function routeFailedValidation(currentStory?: Document): Promise<ContinuationResult> {
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
    return routeBlockedStory(activeStory, {
      type: "blocked",
      sourceReason: "failed-validation",
      blockedPhase: "validate-story",
      blockedReason: validation.blockedReason ?? "Story validation reported a blocked state.",
      code: "story_validation_blocked",
      metadata: { validation },
    });
  }

  if (validation.validationPassed) {
    return fail({
      code: "story_router_validation_already_passed",
      message: "Cannot route failed story validation because the latest validation already passes.",
      details: { storyPath: activeStory.path, validation },
    });
  }

  const previousCounts = await loadRouterRetryCounts({
    validationPhaseFallback: "validate-story",
  });
  const validationRetryCount = previousCounts.validationRetryCount + 1;
  const nextCounts = { ...previousCounts, validationRetryCount };

  if (validationRetryCount >= MAX_STORY_VALIDATION_ATTEMPTS) {
    const routerState = await persistRetryRouterState({
      activeStory,
      route: "exhausted",
      sourceReason: "failed-validation",
      code: "story_validation_exhausted",
      counts: nextCounts,
      retryLimit: MAX_STORY_VALIDATION_ATTEMPTS,
      exhaustedReason: "validation",
      validation,
    });
    return fail({
      code: "story_validation_exhausted",
      message: `Story failed validation ${validationRetryCount} times; retry limit is ${MAX_STORY_VALIDATION_ATTEMPTS}.`,
      details: {
        storyPath: activeStory.path,
        validation,
        validationRetryCount,
        retryLimit: MAX_STORY_VALIDATION_ATTEMPTS,
        routerState,
      },
    });
  }

  const route =
    validationRetryCount >= STORY_DOCTOR_VALIDATION_FAILURE_THRESHOLD ? "doctoring" : "retrying";
  const targetPhase = route === "doctoring" ? "story-doctor" : "implement-green";
  await state.set(STORY_STATE_KEYS.activeStory, activeStory);
  await state.set(STORY_STATE_KEYS.activePhase, targetPhase);
  await persistRetryRouterState({
    activeStory,
    route,
    targetPhase,
    sourceReason: "failed-validation",
    code: route === "doctoring" ? "story_validation_doctor" : "story_validation_retry",
    counts: nextCounts,
    retryLimit: MAX_STORY_VALIDATION_ATTEMPTS,
    validation,
  });

  if (route === "doctoring") {
    await incrementStoryPhaseAttempt("story-doctor");
    return storyDoctorStep({
      currentStory: activeStory,
      explorationBrief: (await state.get(STORY_STATE_KEYS.latestExplorationBrief)) ?? undefined,
      redTestSummary: (await state.get(STORY_STATE_KEYS.latestRedTestSummary)) ?? undefined,
      implementationSummary:
        (await state.get(STORY_STATE_KEYS.latestImplementationSummary)) ?? undefined,
      failedValidationSummary: validation.summary,
      failedValidationCommands: validation.commands,
      validationRetryCount,
      retryLimit: MAX_STORY_VALIDATION_ATTEMPTS,
    });
  }

  const attempt = await incrementStoryPhaseAttempt("implement-green");
  return implementGreenStep({
    currentStory: activeStory,
    explorationBrief: (await state.get(STORY_STATE_KEYS.latestExplorationBrief)) ?? undefined,
    redTestSummary: (await state.get(STORY_STATE_KEYS.latestRedTestSummary)) ?? undefined,
    attempt,
    failedValidationSummary: validation.summary,
    failedValidationCommands: validation.commands,
    implementationContext: await loadStoryPhaseContext("implement-green"),
  });
}

export async function routeBlockedStory(
  currentStory: Document | undefined,
  blockedRoute: BlockedStoryRoute,
): Promise<ContinuationResult> {
  const activeStory =
    (await state.get<Document | null>(STORY_STATE_KEYS.activeStory)) ?? currentStory;
  if (!activeStory) {
    return fail({
      code: "story_router_no_active_story",
      message: "Cannot route blocked story because no active story is available.",
    });
  }

  const counts = await loadRouterRetryCounts({});
  const routerState: StoryRouterState = {
    route: "blocked",
    activeStory,
    reviewRetryCount: counts.reviewRetryCount,
    validationRetryCount: counts.validationRetryCount,
    blockedPhase: blockedRoute.blockedPhase,
    blockedReason: blockedRoute.blockedReason,
    source: {
      reason: blockedRoute.sourceReason,
      blocked: true,
      code: blockedRoute.code,
      metadata: blockedRoute.metadata,
    },
  };

  await state.set(STORY_STATE_KEYS.activeStory, activeStory);
  await state.set(STORY_STATE_KEYS.latestStoryRouterState, routerState);
  await state.set(STORY_STATE_KEYS.blockedReason, blockedRoute.blockedReason);

  return fail(formatBlockedRouteFailure(routerState));
}
