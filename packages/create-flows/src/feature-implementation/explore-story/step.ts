import { fail, state, step } from "@trailstep/authoring";
import { incrementStoryPhaseAttempt, STORY_STATE_KEYS } from "../shared/story-state.js";
import { writeRedTestsStep } from "../write-red-tests/step.js";
import {
  type ExploreStoryInput,
  type ExploreStoryOutput,
  exploreStoryOutput,
  exploreStoryPrompt,
} from "./prompt.js";

export const exploreStoryStep = step({ id: "explore-story" })
  .prompt<ExploreStoryInput, ExploreStoryOutput>(exploreStoryPrompt, {
    agent: "storyExplorer",
    output: exploreStoryOutput,
  })
  .do(async (promptOutput, input) => {
    if (promptOutput.blocked) {
      await state.set(
        STORY_STATE_KEYS.blockedReason,
        promptOutput.blockedReason ?? "Story exploration reported a blocked state.",
      );
      return fail({
        code: "story_exploration_blocked",
        message: promptOutput.blockedReason ?? "Story exploration reported a blocked state.",
        details: { storyPath: input.currentStory.path },
      });
    }

    await state.set(STORY_STATE_KEYS.latestExplorationBrief, promptOutput);
    await state.set(STORY_STATE_KEYS.activePhase, "write-red-tests");
    const attempt = await incrementStoryPhaseAttempt("write-red-tests");
    return writeRedTestsStep({
      currentStory: input.currentStory,
      explorationBrief: promptOutput,
      attempt,
    });
  });
