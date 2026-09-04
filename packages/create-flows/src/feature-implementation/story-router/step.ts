import type { Document } from "@trailstep/authoring";
import { fail, state, step } from "@trailstep/authoring";
import type { ContinuationResult, Failure } from "@trailstep/core";
import { implementGreenStep } from "../implement-green/step.js";
import {
  MAX_STORY_REVIEW_ATTEMPTS,
  MAX_STORY_VALIDATION_ATTEMPTS,
  STORY_DOCTOR_VALIDATION_FAILURE_THRESHOLD,
} from "../shared/constants.js";
import type { ReviewResult } from "../shared/review-schema.js";
import { reviewPasses } from "../shared/review-schema.js";
import {
  type BlockedStoryPhase,
  type BlockedStoryRouteSourceReason,
  incrementStoryPhaseAttempt,
  STORY_STATE_KEYS,
  type StoryRouterState,
} from "../shared/story-state.js";
import { storyDoctorStep } from "../story-doctor/step.js";
import { storyIsolationPreflightStep } from "../story-isolation-preflight/step.js";
import type { ValidateStoryOutput } from "../validate-story/prompt.js";

export interface StoryRouterInput extends Record<string, unknown> {
  readonly reason:
    | "start-story"
    | "retry-story"
    | "story-completed"
    | "failed-review"
    | "failed-validation"
    | {
        readonly type: "blocked";
        readonly sourceReason: BlockedStoryRouteSourceReason;
        readonly blockedPhase: BlockedStoryPhase;
        readonly blockedReason: string;
        readonly code: string;
        readonly metadata?: Record<string, unknown>;
      };
  readonly currentStory?: Document;
}

interface RouterRetryCounts {
  readonly reviewRetryCount: number;
  readonly validationRetryCount: number;
}

type RetryRouteSourceReason = "failed-review" | "failed-validation";

class StoryRouterFailureError extends Error {
  readonly failure: Failure;

  constructor(failure: Failure) {
    super(failure.message);
    this.name = "StoryRouterFailureError";
    this.failure = failure;
  }
}

export const storyRouterStep = step({ id: "story-router" }).do(
  async ({ currentStory, reason }: StoryRouterInput): Promise<ContinuationResult> => {
    await state.set(STORY_STATE_KEYS.activePhase, "story-router");
    await incrementStoryPhaseAttempt("story-router");

    if (reason === "failed-review") {
      const replayedRoute = await replayPersistedRetryRoute(reason, currentStory);
      if (replayedRoute) {
        return replayedRoute;
      }
      return routeFailedReview(currentStory);
    }
    if (reason === "failed-validation") {
      const replayedRoute = await replayPersistedRetryRoute(reason, currentStory);
      if (replayedRoute) {
        return replayedRoute;
      }
      return routeFailedValidation(currentStory);
    }
    if (typeof reason === "object" && reason.type === "blocked") {
      const blockedReplay = await replayBlockedStoryRoute();
      if (blockedReplay) {
        return blockedReplay;
      }
      return routeBlockedStory(currentStory, reason);
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
  });
}

