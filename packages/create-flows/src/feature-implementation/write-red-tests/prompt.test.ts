import { describe, expect, it } from "vitest";
import { writeRedTestsPrompt } from "./prompt.js";

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

describe("writeRedTestsPrompt", () => {
  it("shows the test slice without leaking green implementation or review guidance", () => {
    const prompt = writeRedTestsPrompt({ input: { currentStory: activeStory, attempt: 1 } });

    expect(prompt).toContain("Story 001: Active widget story");
    expect(prompt).toContain("Red Phase");
    expect(prompt).toContain("widget-exporter.test.ts");
    expect(prompt).toContain("must fail for the intended");
    expect(prompt).not.toContain("Story 002");
    expect(prompt).not.toContain("Green Phase");
    expect(prompt).not.toContain("Implement the exporter");
    expect(prompt).not.toContain("Reviewer responsibilities");
    expect(prompt).not.toContain("Review scoring");
    expect(prompt).not.toContain("SubPrompt");
    expect(prompt).not.toContain("SubPrompts");
    expect(prompt).not.toContain("sub-prompt");
  });
});
