import type { Document } from "@stepkit/authoring";
import { loadFragments, promptSections, section } from "@stepkit/authoring";
import type { StoryReviewGitContext } from "../shared/story-state.js";

const fragments = loadFragments(import.meta.dirname, {
  methodology: "../shared/feature-methodology.md",
  storyContract: "../shared/story-implementation-contract.md",
});

export interface ReviewStoryImplementationInput extends Record<string, unknown> {
  readonly currentStory: Document;
  readonly attempt: number;
  readonly gitContext: StoryReviewGitContext;
}

export function reviewStoryImplementationPrompt({
  input,
}: {
  readonly input: ReviewStoryImplementationInput;
}): string {
  const committedDiffCommand = input.gitContext.storyStartCommit
    ? `git diff ${input.gitContext.storyStartCommit}..HEAD`
    : "git diff <missing-story-start-commit>..HEAD";

  return promptSections(
    fragments.methodology,
    fragments.storyContract,
    section("Story", input.currentStory.content),
    section(
      "Story review git baseline",
      [
        `Recorded story start commit: ${input.gitContext.storyStartCommit ?? "MISSING"}`,
        `Inspect committed story changes with: \`${committedDiffCommand}\``,
        "Inspect uncommitted working tree changes with: `git diff`",
        "Inspect status with: `git status --short`",
        input.gitContext.warnings.length > 0
          ? [
              "",
              "Warnings / blocked context:",
              ...input.gitContext.warnings.map((warning) => `- ${warning}`),
            ].join("\n")
          : "",
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
    ),
    section(
      "Committed story changes (`git diff <storyStartCommit>..HEAD`)",
      input.gitContext.committedDiff ?? "Not available.",
    ),
    section(
      "Uncommitted working tree changes (`git diff`)",
      input.gitContext.uncommittedDiff ?? "Not available.",
    ),
    section(
      "Working tree status (`git status --short`)",
      input.gitContext.statusShort ?? "Not available.",
    ),
    section(
      "Task",
      "Review the full story slice from the recorded story start commit through HEAD, plus the current uncommitted working tree changes, against the story above. Use read-only commands only (`git status --short`, the listed `git diff <storyStartCommit>..HEAD`, and `git diff`) — do not run tests or edit code. If the baseline is missing, invalid, or unreachable, explicitly account for that blocked context instead of silently reviewing only the current working tree diff. Respond only with the structured review.",
    ),
  );
}
