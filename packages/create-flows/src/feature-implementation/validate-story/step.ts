import { fail, state, step } from "@trailstep/authoring";
import { reviewStoryImplementationStep } from "../review-story-implementation/step.js";
import {
  incrementStoryPhaseAttempt,
  loadStoryReviewGitContext,
  STORY_STATE_KEYS,
} from "../shared/story-state.js";
import {
  type ValidateStoryInput,
  type ValidateStoryOutput,
  validateStoryOutput,
  validateStoryPrompt,
} from "./prompt.js";

export const validateStoryStep = step({ id: "validate-story" })
  .prompt<ValidateStoryInput, ValidateStoryOutput>(validateStoryPrompt, {
    agent: "implementer",
    output: validateStoryOutput,
  })
  .do(async (promptOutput, input) => {
    await state.set(STORY_STATE_KEYS.latestValidationSummary, promptOutput);
    if (promptOutput.blocked || !promptOutput.validationPassed) {
      await state.set(
        STORY_STATE_KEYS.blockedReason,
        promptOutput.blockedReason ?? "Story validation did not pass.",
      );
      return fail({
        code: "story_validation_failed",
        message: promptOutput.blockedReason ?? "Story validation did not pass.",
        details: { storyPath: input.currentStory.path, validation: promptOutput },
      });
    }

    await state.set(STORY_STATE_KEYS.activePhase, "review-story-implementation");
    await incrementStoryPhaseAttempt("review-story-implementation");
    return reviewStoryImplementationStep({
      currentStory: input.currentStory,
      attempt: input.attempt,
      implementationSummary: input.implementationSummary?.summary,
      explorationSummary: input.explorationBrief?.summary,
      redTestSummary: input.redTestSummary?.summary,
      redEvidence: input.redTestSummary?.redEvidence,
      validationSummary: promptOutput.summary,
      validationCommands: promptOutput.commands,
      gitContext: await loadStoryReviewGitContext(),
    });
  });
