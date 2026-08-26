import { type Document, jsonSchema, promptSections, section } from "@trailstep/authoring";
import type { ExploreStoryOutput } from "../explore-story/prompt.js";
import type { ImplementGreenOutput } from "../implement-green/prompt.js";
import type { WriteRedTestsOutput } from "../write-red-tests/prompt.js";

export interface ValidateStoryInput extends Record<string, unknown> {
  readonly currentStory: Document;
  readonly explorationBrief?: ExploreStoryOutput;
  readonly redTestSummary?: WriteRedTestsOutput;
  readonly implementationSummary?: ImplementGreenOutput;
  readonly attempt: number;
}

export interface ValidationCommandResult extends Record<string, unknown> {
  readonly command: string;
  readonly result: string;
}

export interface ValidateStoryOutput extends Record<string, unknown> {
  readonly blocked: boolean;
  readonly blockedReason?: string;
  readonly summary: string;
  readonly commands: readonly ValidationCommandResult[];
  readonly validationPassed: boolean;
}

export const validateStoryOutput = jsonSchema<ValidateStoryOutput>({
  type: "object",
  properties: {
    blocked: { type: "boolean" },
    blockedReason: { type: "string" },
    summary: { type: "string" },
    commands: {
      type: "array",
      items: {
        type: "object",
        properties: { command: { type: "string" }, result: { type: "string" } },
        required: ["command", "result"],
        additionalProperties: false,
      },
    },
    validationPassed: { type: "boolean" },
  },
  required: ["blocked", "summary", "commands", "validationPassed"],
  additionalProperties: false,
});

export function validateStoryPrompt({ input }: { readonly input: ValidateStoryInput }): string {
  return promptSections(
    section("Active story", input.currentStory.content),
    section("Exploration summary", input.explorationBrief?.summary ?? "Not provided."),
    section("Red-test evidence", input.redTestSummary?.redEvidence ?? "Not provided."),
    section("Implementation summary", input.implementationSummary?.summary ?? "Not provided."),
    section(
      "Task",
      [
        "Validate this active story implementation; do not perform a broad code review.",
        "Run focused validation commands and record each command with its result in `commands`.",
        "Prefer the exploration-recommended commands and the package-focused checks for this story.",
        "Set `validationPassed: true` only when the focused story validation passes.",
        "If commands cannot be run or fail, set `blocked: true` or `validationPassed: false` with concise evidence.",
        "Do not include full diff hunks or unrelated stories.",
      ].join("\n"),
    ),
  );
}
