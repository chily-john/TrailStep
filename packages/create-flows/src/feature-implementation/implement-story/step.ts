import { fail, step } from "@stepkit/authoring";
import { reviewStoryImplementationStep } from "../review-story-implementation/step.js";
import { loadStoryReviewGitContext } from "../shared/story-state.js";
import {
  type ImplementStoryInput,
  type ImplementStoryOutput,
  implementStoryOutput,
  implementStoryPrompt,
} from "./prompt.js";

export const implementStoryStep = step({ id: "implement-story" })
  .prompt<ImplementStoryInput, ImplementStoryOutput>(implementStoryPrompt, {
    agent: "implementer",
    output: implementStoryOutput,
  })
  .do(async (promptOutput, input) => {
    if (promptOutput.blocked) {
      return fail({
        code: "story_blocked",
        message: promptOutput.blockedReason ?? "Story implementation reported a blocked state.",
        details: { storyPath: input.currentStory.path },
      });
    }

    return reviewStoryImplementationStep({
      currentStory: input.currentStory,
      attempt: input.attempt,
      gitContext: await loadStoryReviewGitContext(),
    });
  });
