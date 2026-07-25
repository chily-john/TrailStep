import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Document, jsonSchema } from "@stepkit/sdk";
import type { ReviewResult } from "../shared/review-schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const methodology = readFileSync(join(here, "../shared/feature-methodology.md"), "utf8");
const storyContract = readFileSync(
  join(here, "../shared/story-implementation-contract.md"),
  "utf8",
);
const architectureGuidance = readFileSync(
  join(here, "../shared/project-architecture-guidance.md"),
  "utf8",
);

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
  return [
    methodology,
    "",
    architectureGuidance,
    "",
    storyContract,
    "",
    "## Story",
    "",
    input.currentStory.content,
    "",
    "## Task",
    "",
    ...(input.previousStoryReview === undefined
      ? ["Implement this story."]
      : [
          `This is retry attempt ${input.attempt} for this story. A previous review scored the implementation ${input.previousStoryReview.score}/5: ${input.previousStoryReview.summary}`,
          "",
          "Required improvements to address, without discarding what already works:",
          "",
          ...input.previousStoryReview.requiredImprovements.map(
            (improvement) => `- ${improvement}`,
          ),
        ]),
    "",
    "Set `blocked: true` with a clear `blockedReason` instead of guessing or pretending the story is complete. Otherwise set `blocked: false` and use `summary` to report files changed, commands run, and their results.",
  ].join("\n");
}
