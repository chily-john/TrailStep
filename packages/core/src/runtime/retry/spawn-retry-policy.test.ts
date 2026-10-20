import { describe, expect, it } from "vitest";

import {
  BUILT_IN_SPAWN_RETRY_POLICY,
  resolveSpawnRetryPolicy,
  spawnRetryDelayMs,
  validateSpawnRetryPolicy,
} from "./spawn-retry-policy.js";

describe("validateSpawnRetryPolicy", () => {
  it("fills built-in defaults for an empty input", () => {
    expect(validateSpawnRetryPolicy({})).toEqual(BUILT_IN_SPAWN_RETRY_POLICY);
  });

  it("keeps explicitly configured values", () => {
    expect(
      validateSpawnRetryPolicy({ maxAttempts: 6, baseDelayMs: 0, factor: 2, maxDelayMs: 5 }),
    ).toEqual({ maxAttempts: 6, baseDelayMs: 0, factor: 2, maxDelayMs: 5 });
  });

  it("rejects invalid values", () => {
    expect(() => validateSpawnRetryPolicy({ maxAttempts: 0 })).toThrow(TypeError);
    expect(() => validateSpawnRetryPolicy({ maxAttempts: 1.5 })).toThrow(TypeError);
    expect(() => validateSpawnRetryPolicy({ baseDelayMs: -1 })).toThrow(TypeError);
    expect(() => validateSpawnRetryPolicy({ factor: 0.5 })).toThrow(TypeError);
    expect(() => validateSpawnRetryPolicy({ maxDelayMs: Number.NaN })).toThrow(TypeError);
  });
});

describe("resolveSpawnRetryPolicy", () => {
  it("prefers step over workflow over global", () => {
    const policy = resolveSpawnRetryPolicy({
      global: { maxAttempts: 2 },
      workflow: { maxAttempts: 3 },
      step: { maxAttempts: 5 },
    });
    expect(policy.maxAttempts).toBe(5);

    expect(
      resolveSpawnRetryPolicy({ global: { maxAttempts: 2 }, workflow: { maxAttempts: 3 } }),
    ).toMatchObject({ maxAttempts: 3 });
    expect(resolveSpawnRetryPolicy({ global: { maxAttempts: 2 } })).toMatchObject({
      maxAttempts: 2,
    });
  });

  it("falls back to built-in defaults", () => {
    expect(resolveSpawnRetryPolicy()).toEqual(BUILT_IN_SPAWN_RETRY_POLICY);
  });
});

describe("spawnRetryDelayMs", () => {
  const policy = { maxAttempts: 4, baseDelayMs: 1000, factor: 3, maxDelayMs: 60_000 };

  it("grows exponentially with equal jitter between half and full nominal", () => {
    expect(spawnRetryDelayMs(policy, 1, () => 0)).toBe(500);
    expect(spawnRetryDelayMs(policy, 1, () => 1)).toBe(1000);
    expect(spawnRetryDelayMs(policy, 2, () => 0)).toBe(1500);
    expect(spawnRetryDelayMs(policy, 2, () => 1)).toBe(3000);
    expect(spawnRetryDelayMs(policy, 3, () => 1)).toBe(9000);
  });

  it("caps the nominal delay", () => {
    expect(spawnRetryDelayMs(policy, 10, () => 1)).toBe(60_000);
    expect(spawnRetryDelayMs(policy, 10, () => 0)).toBe(30_000);
  });
});
