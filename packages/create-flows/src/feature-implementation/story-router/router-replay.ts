import type { Document } from "@trailstep/authoring";
import { fail, state } from "@trailstep/authoring";
import type { ContinuationResult } from "@trailstep/core";

import { MAX_STORY_VALIDATION_ATTEMPTS } from "../../shared/constants.js";
import { implementGreenStep } from "../implement-green/step.js";
import {
  incrementStoryPhaseAttempt,
  loadStoryPhaseContext,
  STORY_STATE_KEYS,
  type StoryRouterState,
} from "../shared/story/story-state.js";
import { storyDoctorStep } from "../story-doctor/step.js";
import {
  formatBlockedRouteFailure,
  formatExhaustedRetryRouteFailure,
  hasReviewMetadata,
  hasValidationMetadata,
  inconsistentRetryState,
  isNonNegativeInteger,
  isPositiveInteger,
  retryStateMismatch,
  routerStateEvidenceMatchesLatest,
  storiesMatch,
} from "./router-state.js";
import type { RetryRouteSourceReason } from "./router-types.js";

export async function replayBlockedStoryRoute(): Promise<ContinuationResult | null> {
  const routerState = await state.get<StoryRouterState | null>(
    STORY_STATE_KEYS.latestStoryRouterState,
  );
  if (routerState?.route !== "blocked") {
    return null;
  }

  const activeStory = await state.get<Document | null>(STORY_STATE_KEYS.activeStory);
  if (!activeStory) {
    return fail({
      code: "story_router_no_active_story",
      message:
        "Cannot replay blocked story routing because durable router state exists but no active story is available.",
      details: { routerState },
    });
  }

  if (!storiesMatch(routerState.activeStory, activeStory)) {
    return fail({
      code: "story_router_blocked_state_mismatch",
      message:
        "Cannot replay blocked story routing because durable router state does not match the active story.",
      details: { storyPath: activeStory.path, routerState },
    });
  }

  await state.set(STORY_STATE_KEYS.activeStory, activeStory);
  await state.set(STORY_STATE_KEYS.blockedReason, routerState.blockedReason ?? null);
  return fail(formatBlockedRouteFailure(routerState));
}

export async function replayPersistedRetryRoute(
  reason: RetryRouteSourceReason,
  currentStory?: Document,
  previousActivePhase?: string | null,
): Promise<ContinuationResult | null> {
  const routerState = state.isReplayingCompletedStep
    ? await state.getPersisted<Partial<StoryRouterState> | null>(
        STORY_STATE_KEYS.latestStoryRouterState,
      )
    : await state.get<Partial<StoryRouterState> | null>(STORY_STATE_KEYS.latestStoryRouterState);
  if (!routerState || !isPersistedRetryRoute(routerState.route)) {
    return null;
  }

  if (routerState.source?.reason !== reason) {
    return null;
  }

  const activeStory =
    (await state.get<Document | null>(STORY_STATE_KEYS.activeStory)) ?? currentStory;
  if (!activeStory) {
    return inconsistentRetryState(
      "Cannot replay persisted story retry route because no active story is available.",
      { routerState },
    );
  }

  if (!routerState.activeStory) {
    return inconsistentRetryState(
      "Cannot replay persisted story retry route because the durable router state is missing its active story.",
      { storyPath: activeStory.path, routerState },
    );
  }

  if (!storiesMatch(routerState.activeStory, activeStory)) {
    return retryStateMismatch(routerState, activeStory);
  }

  const shapeFailure = validatePersistedRetryRouteShape(routerState, reason, activeStory);
  if (shapeFailure) {
    return shapeFailure;
  }

  if (routerState.route === "exhausted") {
    return fail(formatExhaustedRetryRouteFailure(routerState, activeStory));
  }

  if (
    !state.isReplayingCompletedStep &&
    routerState.route !== "doctoring" &&
    routerState.targetPhase !== previousActivePhase &&
    previousActivePhase !== "story-router"
  ) {
    return null;
  }

  if (!(await persistedRetryEvidenceMatches(reason, routerState))) {
    return null;
  }

  if (routerState.route === "retrying") {
    await state.set(STORY_STATE_KEYS.activeStory, activeStory);
    await state.set(STORY_STATE_KEYS.activePhase, "implement-green");
    const attempt = await incrementStoryPhaseAttempt("implement-green");
    return implementGreenStep({
      currentStory: activeStory,
      explorationBrief: (await state.get(STORY_STATE_KEYS.latestExplorationBrief)) ?? undefined,
      redTestSummary: (await state.get(STORY_STATE_KEYS.latestRedTestSummary)) ?? undefined,
      attempt,
      previousReviewSummary:
        reason === "failed-review" ? routerState.latestReview?.summary : undefined,
      requiredImprovements:
        reason === "failed-review" ? routerState.latestReview?.requiredImprovements : undefined,
      failedValidationSummary:
        reason === "failed-validation" ? routerState.latestValidation?.summary : undefined,
      failedValidationCommands:
        reason === "failed-validation" ? routerState.latestValidation?.commands : undefined,
      implementationContext: await loadStoryPhaseContext("implement-green"),
    });
  }

  if (routerState.route === "doctoring") {
    await state.set(STORY_STATE_KEYS.activeStory, activeStory);
    await state.set(STORY_STATE_KEYS.activePhase, "story-doctor");
    await incrementStoryPhaseAttempt("story-doctor");
    return storyDoctorStep({
      currentStory: activeStory,
      explorationBrief: (await state.get(STORY_STATE_KEYS.latestExplorationBrief)) ?? undefined,
      redTestSummary: (await state.get(STORY_STATE_KEYS.latestRedTestSummary)) ?? undefined,
      implementationSummary:
        (await state.get(STORY_STATE_KEYS.latestImplementationSummary)) ?? undefined,
      failedValidationSummary: routerState.latestValidation?.summary ?? "",
      failedValidationCommands: routerState.latestValidation?.commands ?? [],
      validationRetryCount: routerState.validationRetryCount ?? 0,
      retryLimit: routerState.retryLimit ?? MAX_STORY_VALIDATION_ATTEMPTS,
    });
  }

  return inconsistentRetryState(
    "Cannot replay persisted story retry route with an unknown route.",
    {
      storyPath: activeStory.path,
      routerState,
    },
  );
}

