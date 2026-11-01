import { describe, expect, it } from "vitest";

import {
  type TerminableChild,
  terminateChildProcessTree,
  withBoundedSettlement,
} from "./child-process-termination.js";

/**
 * A pid no real process group can own, so the *uninjected* POSIX group kill used by
 * `live-children.ts` can never hit a real process if a test forgets to inject the seam.
 */
const PHANTOM_PID = 2_147_483_646;

interface FakeChildOptions {
  readonly pid?: number | undefined;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  /** Emit `exit` as soon as a signal is delivered (cooperative child). */
  readonly exitsOnSignal?: boolean;
  /** Make `kill` throw `ESRCH` (the child is already gone). */
  readonly killThrows?: boolean;
}

class FakeChild implements TerminableChild {
  readonly pid: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  exitListenerCalls = 0;
  private readonly listeners: Array<() => void> = [];
  private readonly exitsOnSignal: boolean;
  private readonly killThrows: boolean;

  constructor(options: FakeChildOptions = {}) {
    this.pid = "pid" in options ? options.pid : PHANTOM_PID;
    this.exitCode = options.exitCode ?? null;
    this.signalCode = options.signalCode ?? null;
    this.exitsOnSignal = options.exitsOnSignal ?? false;
    this.killThrows = options.killThrows ?? false;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.killThrows) {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    }
    this.signals.push(signal);
    this.maybeExit();
    return true;
  }

  once(_event: "exit", listener: () => void): this {
    this.exitListenerCalls += 1;
    this.listeners.push(listener);
    return this;
  }

  off(_event: "exit", listener: () => void): this {
    const index = this.listeners.indexOf(listener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
    return this;
  }

  emitExit(): void {
    this.exitCode = 0;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  private maybeExit(): void {
    if (this.exitsOnSignal) {
      this.emitExit();
    }
  }
}

describe("terminateChildProcessTree", () => {
  it("returns immediately when the child has no usable pid", async () => {
    for (const pid of [undefined, 0, -1]) {
      const child = new FakeChild({ pid, exitsOnSignal: true });
      await terminateChildProcessTree(child, { platform: "linux", gracefulTimeoutMs: 5 });
      expect(child.signals).toEqual([]);
      expect(child.exitListenerCalls).toBe(0);
    }
  });

  it("does not wait on POSIX for a child that already exited", async () => {
    const child = new FakeChild({ exitCode: 0 });
    const startedAt = Date.now();

    await terminateChildProcessTree(child, {
      platform: "linux",
      gracefulTimeoutMs: 5_000,
      signalGroup: () => true,
    });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    // Already exited: no `exit` listener is attached, so nothing can hang.
    expect(child.exitListenerCalls).toBe(0);
  });

  it("resolves within gracefulTimeoutMs when the child exits after SIGTERM", async () => {
    const child = new FakeChild({ exitsOnSignal: true });
    const groupSignals: NodeJS.Signals[] = [];

    await terminateChildProcessTree(child, {
      platform: "linux",
      gracefulTimeoutMs: 1_000,
      signalGroup: (_pid, signal) => {
        groupSignals.push(signal);
        child.emitExit();
        return true;
      },
    });

    expect(groupSignals).toEqual(["SIGTERM"]);
    expect(child.signals).toEqual([]);
  });

  it("escalates to SIGKILL when SIGTERM is ignored, then resolves", async () => {
    const child = new FakeChild();
    const groupSignals: NodeJS.Signals[] = [];

    await terminateChildProcessTree(child, {
      platform: "linux",
      gracefulTimeoutMs: 20,
      timeoutMs: 200,
      signalGroup: (_pid, signal) => {
        groupSignals.push(signal);
        if (signal === "SIGKILL") {
          child.emitExit();
        }
        return true;
      },
    });

    expect(groupSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("falls back to killing the child directly when the process group is gone", async () => {
    const child = new FakeChild({ exitsOnSignal: true });

    await terminateChildProcessTree(child, {
      platform: "linux",
      gracefulTimeoutMs: 20,
      timeoutMs: 200,
      signalGroup: () => false,
    });

    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("resolves on the win32 path even when the child never emits exit", async () => {
    const child = new FakeChild({ pid: PHANTOM_PID });
    const startedAt = Date.now();

    // `taskkill` may be missing or may refuse the pid; the bounded wait is what keeps this
    // call from hanging while the child is still alive.
    await terminateChildProcessTree(child, {
      platform: "win32",
      gracefulTimeoutMs: 20,
      timeoutMs: 60,
    });

    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("never rejects when the child is already gone", async () => {
    const child = new FakeChild({ killThrows: true });

    await expect(
      terminateChildProcessTree(child, {
        platform: "linux",
        gracefulTimeoutMs: 10,
        timeoutMs: 100,
        signalGroup: () => false,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("withBoundedSettlement", () => {
  it("resolves as soon as the tracked settlement settles", async () => {
    const startedAt = Date.now();
    await withBoundedSettlement(Promise.resolve(), 5_000);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("gives up after a bounded budget when the settlement never arrives", async () => {
    const startedAt = Date.now();
    await withBoundedSettlement(new Promise<void>(() => {}), 1);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
