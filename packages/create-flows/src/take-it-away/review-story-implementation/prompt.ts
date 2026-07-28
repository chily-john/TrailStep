import type { Document } from "@stepkit/authoring";
import { promptSections, section } from "@stepkit/authoring";
import methodology from "../shared/feature-methodology.md";
import storyContract from "../shared/story-implementation-contract.md";

export interface ReviewStoryImplementationInput extends Record<string, unknown> {
  readonly currentStory: Document;
  readonly attempt: number;
}

export function reviewStoryImplementationPrompt({
  input,
}: {
  readonly input: ReviewStoryImplementationInput;
}): string {
  return promptSections(
    methodology,
    storyContract,
    section("Story", input.currentStory.content),
    section(
      "Task",
      "Review the current working tree against the story above. Inspect with read-only commands only (`git status --short`, `git diff --stat`, `git diff`) — do not run tests or edit code. Respond only with the structured review.",
    ),
  );
}
