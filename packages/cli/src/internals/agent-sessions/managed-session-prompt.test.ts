import { describe, expect, it } from "vitest";

import { buildManagedSessionPrompt } from "./managed-session-prompt.js";

describe("buildManagedSessionPrompt", () => {
  it("builds TrailStep managed-session handoff and dense-description instructions", () => {
    const prompt = buildManagedSessionPrompt();

    for (const phrase of [
      "opened by TrailStep",
      "session export tool",
      "dense session description",
      "decisions made",
      "constraints",
      "rejected options",
      "assumptions",
      "files touched/inspected",
      "commands run",
      "APIs/package names",
      "examples",
      "user preferences",
      "open questions",
      "implementation context useful to another agent",
    ]) {
      expect(prompt).toContain(phrase);
    }
  });
});
