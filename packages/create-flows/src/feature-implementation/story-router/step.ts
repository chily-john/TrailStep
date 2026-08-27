import type { Document } from "@trailstep/authoring";
import { fail, state, step } from "@trailstep/authoring";
import type { ContinuationResult } from "@trailstep/core";
import { incrementStoryPhaseAttempt, STORY_STATE_KEYS } from "../shared/story-state.js";
import { storyIsolationPreflightStep } from "../story-isolation-preflight/step.js";

export interface StoryRouterInput extends Record<string, unknown> {
  readonly reason: "start-story" | "retry-story" | "story-completed";
  readonly currentStory?: Document;
}

export const storyRouterStep = step({ id: "story-router" }).do(
  async ({ currentStory }: StoryRouterInput): Promise<ContinuationResult> => {
    await state.set(STORY_STATE_KEYS.activePhase, "story-router");
    await incrementStoryPhaseAttempt("story-router");

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

async function routeStoryAfterPreflight(activeStory: Document): Promise<ContinuationResult> {
  return storyIsolationPreflightStep({ currentStory: activeStory });
}
