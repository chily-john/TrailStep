import { type Document, jsonSchema, list, promptSections, section } from "@stepkit/authoring";
import type { ReviewResult } from "../shared/review-schema.js";
import methodology from "../shared/feature-methodology.md";
import architectureGuidance from "../shared/project-architecture-guidance.md";
import storyContract from "../shared/story-implementation-contract.md";

export interface ImplementStoryInput extends Record<string, unknown> {
  readonly currentStory: Document;
  readonly attempt: number;
  readonly previousStoryReview?: ReviewResult;
}

export interface ImplementStoryOutput extends Record<string, unknown> {
  readonly blocked: boolean;
  readonly blockedReason?: string;
  readonly summary: string;
}

export const implementStoryOutput = jsonSchema<ImplementStoryOutput>({
  type: "object",
  properties: {
    blocked: { type: "boolean" },
    blockedReason: { type: "string" },
    summary: {
      type: "string",
      description: "Files changed, commands run, and their results.",
    },
  },
  required: ["blocked", "summary"],
  additionalProperties: false,
});

export function implementStoryPrompt({ input }: { readonly input: ImplementStoryInput }): string {
  const taskBody =
    input.previousStoryReview === undefined
      ? "Implement this story."
      : promptSections(
          `This is retry attempt ${input.attempt} for this story. A previous review scored the implementation ${input.previousStoryReview.score}/5: ${input.previousStoryReview.summary}`,
          `Required improvements to address, without discarding what already works:\n\n${list(input.previousStoryReview.requiredImprovements)}`,
        );

  return promptSections(
    methodology,
    architectureGuidance,
    storyContract,
    section("Story", input.currentStory.content),
    section(
      "Task",
      `${taskBody}\n\nSet \`blocked: true\` with a clear \`blockedReason\` instead of guessing or pretending the story is complete. Otherwise set \`blocked: false\` and use \`summary\` to report files changed, commands run, and their results.`,
    ),
  );
}
