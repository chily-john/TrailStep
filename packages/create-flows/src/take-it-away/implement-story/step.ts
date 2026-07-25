import type { StepNode } from "@stepkit/core";
import { type Document, fail, state, step } from "@stepkit/sdk";
import { reviewStoryImplementationStep } from "../review-story-implementation/step.js";
import type { ReviewResult } from "../shared/review-schema.js";
import {
  type ImplementStoryInput,
  type ImplementStoryOutput,
  implementStoryOutput,
  implementStoryPrompt,
} from "./prompt.js";

export async function implementStoryStep(): Promise<StepNode> {
  const storyQueue = (await state.get<Document[]>("storyQueue")) ?? [];
  const currentStory = storyQueue[0];
  if (!currentStory) {
    throw new Error("implement-story: storyQueue is empty in state.");
  }
  const previousStoryReview = await state.get<ReviewResult>("storyReview");
  const attempt = (await state.get<number>("storyReviewAttempts")) ?? 1;

  const promptInput: ImplementStoryInput = { currentStory, previousStoryReview, attempt };

  return step({ id: "implement-story" })
    .prompt<ImplementStoryInput, ImplementStoryOutput>(implementStoryPrompt, {
      agent: "implementer",
      output: implementStoryOutput,
    })
    .do((output) => {
      if (output.blocked) {
        return fail({
          code: "story_blocked",
          message: output.blockedReason ?? "Story implementation reported a blocked state.",
          details: { storyPath: currentStory.path },
        });
      }

      return reviewStoryImplementationStep();
    })(promptInput);
}
