import { type Document, jsonSchema, list, promptSections, section } from "@trailstep/authoring";
import { storyViewForExplorer } from "../shared/story-view.js";

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
    section(
      "Role",
      "You are the story explorer. Gather only the facts later agents need; do not plan tests, edit files, validate, or review.",
    ),
    section("Active story view", storyViewForExplorer(input.currentStory.content)),
    section("Implementation context", input.implementationContext),
    section(
      "Task",
      [
        "Explore only this active story and the local architecture needed to implement it.",
        "Read project guidance and nearby source only when needed to identify conventions, affected files, and seams.",
        "Do not implement code, write tests, run validation, or review the solution in this phase.",
        "Return concise evidence: relevant files, likely behavioral seams, and focused validation command hints.",
        "If the story is unsafe or ambiguous, set `blocked: true` and explain why.",
        "Recommended commands should be narrow and executable by later validation.",
        "Use arrays for relevantFiles, testSeams, and recommendedValidationCommands.",
        "Do not include unrelated stories or copy large source/diff excerpts.",
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
