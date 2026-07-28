import { fail, step } from "@stepkit/sdk";
import { reviewStoryImplementationStep } from "../review-story-implementation/step.js";
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
  .do((promptOutput, input) => {
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
    });
  });
