import { type Document, jsonSchema, promptSections, section } from "@trailstep/authoring";
import type { ExploreStoryOutput } from "../explore-story/prompt.js";
import methodologyFragment from "../shared/feature-methodology.md?raw";
import storyImplementationContractFragment from "../shared/story-implementation-contract.md?raw";

export interface WriteRedTestsInput extends Record<string, unknown> {
  readonly currentStory: Document;
  readonly explorationBrief?: ExploreStoryOutput;
  readonly attempt: number;
}

export interface WriteRedTestsOutput extends Record<string, unknown> {
  readonly blocked: boolean;
  readonly blockedReason?: string;
  readonly summary: string;
  readonly redEvidence: string;
  readonly changedFiles: readonly string[];
}

export const writeRedTestsOutput = jsonSchema<WriteRedTestsOutput>({
  type: "object",
  properties: {
    blocked: { type: "boolean" },
    blockedReason: { type: "string" },
    summary: { type: "string" },
    redEvidence: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
  },
  required: ["blocked", "summary", "redEvidence", "changedFiles"],
  additionalProperties: false,
});

export function writeRedTestsPrompt({ input }: { readonly input: WriteRedTestsInput }): string {
  return promptSections(
    methodologyFragment.trimEnd(),
    storyImplementationContractFragment.trimEnd(),
    section("Active story", input.currentStory.content),
    section("Exploration summary", input.explorationBrief?.summary ?? "Not provided."),
    section(
      "Task",
      [
        "Write or update the focused behavioral red test for only this active story.",
        "Use strict behavioral-red TDD: the test must fail for the intended product/integration behavior before green implementation.",
        "Do not implement production code except the absolute minimum needed to compile the red test harness.",
        "Run the focused red test when feasible and report the failing command/output in `redEvidence`.",
        "Do not include unrelated stories or broaden into review.",
        "If a safe red test cannot be written, set `blocked: true` and explain why.",
      ].join("\n"),
    ),
  );
}
