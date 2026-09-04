import { state, step } from "@trailstep/authoring";
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
    agent: "validator",
    output: validateStoryOutput,
  })
  .do(async (promptOutput, input) => {
    await state.set(STORY_STATE_KEYS.latestValidationSummary, promptOutput);
    if (promptOutput.blocked) {
      await state.set(
        STORY_STATE_KEYS.blockedReason,
        promptOutput.blockedReason ?? "Story validation reported a blocked state.",
      );
      const { storyRouterStep } = await import("../story-router/step.js");
      return storyRouterStep({
        reason: {
          type: "blocked",
          sourceReason: "failed-validation",
          blockedPhase: "validate-story",
          blockedReason: promptOutput.blockedReason ?? "Story validation reported a blocked state.",
          code: "story_validation_blocked",
          metadata: { validation: promptOutput },
        },
        currentStory: input.currentStory,
      });
    }

    if (!promptOutput.validationPassed) {
      const { storyRouterStep } = await import("../story-router/step.js");
      return storyRouterStep({ reason: "failed-validation", currentStory: input.currentStory });
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
