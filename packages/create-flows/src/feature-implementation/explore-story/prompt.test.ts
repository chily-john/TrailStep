import { describe, expect, it } from "vitest";
import { exploreStoryPrompt } from "./prompt.js";

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

describe("exploreStoryPrompt", () => {
  it("focuses on exploration without leaking testing or implementation sections", () => {
    const prompt = exploreStoryPrompt({ input: { currentStory: activeStory } });

    expect(prompt).toContain("Story 001: Active widget story");
    expect(prompt).toContain("Explore only this active story");
    expect(prompt).toContain("Acceptance Criteria");
    expect(prompt).not.toContain("Story 002");
    expect(prompt).not.toContain("Red Phase");
    expect(prompt).not.toContain("Green Phase");
    expect(prompt).not.toContain("Validation Commands");
    expect(prompt).not.toContain("widget-exporter.test.ts");
    expect(prompt).not.toContain("Implement the exporter");
    expect(prompt).not.toContain("Review scoring");
  });
});
