import { describe, expect, it } from "vitest";
import { implementGreenPrompt } from "./prompt.js";

const activeStory = {
  path: "story-001.md",
  content: "## Story 001: Active widget story\n\nBuild the widget exporter core.",
};

describe("implementGreenPrompt", () => {
  it("keeps green implementation scoped to behavioral-red TDD evidence", () => {
    const prompt = implementGreenPrompt({ input: { currentStory: activeStory, attempt: 1 } });

    expect(prompt).toContain("Story 001: Active widget story");
    expect(prompt).toContain("strict behavioral-red TDD");
    expect(prompt).toContain("smallest production-code slice");
    expect(prompt).not.toContain("Story 002");
  });
});
