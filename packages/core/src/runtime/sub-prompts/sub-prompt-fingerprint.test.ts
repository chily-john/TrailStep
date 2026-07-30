import { describe, expect, it } from "vitest";

import { fingerprintSubPrompt } from "./sub-prompt-fingerprint.js";

describe("fingerprintSubPrompt", () => {
  it("is stable for object key order and changes when prompt text changes", () => {
    const left = fingerprintSubPrompt({
      input: { beta: { two: 2, one: 1 }, alpha: "a" },
      prompt: "Choose alpha",
    });
    const right = fingerprintSubPrompt({
      input: { alpha: "a", beta: { one: 1, two: 2 } },
      prompt: "Choose alpha",
    });
    const changedPrompt = fingerprintSubPrompt({
      input: { alpha: "a", beta: { one: 1, two: 2 } },
      prompt: "Choose beta",
    });

    expect(left).toBe(right);
    expect(changedPrompt).not.toBe(left);
  });
});
