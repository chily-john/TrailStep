import { describe, expect, it } from "vitest";

import { createAgentProgressTracker } from "./agent-progress-tracker.js";

describe("createAgentProgressTracker", () => {
  it("reports a fresh attempt as started but silent", () => {
    let current = 1_000;
    const tracker = createAgentProgressTracker({ startedAt: 1_000, now: () => current });

    current = 1_250;
    const snapshot = tracker.snapshot();

    expect(snapshot.outputBytes).toBe(0);
    expect(snapshot.msSinceLastOutput).toBe(snapshot.elapsedMs);
    expect(snapshot.exited).toBe(false);
  });

  it("measures silence from the last output rather than from the start", () => {
    let current = 0;
    const tracker = createAgentProgressTracker({ startedAt: 0, now: () => current });

    current = 500;
    tracker.recordOutput(10);
    current = 1_100;

    const snapshot = tracker.snapshot();
    expect(snapshot.outputBytes).toBe(10);
    expect(snapshot.msSinceLastOutput).toBe(600);
    expect(snapshot.elapsedMs).toBe(1_100);
  });

  it("ignores zero, negative and non-finite output sizes", () => {
    let current = 0;
    const tracker = createAgentProgressTracker({ startedAt: 0, now: () => current });

    tracker.recordOutput(0);
    tracker.recordOutput(-5);
    tracker.recordOutput(Number.NaN);
    current = 900;

    const snapshot = tracker.snapshot();
    expect(snapshot.outputBytes).toBe(0);
    expect(snapshot.msSinceLastOutput).toBe(900);
  });

  it("surfaces a spawned pid and tolerates an undefined one", () => {
    let current = 0;
    const tracker = createAgentProgressTracker({ startedAt: 0, now: () => current });

    tracker.markSpawned(undefined);
    expect(tracker.snapshot().pid).toBeUndefined();

    tracker.markSpawned(4_242);
    current = 10;
    expect(tracker.snapshot().pid).toBe(4_242);
  });

  it("treats an exited child as done, never stalled", () => {
    let current = 0;
    const tracker = createAgentProgressTracker({ startedAt: 0, now: () => current });

    tracker.markExited();
    current = 60_000;

    expect(tracker.snapshot().exited).toBe(true);
    expect(tracker.isStalled(1_000)).toBe(false);
  });

  it("is stalled only once the configured silence elapses", () => {
    let current = 0;
    const tracker = createAgentProgressTracker({ startedAt: 0, now: () => current });

    current = 999;
    expect(tracker.isStalled(1_000)).toBe(false);

    current = 1_000;
    expect(tracker.isStalled(1_000)).toBe(true);
  });

  it("never reports a stall for disabled thresholds", () => {
    let current = 0;
    const tracker = createAgentProgressTracker({ startedAt: 0, now: () => current });

    current = 60_000;
    expect(tracker.isStalled(0)).toBe(false);
    expect(tracker.isStalled(-1)).toBe(false);
  });
});
