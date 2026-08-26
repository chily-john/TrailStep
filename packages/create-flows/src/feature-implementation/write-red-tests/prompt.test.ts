import { describe, expect, it } from "vitest";
import { writeRedTestsPrompt } from "./prompt.js";

const activeStory = {
  path: "story-001.md",
  content: "## Story 001: Active widget story\n\nBuild the widget exporter core.",
};

describe("writeRedTestsPrompt", () => {
  it("requires behavioral-red TDD for only the active story", () => {
    const prompt = writeRedTestsPrompt({ input: { currentStory: activeStory, attempt: 1 } });

    expect(prompt).toContain("Story 001: Active widget story");
    expect(prompt).toContain("strict behavioral-red TDD");
    expect(prompt).toContain("must fail for the intended");
    expect(prompt).not.toContain("Story 002");
  });
});
