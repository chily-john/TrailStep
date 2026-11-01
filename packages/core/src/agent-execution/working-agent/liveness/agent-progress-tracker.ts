/**
 * Shared, mutable liveness probe for one in-flight agent attempt.
 *
 * The heartbeat reads it on an interval; the spawn primitive writes to it as the child
 * starts and as output arrives. It exists so `step.progress` can report what is actually
 * happening instead of a self-incremented counter that looks healthy while a provider CLI is
 * wedged.
 */
export interface AgentLivenessSnapshot {
  /** Wall-clock ms since the attempt began, measured from a real clock. */
  readonly elapsedMs: number;
  /** Pid of the child process, when one has been started. */
  readonly pid?: number;
  /** Total bytes of stdout+stderr observed so far. */
  readonly outputBytes: number;
  /** Wall-clock ms since the last output byte arrived, or since start when none has. */
  readonly msSinceLastOutput: number;
  /** Whether the child has been observed to exit. */
  readonly exited: boolean;
}

export interface AgentProgressTracker {
  /** Call once, immediately after `spawn()` returns a pid. Idempotent. */
  readonly markSpawned: (pid: number | undefined) => void;
  /** Call for every stdout/stderr chunk. Cheap; must not throw. */
  readonly recordOutput: (bytes: number) => void;
  /** Call when the child's `close`/`exit` fires. */
  readonly markExited: () => void;
  /** Snapshot for the heartbeat. Pure read. */
  readonly snapshot: (now?: number) => AgentLivenessSnapshot;
  /** true once `stallTimeoutMs` has elapsed with no output and no exit. */
  readonly isStalled: (stallTimeoutMs: number, now?: number) => boolean;
}

export function createAgentProgressTracker(
  options: { readonly startedAt?: number; readonly now?: () => number } = {},
): AgentProgressTracker {
  const now = options.now ?? Date.now;
  const startedAt = options.startedAt ?? now();
  let pid: number | undefined;
  let outputBytes = 0;
  let lastOutputAt = startedAt;
  let exited = false;

  return {
    markSpawned(nextPid) {
      if (nextPid !== undefined && Number.isInteger(nextPid)) {
        pid = nextPid;
      }
    },
    recordOutput(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) {
        return;
      }
      outputBytes += bytes;
      lastOutputAt = now();
    },
    markExited() {
      exited = true;
    },
    snapshot(at) {
      const current = at ?? now();
      return {
        elapsedMs: Math.max(0, current - startedAt),
        outputBytes,
        msSinceLastOutput: Math.max(0, current - lastOutputAt),
        exited,
        ...(pid === undefined ? {} : { pid }),
      };
    },
    isStalled(stallTimeoutMs, at) {
      if (exited || !Number.isFinite(stallTimeoutMs) || stallTimeoutMs <= 0) {
        return false;
      }
      const current = at ?? now();
      return current - lastOutputAt >= stallTimeoutMs;
    },
  };
}
