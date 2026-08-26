import { describe, expect, it } from "vitest";
import { validateStoryPrompt } from "./prompt.js";

const activeStory = {
  path: "story-001.md",
  content: "## Story 001: Active widget story\n\nBuild the widget exporter core.",
};

describe("validateStoryPrompt", () => {
  it("asks for command results instead of broad review", () => {
    const prompt = validateStoryPrompt({ input: { currentStory: activeStory, attempt: 1 } });

    expect(prompt).toContain("Story 001: Active widget story");
    expect(prompt).toContain("Run focused validation commands");
    expect(prompt).toContain("commands");
    expect(prompt).toContain("do not perform a broad code review");
    expect(prompt).not.toContain("Story 002");
  });
});
