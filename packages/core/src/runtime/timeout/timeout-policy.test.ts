import { describe, expect, it } from "vitest";

import { resolveTimeoutPolicy } from "./timeout-policy.js";

describe("resolveTimeoutPolicy", () => {
  it("resolves timeout policy with step over workflow over global over no built-in timeout", () => {
    const global = 30_000;
    const workflow = 20_000;
    const step = 10_000;

    expect(resolveTimeoutPolicy({ global, workflow, step })).toEqual({ timeoutMs: 10_000 });
    expect(resolveTimeoutPolicy({ global, workflow })).toEqual({ timeoutMs: 20_000 });
    expect(resolveTimeoutPolicy({ global })).toEqual({ timeoutMs: 30_000 });
    expect(resolveTimeoutPolicy({})).toEqual({});
    expect(resolveTimeoutPolicy({ global, workflow, step: undefined })).toEqual({
      timeoutMs: 20_000,
    });
  });

  it("rejects timeout below 1", () => {
    expect(() => resolveTimeoutPolicy({ step: 0 })).toThrow(
      "timeout must be an integer number of milliseconds greater than or equal to 1.",
    );
  });

  it("rejects non-integer timeout", () => {
    expect(() => resolveTimeoutPolicy({ step: 1.5 })).toThrow(
      "timeout must be an integer number of milliseconds greater than or equal to 1.",
    );
  });

  it("rejects the old timeout policy object shape", () => {
    expect(() => resolveTimeoutPolicy({ step: { timeoutMs: 1_000 } as never })).toThrow(
      "timeout must be an integer number of milliseconds greater than or equal to 1.",
    );
  });
});
