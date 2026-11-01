import { describe, expect, it } from "vitest";

import type { TerminableChild } from "./child-process-termination.js";
import { killAllLiveChildren, liveChildCount, trackLiveChild } from "./live-children.js";

/**
 * A pid no real process group can own, so the POSIX group signal used by the registry can
 * never reach a real process in these tests.
 */
const PHANTOM_PID = 2_147_483_646;

class FakeChild implements TerminableChild {
  readonly pid = PHANTOM_PID;
  /** Starts exited so termination is a fast no-op on both platforms. */
  exitCode: number | null = 0;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  private readonly listeners: Array<() => void> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    this.exitCode = 0;
    for (const listener of [...this.listeners]) {
      listener();
    }
    return true;
  }

  once(_event: "exit", listener: () => void): this {
    this.listeners.push(listener);
    return this;
  }
}

describe("live children registry", () => {
  it("tracks and untracks a child, and untracking twice is safe", () => {
    const before = liveChildCount();
    const untrack = trackLiveChild(new FakeChild());
    expect(liveChildCount()).toBe(before + 1);

    untrack();
    expect(liveChildCount()).toBe(before);

    untrack();
    expect(liveChildCount()).toBe(before);
  });

  it("terminates every tracked child and empties the registry", async () => {
    const children = [new FakeChild(), new FakeChild()];
    const untrackers = children.map((child) => trackLiveChild(child));
    expect(liveChildCount()).toBe(2);

    try {
      await killAllLiveChildren();
      expect(liveChildCount()).toBe(0);
    } finally {
      for (const untrack of untrackers) {
        untrack();
      }
    }
  });
});
