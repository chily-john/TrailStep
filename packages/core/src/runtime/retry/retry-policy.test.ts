import { describe, expect, it } from "vitest";

import { step } from "../../authoring/step/step-node.js";
import { resolveRetryPolicy } from "./retry-policy.js";

describe("resolveRetryPolicy", () => {
  it("resolves retry policy with step over workflow over global over built-in precedence", () => {
    const global = { maxAttempts: 3 };
    const workflow = { maxAttempts: 4 };
    const step = { maxAttempts: 1 };

    expect(resolveRetryPolicy({ global, workflow, step })).toEqual({ maxAttempts: 1 });
    expect(resolveRetryPolicy({ global, workflow })).toEqual({ maxAttempts: 4 });
    expect(resolveRetryPolicy({ global })).toEqual({ maxAttempts: 3 });
    expect(resolveRetryPolicy({})).toEqual({ maxAttempts: 2 });
    expect(resolveRetryPolicy({ global, workflow, step: {} })).toEqual({ maxAttempts: 4 });
  });

  it("rejects maxAttempts below 1", () => {
    expect(() => resolveRetryPolicy({ step: { maxAttempts: 0 } })).toThrow(
      "retry.maxAttempts must be an integer greater than or equal to 1.",
    );
  });

  it("rejects non-integer maxAttempts", () => {
    expect(() => resolveRetryPolicy({ step: { maxAttempts: 1.5 } })).toThrow(
      "retry.maxAttempts must be an integer greater than or equal to 1.",
    );
  });

  it("rejects retry config embedded in prompt options", () => {
    expect(() =>
      step({ id: "prompted" }).prompt("Do work", { retry: { maxAttempts: 3 } } as never),
    ).toThrow("Retry config belongs on step(...), not .prompt(...) options.");
  });
});
