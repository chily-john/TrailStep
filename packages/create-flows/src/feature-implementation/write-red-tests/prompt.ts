import { type Document, jsonSchema, promptSections, section } from "@trailstep/authoring";
import type { ExploreStoryOutput } from "../explore-story/prompt.js";
import { storyViewForTestWriter } from "../shared/story-view.js";

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
    section(
      "Role",
      "You are the red-test writer. Create focused behavioral failing tests; do not implement production behavior or review the story.",
    ),
    section("Active story test view", storyViewForTestWriter(input.currentStory.content)),
    section("Exploration summary", input.explorationBrief?.summary ?? "Not provided."),
    section(
      "Exploration test seams",
      input.explorationBrief?.testSeams?.map((item) => `- ${item}`).join("\n") ?? "Not provided.",
    ),
    section(
      "Task",
      [
        "Write or update the focused behavioral red test for only this active story.",
        "The test must fail for the intended product/integration behavior before green implementation.",
        "Do not implement production code except the absolute minimum needed to compile the red test harness.",
        "Run the focused red test when feasible and report only the command plus concise failing evidence in `redEvidence`.",
        "Do not include unrelated stories, green implementation work, or review scoring.",
        "If a safe red test cannot be written, set `blocked: true` and explain why.",
      ].join("\n"),
    ),
  );
}
