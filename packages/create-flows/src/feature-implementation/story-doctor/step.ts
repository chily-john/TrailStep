import { state, step } from "@trailstep/authoring";
import { incrementStoryPhaseAttempt, STORY_STATE_KEYS } from "../shared/story-state.js";
import { validateStoryStep } from "../validate-story/step.js";
import {
  type StoryDoctorInput,
  type StoryDoctorOutput,
  storyDoctorOutput,
  storyDoctorPrompt,
} from "./prompt.js";

export const storyDoctorStep = step({ id: "story-doctor" })
  .prompt<StoryDoctorInput, StoryDoctorOutput>(storyDoctorPrompt, {
    agent: "storyDoctor",
    output: storyDoctorOutput,
  })
  .do(async (promptOutput, input) => {
    if (promptOutput.blocked) {
      await state.set(
        STORY_STATE_KEYS.blockedReason,
        promptOutput.blockedReason ?? "Story doctor reported a blocked state.",
      );
      const { storyRouterStep } = await import("../story-router/step.js");
      return storyRouterStep({
        reason: {
          type: "blocked",
          sourceReason: "failed-implementation",
          blockedPhase: "implement-green",
          blockedReason: promptOutput.blockedReason ?? "Story doctor reported a blocked state.",
          code: "story_doctor_blocked",
        },
        currentStory: input.currentStory,
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
