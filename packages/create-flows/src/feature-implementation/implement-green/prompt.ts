import { type Document, jsonSchema, promptSections, section } from "@trailstep/authoring";
import type { ExploreStoryOutput } from "../explore-story/prompt.js";
import methodologyFragment from "../shared/feature-methodology.md?raw";
import projectArchitectureGuidanceFragment from "../shared/project-architecture-guidance.md?raw";
import storyImplementationContractFragment from "../shared/story-implementation-contract.md?raw";
import type { WriteRedTestsOutput } from "../write-red-tests/prompt.js";

export interface ImplementGreenValidationCommand extends Record<string, unknown> {
  readonly command: string;
  readonly result: string;
}

export interface ImplementGreenInput extends Record<string, unknown> {
  readonly currentStory: Document;
  readonly explorationBrief?: ExploreStoryOutput;
  readonly redTestSummary?: WriteRedTestsOutput;
  readonly attempt: number;
  readonly previousReviewSummary?: string;
  readonly requiredImprovements?: readonly string[];
  readonly failedValidationSummary?: string;
  readonly failedValidationCommands?: readonly ImplementGreenValidationCommand[];
}

export interface ImplementGreenOutput extends Record<string, unknown> {
  readonly blocked: boolean;
  readonly blockedReason?: string;
  readonly summary: string;
  readonly changedFiles: readonly string[];
}

export const implementGreenOutput = jsonSchema<ImplementGreenOutput>({
  type: "object",
  properties: {
    blocked: { type: "boolean" },
    blockedReason: { type: "string" },
    summary: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
  },
  required: ["blocked", "summary", "changedFiles"],
  additionalProperties: false,
});

export function implementGreenPrompt({ input }: { readonly input: ImplementGreenInput }): string {
  const validationCommandEvidence = (input.failedValidationCommands ?? [])
    .map(({ command, result }) => `- ${command}: ${result}`)
    .join("\n");

  return promptSections(
    methodologyFragment.trimEnd(),
    projectArchitectureGuidanceFragment.trimEnd(),
    storyImplementationContractFragment.trimEnd(),
    section("Active story", input.currentStory.content),
    section("Exploration summary", input.explorationBrief?.summary ?? "Not provided."),
    section("Red-test summary", input.redTestSummary?.summary ?? "Not provided."),
    section("Red evidence", input.redTestSummary?.redEvidence ?? "Not provided."),
    input.previousReviewSummary
      ? section(
          "Previous review summary",
          `${input.previousReviewSummary}\n\nRequired improvements:\n${(input.requiredImprovements ?? []).map((item) => `- ${item}`).join("\n") || "- None"}`,
        )
      : "",
    input.failedValidationSummary
      ? section(
          "Previous validation failure",
          `${input.failedValidationSummary}\n\nCommand evidence:\n${validationCommandEvidence || "- Not provided."}`,
        )
      : "",
    section(
      "Task",
      [
        "Implement the smallest production-code slice needed to make the focused behavioral red test pass.",
        "Continue strict behavioral-red TDD: preserve the red test and do not skip straight to broad refactoring.",
        "Do not write new unrelated stories, broad polish, or accumulated-diff cleanup.",
        "Run the focused green test when feasible and summarize files changed plus evidence.",
        "If implementation is unsafe or ambiguous, set `blocked: true` and explain why.",
      ].join("\n"),
    ),
  );
}
