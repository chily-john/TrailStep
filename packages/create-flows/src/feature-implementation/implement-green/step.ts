import { fail, state, step } from "@trailstep/authoring";
import { incrementStoryPhaseAttempt, STORY_STATE_KEYS } from "../shared/story-state.js";
import { validateStoryStep } from "../validate-story/step.js";
import {
  type ImplementGreenInput,
  type ImplementGreenOutput,
  implementGreenOutput,
  implementGreenPrompt,
} from "./prompt.js";

export const implementGreenStep = step({ id: "implement-green" })
  .prompt<ImplementGreenInput, ImplementGreenOutput>(implementGreenPrompt, {
    agent: "storyImplementer",
    output: implementGreenOutput,
  })
  .do(async (promptOutput, input) => {
    if (promptOutput.blocked) {
      await state.set(
        STORY_STATE_KEYS.blockedReason,
        promptOutput.blockedReason ?? "Green implementation reported a blocked state.",
      );
      return fail({
        code: "story_green_blocked",
        message: promptOutput.blockedReason ?? "Green implementation reported a blocked state.",
        details: { storyPath: input.currentStory.path },
      });
    }

    await state.set(STORY_STATE_KEYS.latestImplementationSummary, promptOutput);
    await state.set(STORY_STATE_KEYS.activePhase, "validate-story");
    const attempt = await incrementStoryPhaseAttempt("validate-story");
    return validateStoryStep({
      currentStory: input.currentStory,
      explorationBrief: input.explorationBrief,
      redTestSummary: input.redTestSummary,
      implementationSummary: promptOutput,
      attempt,
    });
  });
