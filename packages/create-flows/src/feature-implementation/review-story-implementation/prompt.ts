import type { Document } from "@trailstep/authoring";
import { loadFragments, promptSections, section } from "@trailstep/authoring";
import type { StoryReviewGitContext } from "../shared/story-state.js";

const fragments = loadFragments(import.meta.dirname, {
  methodology: "../shared/feature-methodology.md",
  storyContract: "../shared/story-implementation-contract.md",
});

export interface ReviewStoryImplementationInput extends Record<string, unknown> {
  readonly currentStory: Document;
  readonly attempt: number;
  readonly implementationSummary?: string;
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
    section("Implementer summary", input.implementationSummary ?? "Not provided."),
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
      "Review only the active story slice represented by the recorded story start commit through HEAD, plus the current uncommitted working tree changes, against the story above and the implementer summary. Prefer the supplied diff/status sections; if you need to inspect locally, use read-only commands only (`git status --short`, the listed `git diff <storyStartCommit>..HEAD`, and `git diff`) — do not run tests, edit code, revert files, clean files, or try to isolate the diff by changing the repository. If unrelated dirty files, a missing/invalid baseline, or ambiguous context prevents a trustworthy review, say so in the structured review and require the implementer/workflow to fix the isolation; never remove changes yourself. Respond only with the structured review.",
    ),
  );
}
