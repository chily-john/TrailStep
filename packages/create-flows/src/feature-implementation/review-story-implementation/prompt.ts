import type { Document } from "@trailstep/authoring";
import { promptSections, section } from "@trailstep/authoring";
import methodologyFragment from "../shared/feature-methodology.md?raw";
import storyImplementationContractFragment from "../shared/story-implementation-contract.md?raw";
import type { StoryReviewGitContext } from "../shared/story-state.js";

const fragments = {
  methodology: methodologyFragment.trimEnd(),
  storyContract: storyImplementationContractFragment.trimEnd(),
};

export interface ReviewStoryImplementationInput extends Record<string, unknown> {
  readonly currentStory: Document;
  readonly attempt: number;
  readonly explorationSummary?: string;
  readonly redTestSummary?: string;
  readonly redEvidence?: string;
  readonly implementationSummary?: string;
  readonly validationSummary?: string;
  readonly validationCommands?: readonly { readonly command: string; readonly result: string }[];
  readonly gitContext: StoryReviewGitContext;
}

export function reviewStoryImplementationPrompt({
  input,
}: {
  readonly input: ReviewStoryImplementationInput;
}): string {
  const baseline = input.gitContext.storyStartCommit ?? "MISSING";
  const committedDiffCommand = input.gitContext.storyStartCommit
    ? `git diff ${input.gitContext.storyStartCommit}..HEAD`
    : "git diff <missing-story-start-commit>..HEAD";

  return promptSections(
    fragments.methodology,
    fragments.storyContract,
    section("Story", input.currentStory.content),
    section("Exploration summary", input.explorationSummary ?? "Not provided."),
    section("Red-test summary", input.redTestSummary ?? "Not provided."),
    section("Red-test evidence", input.redEvidence ?? "Not provided."),
    section("Implementer summary", input.implementationSummary ?? "Not provided."),
    section("Validation summary", input.validationSummary ?? "Not provided."),
    section("Validation commands/results", formatCommandResults(input.validationCommands ?? [])),
    section(
      "Story review git metadata",
      [
        `Recorded story start commit: ${baseline}`,
        "",
        "Changed files:",
        formatList(input.gitContext.changedFiles),
        "",
        "Committed changed files:",
        formatList(input.gitContext.committedChangedFiles),
        "",
        "Uncommitted changed files:",
        formatList(input.gitContext.uncommittedChangedFiles),
        "",
        "Committed diffstat (`git diff --stat <storyStartCommit>..HEAD`):",
        input.gitContext.committedDiffStat || "Not available.",
        "",
        "Uncommitted diffstat (`git diff --stat`):",
        input.gitContext.uncommittedDiffStat || "Not available.",
        "",
        "Working tree status (`git status --short`):",
        input.gitContext.statusShort || "Not available.",
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
      "Read-only local inspection commands",
      [
        "Run only read-only inspection commands if local verification is needed:",
        "- `git status --short`",
        `- \`${committedDiffCommand}\``,
        "- `git diff`",
        "Use the captured validation commands/results above; do not run tests yourself.",
      ].join("\n"),
    ),
    section(
      "Task",
      "Review only the active story slice represented by the recorded story start commit through HEAD, plus the current uncommitted working tree changes, against the story above and the implementer summary. Use the metadata above first; if you need to inspect locally, use read-only commands only (`git status --short`, the listed committed `git diff <storyStartCommit>..HEAD`, and `git diff`) — do not run tests, edit code, stage files, commit files, revert files, clean files, or try to isolate the diff by changing the repository. If unrelated dirty files, a missing/invalid baseline, or ambiguous context prevents a trustworthy review, say so in the structured review and require the implementer/workflow to fix the isolation; never remove changes yourself. Respond only with the structured review.",
    ),
  );
}

function formatList(items: readonly string[]): string {
  if (items.length === 0) {
    return "- None";
  }

  return items.map((item) => `- ${item}`).join("\n");
}

function formatCommandResults(
  commands: readonly { readonly command: string; readonly result: string }[],
): string {
  if (commands.length === 0) {
    return "- Not provided.";
  }

  return commands.map((item) => `- \`${item.command}\`: ${item.result}`).join("\n");
}
