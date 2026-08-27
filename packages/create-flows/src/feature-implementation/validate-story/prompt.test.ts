import { describe, expect, it } from "vitest";
import { validateStoryPrompt } from "./prompt.js";

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

describe("validateStoryPrompt", () => {
  it("asks for focused command results without test-writing, implementation, or review context", () => {
    const prompt = validateStoryPrompt({ input: { currentStory: activeStory, attempt: 1 } });

    expect(prompt).toContain("Story 001: Active widget story");
    expect(prompt).toContain("Run focused validation commands");
    expect(prompt).toContain("commands");
    expect(prompt).toContain("Validation Commands");
    expect(prompt).toContain("pnpm widget:test");
    expect(prompt).toContain("do not perform a broad code review");
    expect(prompt).not.toContain("Story 002");
    expect(prompt).not.toContain("Red Phase");
    expect(prompt).not.toContain("Green Phase");
    expect(prompt).not.toContain("widget-exporter.test.ts");
    expect(prompt).not.toContain("Implement the exporter");
    expect(prompt).not.toContain("Review scoring");
  });
});
