import type { Document } from "@trailstep/authoring";
import { fail, state, step } from "@trailstep/authoring";
import type { ContinuationResult } from "@trailstep/core";

import { incrementStoryPhaseAttempt, STORY_STATE_KEYS } from "../shared/story/story-state.js";
import { storyIsolationPreflightStep } from "../story-isolation-preflight/step.js";
import { replayBlockedStoryRoute, replayPersistedRetryRoute } from "./router-replay.js";
import { routeBlockedStory, routeFailedReview, routeFailedValidation } from "./router-routing.js";
import { repairStaleStoryCompletion, takeNextQueuedStory } from "./router-story-state.js";
import type { StoryRouterInput } from "./router-types.js";

export type { StoryRouterInput } from "./router-types.js";

export const storyRouterStep = step({ id: "story-router" }).do(
  async ({ currentStory, reason }: StoryRouterInput): Promise<ContinuationResult> => {
    const previousActivePhase = await state.get<string | null>(STORY_STATE_KEYS.activePhase);
    await state.set(STORY_STATE_KEYS.activePhase, "story-router");
    await incrementStoryPhaseAttempt("story-router");

    if (reason === "failed-review") {
      const replayedRoute = await replayPersistedRetryRoute(
        reason,
        currentStory,
        previousActivePhase,
      );
      if (replayedRoute) {
        return replayedRoute;
      }
      return routeFailedReview(currentStory);
    }
    if (reason === "failed-validation") {
      const replayedRoute = await replayPersistedRetryRoute(
        reason,
        currentStory,
        previousActivePhase,
      );
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

    if (reason === "story-completed") {
      const repairFailure = await repairStaleStoryCompletion(currentStory);
      if (repairFailure) {
        return fail(repairFailure);
      }
    }

    const activeStory =
      currentStory ?? (await state.get<Document | null>(STORY_STATE_KEYS.activeStory));
    if (!activeStory) {
      const nextQueued = await takeNextQueuedStory();
      if (!nextQueued) {
        return fail({
          code: "story_router_no_active_story",
          message:
            "Cannot route story implementation because no active story or queued story is available.",
        });
      }

      await state.set(STORY_STATE_KEYS.activeStory, nextQueued.story);
      await state.set(STORY_STATE_KEYS.activeStoryContext, nextQueued.storyContext);
      return routeStoryAfterPreflight(nextQueued.story);
    }

    await state.set(STORY_STATE_KEYS.activeStory, activeStory);
    return routeStoryAfterPreflight(activeStory);
  },
);

async function routeStoryAfterPreflight(activeStory: Document): Promise<ContinuationResult> {
  return storyIsolationPreflightStep({ currentStory: activeStory });
}
