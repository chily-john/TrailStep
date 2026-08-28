import { describe, expect, it } from "vitest";
import { implementGreenPrompt } from "./prompt.js";

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

describe("implementGreenPrompt", () => {
  it("keeps green implementation scoped to red evidence and implementation sections", () => {
    const prompt = implementGreenPrompt({ input: { currentStory: activeStory, attempt: 1 } });

    expect(prompt).toContain("Story 001: Active widget story");
    expect(prompt).toContain("Green Phase");
    expect(prompt).toContain("smallest production-code slice");
    expect(prompt).toContain("Red evidence");
    expect(prompt).not.toContain("Story 002");
    expect(prompt).not.toContain("Red Phase");
    expect(prompt).not.toContain("widget-exporter.test.ts");
    expect(prompt).not.toContain("Validation Commands");
    expect(prompt).not.toContain("Reviewer responsibilities");
    expect(prompt).not.toContain("Review scoring");
    expect(prompt).not.toContain("SubPrompt");
    expect(prompt).not.toContain("SubPrompts");
    expect(prompt).not.toContain("sub-prompt");
  });
});
