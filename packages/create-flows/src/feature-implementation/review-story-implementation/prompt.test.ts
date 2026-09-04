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
  it("keeps reviewer instructions read-only and renders metadata without diff hunks", () => {
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
          changedFiles: ["src/widget.ts", "src/widget.test.ts"],
          committedChangedFiles: ["src/widget.ts"],
          uncommittedChangedFiles: ["src/widget.test.ts"],
          committedDiffStat: "src/widget.ts | 2 ++",
          uncommittedDiffStat: "src/widget.test.ts | 4 ++++",
          statusShort: " M src/widget.test.ts",
          warnings: [],
        },
      },
    });

    expect(prompt).toContain("Story 001: Active widget story");
    expect(prompt).toContain("Review rubric");
    expect(prompt).toContain("Red Phase");
    expect(prompt).toContain("Green Phase");
    expect(prompt).toContain("Recorded story start commit: abc123");
    expect(prompt).toContain("Changed files:");
    expect(prompt).toContain("- src/widget.ts");
    expect(prompt).toContain("- src/widget.test.ts");
    expect(prompt).toContain("Committed changed files:");
    expect(prompt).toContain("Uncommitted changed files:");
    expect(prompt).toContain("Committed diffstat");
    expect(prompt).toContain("src/widget.ts | 2 ++");
    expect(prompt).toContain("Uncommitted diffstat");
    expect(prompt).toContain("src/widget.test.ts | 4 ++++");
    expect(prompt).toContain("git status --short");
    expect(prompt).toContain("inspect only");
    expect(prompt).toContain("do not edit");
    expect(prompt).toContain("do not stage");
    expect(prompt).toContain("do not commit");
    expect(prompt).toContain("do not clean");
    expect(prompt).toContain("do not run tests");
    expect(prompt).not.toContain("diff --git");
    expect(prompt).not.toContain("@@");
    expect(prompt).not.toContain("COMMITTED_DIFF_PAYLOAD_TOKEN");
    expect(prompt).not.toContain("UNCOMMITTED_DIFF_PAYLOAD_TOKEN");
    expect(prompt).not.toContain("Reviewer responsibilities");
    expect(prompt).not.toContain("Feature workflow methodology");
  });
});
