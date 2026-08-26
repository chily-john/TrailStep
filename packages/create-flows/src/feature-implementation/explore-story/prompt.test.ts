import { describe, expect, it } from "vitest";
import { exploreStoryPrompt } from "./prompt.js";

const activeStory = {
  path: "story-001.md",
  content: "## Story 001: Active widget story\n\nBuild the widget exporter core.",
};

describe("exploreStoryPrompt", () => {
  it("focuses on the active story without unrelated stories", () => {
    const prompt = exploreStoryPrompt({ input: { currentStory: activeStory } });

    expect(prompt).toContain("Story 001: Active widget story");
    expect(prompt).toContain("Explore only this active story");
    expect(prompt).not.toContain("Story 002");
    expect(prompt).not.toContain("all unrelated stories");
  });
});
