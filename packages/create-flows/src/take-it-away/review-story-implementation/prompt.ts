import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Document } from "@stepkit/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const methodology = readFileSync(join(here, "../shared/feature-methodology.md"), "utf8");
const storyContract = readFileSync(
  join(here, "../shared/story-implementation-contract.md"),
  "utf8",
);

export interface ReviewStoryImplementationInput extends Record<string, unknown> {
  readonly currentStory: Document;
}

export function reviewStoryImplementationPrompt({
  input,
}: {
  readonly input: ReviewStoryImplementationInput;
}): string {
  return [
    methodology,
    "",
    storyContract,
    "",
    "## Story",
    "",
    input.currentStory.content,
    "",
    "## Task",
    "",
    "Review the current working tree against the story above. Inspect with read-only commands only (`git status --short`, `git diff --stat`, `git diff`) — do not run tests or edit code. Respond only with the structured review.",
  ].join("\n");
}
