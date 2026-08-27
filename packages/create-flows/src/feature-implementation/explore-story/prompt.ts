import { type Document, jsonSchema, list, promptSections, section } from "@trailstep/authoring";
import methodologyFragment from "../shared/feature-methodology.md?raw";
import projectArchitectureGuidanceFragment from "../shared/project-architecture-guidance.md?raw";

export interface ExploreStoryInput extends Record<string, unknown> {
  readonly currentStory: Document;
  readonly implementationContext?: string;
}

export interface ExploreStoryOutput extends Record<string, unknown> {
  readonly blocked: boolean;
  readonly blockedReason?: string;
  readonly summary: string;
  readonly relevantFiles: readonly string[];
  readonly testSeams: readonly string[];
  readonly recommendedValidationCommands: readonly string[];
}

export const exploreStoryOutput = jsonSchema<ExploreStoryOutput>({
  type: "object",
  properties: {
    blocked: { type: "boolean" },
    blockedReason: { type: "string" },
    summary: { type: "string" },
    relevantFiles: { type: "array", items: { type: "string" } },
    testSeams: { type: "array", items: { type: "string" } },
    recommendedValidationCommands: { type: "array", items: { type: "string" } },
  },
  required: ["blocked", "summary", "relevantFiles", "testSeams", "recommendedValidationCommands"],
  additionalProperties: false,
});

export function exploreStoryPrompt({ input }: { readonly input: ExploreStoryInput }): string {
  return promptSections(
    methodologyFragment.trimEnd(),
    projectArchitectureGuidanceFragment.trimEnd(),
    section("Active story", input.currentStory.content),
    section("Implementation context", input.implementationContext),
    section(
      "Task",
      [
        "Explore only this active story and the local architecture needed to implement it.",
        "Do not implement code or write tests in this phase.",
        "Return concise evidence: relevant files, behavioral test seams, and focused validation commands.",
        "If the story is unsafe or ambiguous, set `blocked: true` and explain why.",
        "Recommended commands should be narrow and executable by later validation.",
        "Use arrays for relevantFiles, testSeams, and recommendedValidationCommands.",
        "Do not include unrelated stories.",
      ].join("\n"),
    ),
    section(
      "Default validation command hints",
      list([
        "pnpm --filter @trailstep/create-flows test",
        "pnpm --filter @trailstep/create-flows typecheck",
        "pnpm --filter @trailstep/create-flows lint",
      ]),
    ),
  );
}
