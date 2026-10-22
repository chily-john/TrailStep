import type { Document } from "@trailstep/authoring";
import { state } from "@trailstep/authoring";
import type { Failure } from "@trailstep/core";

import { extractStoryTitle } from "../../shared/output-schema.js";
import {
  resetStoryLocalStateForNextStory,
  STORY_STATE_KEYS,
  type StoryPhaseContexts,
} from "../shared/story/story-state.js";
import { storiesMatch } from "./router-state.js";

/**
 * Story-state handling for the router: repairs a stale story completion and
 * selects the next active story (and its context) from the durable queue.
 */
export async function repairStaleStoryCompletion(
  currentStory?: Document,
): Promise<Failure | undefined> {
  if (!currentStory) {
    return undefined;
  }

  const persistedActiveStory = await state.get<Document | null>(STORY_STATE_KEYS.activeStory);
  if (!persistedActiveStory || storiesMatch(persistedActiveStory, currentStory)) {
    return undefined;
  }

  const storyQueue = (await state.get<Document[]>(STORY_STATE_KEYS.storyQueue)) ?? [];
  const queuedCurrentStoryIndex = storyQueue.findIndex((story) =>
    storiesMatch(story, currentStory),
  );
  if (queuedCurrentStoryIndex !== 0) {
    return {
      code: "story_router_stale_completion_mismatch",
      message:
        "Cannot repair stale story completion state because the routed next story is not the immediate queued successor.",
      details: {
        persistedActiveStoryPath: persistedActiveStory.path,
        currentStoryPath: currentStory.path,
        queuedCurrentStoryIndex,
        queuedStoryPaths: storyQueue.map((story) => story.path),
      },
    };
  }

  const completed = (await state.get<string[]>(STORY_STATE_KEYS.completedStories)) ?? [];
  const completedTitle = extractStoryTitle(persistedActiveStory.content, completed.length + 1);
  await resetStoryLocalStateForNextStory();
  await state.set(
    STORY_STATE_KEYS.completedStories,
    completed.includes(completedTitle) ? completed : [...completed, completedTitle],
  );
  await state.set(STORY_STATE_KEYS.storyQueue, storyQueue.slice(1));

  const storyContextQueue =
    (await state.get<(string | StoryPhaseContexts)[]>(STORY_STATE_KEYS.storyContextQueue)) ?? [];
  await state.set(STORY_STATE_KEYS.storyContextQueue, storyContextQueue.slice(1));
  await state.set(STORY_STATE_KEYS.activeStory, currentStory);
  await state.set(STORY_STATE_KEYS.activeStoryContext, storyContextQueue[0] ?? "");
  return undefined;
}

export interface NextQueuedStory {
  readonly story: Document;
  readonly storyContext: string | StoryPhaseContexts;
}

/**
 * Takes the next story (and its context) off the durable queue, or returns
 * `undefined` when the queue is empty.
 */
export async function takeNextQueuedStory(): Promise<NextQueuedStory | undefined> {
  const [nextStory, ...remaining] =
    (await state.get<Document[]>(STORY_STATE_KEYS.storyQueue)) ?? [];
  if (!nextStory) {
    return undefined;
  }

  const [nextStoryContext = "", ...remainingStoryContexts] =
    (await state.get<(string | StoryPhaseContexts)[]>(STORY_STATE_KEYS.storyContextQueue)) ?? [];
  await state.set(STORY_STATE_KEYS.storyQueue, remaining);
  await state.set(STORY_STATE_KEYS.storyContextQueue, remainingStoryContexts);
  return { story: nextStory, storyContext: nextStoryContext };
}