async function routeBlockedStory(
  currentStory: Document | undefined,
  blockedRoute: Extract<StoryRouterInput["reason"], { readonly type: "blocked" }>,
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

async function replayBlockedStoryRoute(): Promise<ContinuationResult | null> {
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

async function replayPersistedRetryRoute(
  reason: RetryRouteSourceReason,
  currentStory?: Document,
): Promise<ContinuationResult | null> {
  const routerState = await state.get<Partial<StoryRouterState> | null>(
    STORY_STATE_KEYS.latestStoryRouterState,
  );
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
  return routerState.source?.reason === reason && routerStateEvidenceMatchesLatest(routerState);
}

async function routerStateEvidenceMatchesLatest(
  routerState: Partial<StoryRouterState>,
): Promise<boolean> {
  if (routerState.source?.reason === "failed-review") {
    if (!hasReviewMetadata(routerState.latestReview)) {
      return false;
    }

    const review = await state.get<ReviewResult | null>(STORY_STATE_KEYS.latestReviewResult);
    return (
      !!review &&
      routerState.latestReview.score === review.score &&
      routerState.latestReview.summary === review.summary &&
      stringArraysEqual(routerState.latestReview.requiredImprovements, review.requiredImprovements)
    );
  }

  if (routerState.source?.reason === "failed-validation") {
    if (!hasValidationMetadata(routerState.latestValidation)) {
      return false;
    }

    const validation = await state.get<ValidateStoryOutput | null>(
      STORY_STATE_KEYS.latestValidationSummary,
    );
    return (
      !!validation &&
      routerState.latestValidation.summary === validation.summary &&
      validationCommandArraysEqual(routerState.latestValidation.commands, validation.commands)
    );
  }

  return true;
}

function hasReviewMetadata(value: unknown): value is NonNullable<StoryRouterState["latestReview"]> {
  return (
    typeof value === "object" &&
    value !== null &&
    "score" in value &&
    typeof value.score === "number" &&
    "summary" in value &&
    typeof value.summary === "string" &&
    "requiredImprovements" in value &&
    Array.isArray(value.requiredImprovements) &&
    value.requiredImprovements.every((item) => typeof item === "string")
  );
}

function hasValidationMetadata(
  value: unknown,
): value is NonNullable<StoryRouterState["latestValidation"]> {
  return (
    typeof value === "object" &&
    value !== null &&
    "summary" in value &&
    typeof value.summary === "string" &&
    "commands" in value &&
    Array.isArray(value.commands) &&
    value.commands.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "command" in item &&
        typeof item.command === "string" &&
        "result" in item &&
        typeof item.result === "string",
    )
  );
}

function storiesMatch(left: Document, right: Document): boolean {
  return left.path === right.path && left.content === right.content;
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function validationCommandArraysEqual(
  left: readonly { readonly command: string; readonly result: string }[],
  right: readonly { readonly command: string; readonly result: string }[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.command === right[index]?.command && item.result === right[index]?.result,
    )
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function retryStateMismatch(routerState: Partial<StoryRouterState>, activeStory: Document): never {
  throw new StoryRouterFailureError({
    code: "story_router_retry_state_mismatch",
    message:
      "Cannot replay persisted story retry route because durable router state does not match the active story.",
    details: { storyPath: activeStory.path, routerState },
  });
}

function inconsistentRetryState(message: string, details: Record<string, unknown>): never {
  throw new StoryRouterFailureError({
    code: "story_router_inconsistent_retry_state",
    message,
    details,
  });
}

function formatExhaustedRetryRouteFailure(
  routerState: Partial<StoryRouterState>,
  activeStory: Document,
): {
  code: string;
  message: string;
  details: Record<string, unknown>;
} {
  const exhaustedReason =
    routerState.exhaustedReason ?? reasonForSource(routerState.source?.reason);
  const retryCount =
    exhaustedReason === "review" ? routerState.reviewRetryCount : routerState.validationRetryCount;
  return {
    code: routerState.source?.code ?? `story_${exhaustedReason}_exhausted`,
    message: `Story ${exhaustedReason} retry route is already exhausted (${retryCount}/${routerState.retryLimit}).`,
    details: { storyPath: activeStory.path, routerState },
  };
}

function reasonForSource(
  reason: StoryRouterState["source"]["reason"] | undefined,
): "review" | "validation" {
  return reason === "failed-review" ? "review" : "validation";
}

async function persistRetryRouterState(input: {
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

async function loadRouterRetryCounts(input: {
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

function phaseAttemptFallback(
  attemptsByPhase: Record<string, number>,
  phase: "review-story-implementation" | "validate-story" | undefined,
): number {
  if (!phase) {
    return 0;
  }

  return Math.max(0, normalizeRetryCount(attemptsByPhase[phase]) - 1);
}

function normalizeRetryCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function formatBlockedRouteFailure(routerState: StoryRouterState): {
  code: string;
  message: string;
  details: Record<string, unknown>;
} {
  return {
    code: routerState.source.code,
    message: routerState.blockedReason ?? "Story routing is blocked.",
    details: {
      storyPath: routerState.activeStory.path,
      routerState,
      ...formatBlockedRouteFailureDetails(
        routerState.blockedPhase ?? "validate-story",
        routerState.source.metadata,
      ),
    },
  };
}

function formatBlockedRouteFailureDetails(
  blockedPhase: BlockedStoryPhase,
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    blockedPhase,
    ...(metadata ? metadata : {}),
  };
}

async function routeStoryAfterPreflight(activeStory: Document): Promise<ContinuationResult> {
  return storyIsolationPreflightStep({ currentStory: activeStory });
}
