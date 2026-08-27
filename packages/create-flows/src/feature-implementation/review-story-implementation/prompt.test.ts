import { describe, expect, it } from "vitest";
import { reviewStoryImplementationPrompt } from "./prompt.js";

const activeStory = {
  path: "story-001.md",
  content: [
    "### Story 001: Active widget story",
    "",
    "#### Goal",
    "Build the widget exporter core.",
    "",
    "#### Acceptance Criteria",
    "- Exports widgets through the public API.",
    "",
    "#### Red Phase",
    "Create widget-exporter.test.ts with a failing export assertion.",
    "",
    "#### Green Phase",
    "Implement the exporter.",
    "",
    "#### Validation Commands",
    "pnpm widget:test",
  ].join("\n"),
};

describe("reviewStoryImplementationPrompt", () => {
  it("uses reviewer-only evidence and metadata without full diff bodies", () => {
    const prompt = reviewStoryImplementationPrompt({
      input: {
        currentStory: activeStory,
        attempt: 1,
        explorationSummary: "Relevant files identified.",
        redTestSummary: "Red test created.",
        redEvidence: "pnpm widget:test failed for the intended assertion.",
        implementationSummary: "Implemented exporter.",
        validationSummary: "Focused validation passed.",
        validationCommands: [{ command: "pnpm widget:test", result: "Passed." }],
        gitContext: {
          storyStartCommit: "abc123",
          changedFiles: ["src/widget.ts"],
          committedChangedFiles: ["src/widget.ts"],
          uncommittedChangedFiles: [],
          committedDiffStat: "src/widget.ts | 2 ++",
          uncommittedDiffStat: "",
          statusShort: "",
          warnings: [],
        },
      },
    });

    expect(prompt).toContain("Story 001: Active widget story");
    expect(prompt).toContain("Review rubric");
    expect(prompt).toContain("Red Phase");
    expect(prompt).toContain("Green Phase");
    expect(prompt).toContain("git diff abc123..HEAD");
    expect(prompt).toContain("src/widget.ts | 2 ++");
    expect(prompt).not.toContain("@@");
    expect(prompt).not.toContain("Reviewer responsibilities");
    expect(prompt).not.toContain("Feature workflow methodology");
  });
});