function isPersistedRetryRoute(
  route: unknown,
): route is Extract<StoryRouterState["route"], "retrying" | "doctoring" | "exhausted"> {
  return route === "retrying" || route === "doctoring" || route === "exhausted";
}

function validatePersistedRetryRouteShape(
  routerState: Partial<StoryRouterState>,
  reason: RetryRouteSourceReason,
  activeStory: Document,
): ContinuationResult | null {
  if (typeof routerState.source?.code !== "string" || routerState.source.code.length === 0) {
    return inconsistentRetryState(
      "Cannot replay persisted story retry route because the durable router state is missing its source code.",
      { storyPath: activeStory.path, routerState },
    );
  }

  if (!isNonNegativeInteger(routerState.reviewRetryCount)) {
    return inconsistentRetryState(
      "Cannot replay persisted story retry route because the review retry count is missing or invalid.",
      { storyPath: activeStory.path, routerState },
    );
  }

  if (!isNonNegativeInteger(routerState.validationRetryCount)) {
    return inconsistentRetryState(
      "Cannot replay persisted story retry route because the validation retry count is missing or invalid.",
      { storyPath: activeStory.path, routerState },
    );
  }

  if (!isPositiveInteger(routerState.retryLimit)) {
    return inconsistentRetryState(
      "Cannot replay persisted story retry route because the retry limit is missing or invalid.",
      { storyPath: activeStory.path, routerState },
    );
  }

  if (routerState.route === "retrying" && routerState.targetPhase !== "implement-green") {
    return inconsistentRetryState(
      "Cannot replay persisted story retry route because retrying routes must target implement-green.",
      { storyPath: activeStory.path, routerState },
    );
  }

  if (routerState.route === "doctoring" && routerState.targetPhase !== "story-doctor") {
    return inconsistentRetryState(
      "Cannot replay persisted story doctor route because doctoring routes must target story-doctor.",
      { storyPath: activeStory.path, routerState },
    );
  }

  if (reason === "failed-review" && !hasReviewMetadata(routerState.latestReview)) {
    return inconsistentRetryState(
      "Cannot replay persisted story review retry route because latest review evidence is missing or invalid.",
      { storyPath: activeStory.path, routerState },
    );
  }

  if (reason === "failed-validation" && !hasValidationMetadata(routerState.latestValidation)) {
    return inconsistentRetryState(
      "Cannot replay persisted story validation retry route because latest validation evidence is missing or invalid.",
      { storyPath: activeStory.path, routerState },
    );
  }

  return null;
}

async function persistedRetryEvidenceMatches(
  reason: RetryRouteSourceReason,
  routerState: Partial<StoryRouterState>,
): Promise<boolean> {
  if (routerState.source?.reason !== reason) {
    return false;
  }

  if (state.isReplayingCompletedStep) {
    return true;
  }

  return routerStateEvidenceMatchesLatest(routerState);
}
