import type { Document } from "@trailstep/authoring";
import { state } from "@trailstep/authoring";
import type { Failure } from "@trailstep/core";

import type { ReviewResult } from "../shared/story/review-schema.js";
import {
  type BlockedStoryPhase,
  STORY_STATE_KEYS,
  type StoryRouterState,
} from "../shared/story/story-state.js";
import type { ValidateStoryOutput } from "../validate-story/prompt.js";

export class StoryRouterFailureError extends Error {
  readonly failure: Failure;

  constructor(failure: Failure) {
    super(failure.message);
    this.name = "StoryRouterFailureError";
    this.failure = failure;
  }
}

export function retryStateMismatch(
  routerState: Partial<StoryRouterState>,
  activeStory: Document,
): never {
  throw new StoryRouterFailureError({
    code: "story_router_retry_state_mismatch",
    message:
      "Cannot replay persisted story retry route because durable router state does not match the active story.",
    details: { storyPath: activeStory.path, routerState },
  });
}

export function inconsistentRetryState(message: string, details: Record<string, unknown>): never {
  throw new StoryRouterFailureError({
    code: "story_router_inconsistent_retry_state",
    message,
    details,
  });
}

export function formatExhaustedRetryRouteFailure(
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

export function reasonForSource(
  reason: StoryRouterState["source"]["reason"] | undefined,
): "review" | "validation" {
  return reason === "failed-review" ? "review" : "validation";
}

export function formatBlockedRouteFailure(routerState: StoryRouterState): {
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

export function hasReviewMetadata(
  value: unknown,
): value is NonNullable<StoryRouterState["latestReview"]> {
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

export function hasValidationMetadata(
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

export function storiesMatch(left: Document, right: Document): boolean {
  return left.path === right.path && left.content === right.content;
}

export function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function validationCommandArraysEqual(
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

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function normalizeRetryCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function phaseAttemptFallback(
  attemptsByPhase: Record<string, number>,
  phase: "review-story-implementation" | "validate-story" | undefined,
): number {
  if (!phase) {
    return 0;
  }

  return Math.max(0, normalizeRetryCount(attemptsByPhase[phase]) - 1);
}

/**
 * Compares the durable router state's captured review/validation evidence
 * with the latest persisted evidence to detect stale retry routes.
 */
export async function routerStateEvidenceMatchesLatest(
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
