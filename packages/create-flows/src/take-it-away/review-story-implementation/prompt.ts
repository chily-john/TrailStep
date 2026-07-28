import type { Document } from "@stepkit/sdk";
import { loadFragments, promptSections, section } from "@stepkit/sdk";

const fragments = loadFragments(import.meta.dirname, {
  methodology: "../shared/feature-methodology.md",
  storyContract: "../shared/story-implementation-contract.md",
});

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
    fragments.methodology,
    fragments.storyContract,
    section("Story", input.currentStory.content),
    section(
      "Task",
      "Review the current working tree against the story above. Inspect with read-only commands only (`git status --short`, `git diff --stat`, `git diff`) — do not run tests or edit code. Respond only with the structured review.",
    ),
  );
}
