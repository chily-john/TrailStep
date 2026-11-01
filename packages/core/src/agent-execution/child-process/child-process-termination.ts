import { spawn } from "node:child_process";

/**
 * Terminates a child process and everything it spawned, and resolves only once the direct
 * child has actually exited.
 *
 * Why this exists: the previous implementation fired `taskkill` (Windows) or `SIGTERM`
 * (POSIX) without waiting. A caller that timed out could therefore spawn a replacement agent
 * while the previous one was still running, and both wrote the same `output.json`.
 *
 * Resolution of the returned promise means "the direct child is gone". Descendants on POSIX
 * are signalled via the process group; on Windows `taskkill /T /F` reports when the tree has
 * been terminated.
 */
export interface TerminateChildProcessOptions {
  /** Test seam: the platform to behave as. Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Milliseconds to wait for a clean exit before escalating (POSIX) or giving up. */
  readonly gracefulTimeoutMs?: number;
  /** Total budget for the whole termination. Defaults to 5000 ms. */
  readonly timeoutMs?: number;
  /**
   * Test seam: delivers a signal to the child's process group and reports whether the group
   * was signalled. Defaults to `process.kill(-pid, signal)`. Tests inject this so the POSIX
   * path never signals a real process group.
   */
  readonly signalGroup?: (pid: number, signal: NodeJS.Signals) => boolean;
}

export interface TerminableChild {
  readonly pid?: number | undefined;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  once: (event: "exit", listener: () => void) => unknown;
  off?: (event: "exit", listener: () => void) => unknown;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_GRACEFUL_TIMEOUT_MS = 1_000;
const MIN_SETTLEMENT_BUDGET_MS = 1_000;
const MAX_SETTLEMENT_BUDGET_MS = 5_000;

/** Resolves when the child has exited, or immediately if it already has. */
function waitForExit(child: TerminableChild): Promise<void> {
  if (child.exitCode !== null && child.exitCode !== undefined) {
    return Promise.resolve();
  }
  if (child.signalCode !== null && child.signalCode !== undefined) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    child.once("exit", done);
  });
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    void promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Bounded wait for an already-started settlement to finish, so a caller about to throw or
 * return cannot leave a live child behind for the next attempt to race. The budget is
 * clamped so a tiny step timeout cannot skip termination entirely and a huge one cannot
 * stall shutdown.
 */
export async function withBoundedSettlement(
  settled: Promise<void>,
  timeoutMs: number | undefined,
): Promise<void> {
  const budget = Math.min(
    MAX_SETTLEMENT_BUDGET_MS,
    Math.max(MIN_SETTLEMENT_BUDGET_MS, timeoutMs ?? MAX_SETTLEMENT_BUDGET_MS),
  );
  await Promise.race([
    settled,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, budget);
      timer.unref?.();
    }),
  ]);
}

export async function terminateChildProcessTree(
  child: TerminableChild,
  options: TerminateChildProcessOptions = {},
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || pid === null || pid <= 0) {
    return;
  }

  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS;

  if (platform === "win32") {
    // /T kills the tree, /F forces. Resolve on the taskkill exit so the caller knows the tree
    // was handled; fall back to a direct kill if taskkill is unavailable or fails.
    await withTimeout(
      new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.on("error", () => {
          try {
            child.kill();
          } catch {
            // Already gone.
          }
          resolve();
        });
        killer.on("close", () => resolve());
      }),
      timeoutMs,
    );
    // Bounded on purpose: a child that outlives taskkill must not hang the caller that is
    // already on a failure path.
    await withTimeout(waitForExit(child), timeoutMs);
    return;
  }

  // POSIX: the child was spawned `detached: true`, so it leads its own process group.
  // Signal the group so wrapper scripts and their children die too.
  const signalProcessGroup =
    options.signalGroup ??
    ((targetPid: number, signal: NodeJS.Signals): boolean => {
      try {
        process.kill(-targetPid, signal);
        return true;
      } catch {
        return false;
      }
    });
  const signalGroup = (signal: NodeJS.Signals): boolean => signalProcessGroup(pid, signal);

  const signalled = signalGroup("SIGTERM");
  if (!signalled) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }

  const exitedCleanly = await Promise.race([
    waitForExit(child).then(() => true),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), gracefulTimeoutMs);
      timer.unref?.();
    }),
  ]);

  if (!exitedCleanly) {
    const killedGroup = signalGroup("SIGKILL");
    if (!killedGroup) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await withTimeout(waitForExit(child), timeoutMs);
  }
}
