import { state, step } from "@trailstep/authoring";
import { implementGreenStep } from "../implement-green/step.js";
import { incrementStoryPhaseAttempt, STORY_STATE_KEYS } from "../shared/story-state.js";
import {
  type WriteRedTestsInput,
  type WriteRedTestsOutput,
  writeRedTestsOutput,
  writeRedTestsPrompt,
} from "./prompt.js";

export const writeRedTestsStep = step({ id: "write-red-tests" })
  .prompt<WriteRedTestsInput, WriteRedTestsOutput>(writeRedTestsPrompt, {
    agent: "testWriter",
    output: writeRedTestsOutput,
  })
  .do(async (promptOutput, input) => {
    if (promptOutput.blocked) {
      await state.set(
        STORY_STATE_KEYS.blockedReason,
        promptOutput.blockedReason ?? "Red-test phase reported a blocked state.",
      );
      const { storyRouterStep } = await import("../story-router/step.js");
      return storyRouterStep({
        reason: {
          type: "blocked",
          sourceReason: "failed-red-tests",
          blockedPhase: "write-red-tests",
          blockedReason: promptOutput.blockedReason ?? "Red-test phase reported a blocked state.",
          code: "story_red_tests_blocked",
        },
        currentStory: input.currentStory,
      });
    }

    await state.set(STORY_STATE_KEYS.latestRedTestSummary, promptOutput);
    await state.set(STORY_STATE_KEYS.activePhase, "implement-green");
    const attempt = await incrementStoryPhaseAttempt("implement-green");
    return implementGreenStep({
      currentStory: input.currentStory,
      explorationBrief: input.explorationBrief,
      redTestSummary: promptOutput,
      attempt,
    });
  });
