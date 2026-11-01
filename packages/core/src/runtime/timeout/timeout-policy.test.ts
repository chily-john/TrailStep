import { describe, expect, it } from "vitest";

import { resolveStallPolicy, resolveTimeoutPolicy } from "./timeout-policy.js";

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

describe("resolveStallPolicy", () => {
  it("has no built-in default", () => {
    const policy = resolveStallPolicy({});

    expect(policy).toEqual({});
    expect(policy.stallTimeoutMs).toBeUndefined();
  });

  it("resolves stall policy with step over workflow over global", () => {
    expect(resolveStallPolicy({ global: 30_000, workflow: 20_000, step: 10_000 })).toEqual({
      stallTimeoutMs: 10_000,
    });
    expect(resolveStallPolicy({ global: 30_000, workflow: 20_000 })).toEqual({
      stallTimeoutMs: 20_000,
    });
    expect(resolveStallPolicy({ global: 30_000 })).toEqual({ stallTimeoutMs: 30_000 });
    expect(resolveStallPolicy({ global: 30_000, workflow: 20_000, step: undefined })).toEqual({
      stallTimeoutMs: 20_000,
    });
  });

  it("rejects invalid stall timeouts", () => {
    for (const value of [0, -1, 1.5, "1000", true]) {
      expect(() => resolveStallPolicy({ step: value })).toThrow(TypeError);
      expect(() => resolveStallPolicy({ step: value })).toThrow(/stallTimeout/);
    }
  });
});
