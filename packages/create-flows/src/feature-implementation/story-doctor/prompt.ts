import { type Document, jsonSchema, promptSections, section } from "@trailstep/authoring";
import type { ExploreStoryOutput } from "../explore-story/prompt.js";
import type { ImplementGreenOutput } from "../implement-green/prompt.js";
import { storyViewForImplementer } from "../shared/story-view.js";
import type { WriteRedTestsOutput } from "../write-red-tests/prompt.js";

export interface StoryDoctorValidationCommand extends Record<string, unknown> {
  readonly command: string;
  readonly result: string;
}

export interface StoryDoctorInput extends Record<string, unknown> {
  readonly currentStory: Document;
  readonly explorationBrief?: ExploreStoryOutput;
  readonly redTestSummary?: WriteRedTestsOutput;
  readonly implementationSummary?: ImplementGreenOutput;
  readonly failedValidationSummary: string;
  readonly failedValidationCommands: readonly StoryDoctorValidationCommand[];
  readonly validationRetryCount: number;
  readonly retryLimit: number;
}

export interface StoryDoctorOutput extends Record<string, unknown> {
  readonly blocked: boolean;
  readonly blockedReason?: string;
  readonly summary: string;
  readonly changedFiles: readonly string[];
}

export const storyDoctorOutput = jsonSchema<StoryDoctorOutput>({
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

export function storyDoctorPrompt({ input }: { readonly input: StoryDoctorInput }): string {
  const commandEvidence = input.failedValidationCommands
    .map(({ command, result }) => `- ${command}: ${result}`)
    .join("\n");

  return promptSections(
    section(
      "Role",
      "You are the story doctor: a senior recovery agent invoked only after repeated validation failures. Diagnose the actual failing behavior, repair the active story implementation, and do not broaden scope.",
    ),
    section(
      "Active story implementation view",
      storyViewForImplementer(input.currentStory.content),
    ),
    section("Exploration summary", input.explorationBrief?.summary ?? "Not provided."),
    section("Red-test summary", input.redTestSummary?.summary ?? "Not provided."),
    section("Red evidence", input.redTestSummary?.redEvidence ?? "Not provided."),
    section(
      "Latest implementation summary",
      input.implementationSummary?.summary ?? "Not provided.",
    ),
    section(
      "Repeated validation failure",
      [
        `Validation failure count consumed by the router: ${input.validationRetryCount}/${input.retryLimit}.`,
        input.failedValidationSummary,
        "",
        "Command evidence:",
        commandEvidence || "- Not provided.",
      ].join("\n"),
    ),
    section(
      "Task",
      [
        "Find and fix the root cause of the repeated validation failure for this active story only.",
        "Run the focused failing validation command when feasible before returning.",
        "Do not claim success unless the focused validation is green or you clearly explain why it cannot be made green.",
        "If the story is unsafe, ambiguous, or cannot be repaired without unrelated redesign, set `blocked: true` with a concrete `blockedReason`.",
        "Return a concise summary, changed files, and no full logs or diff hunks.",
      ].join("\n"),
    ),
  );
}
