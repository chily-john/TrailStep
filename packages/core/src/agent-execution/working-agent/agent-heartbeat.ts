import { createEvent } from "../../runtime/events/create-run-event.js";
import type { Event } from "../../runtime/run-workflow/run-workflow.types.js";
import type {
  AgentLivenessSnapshot,
  AgentProgressTracker,
} from "./liveness/agent-progress-tracker.js";

const DEFAULT_AGENT_HEARTBEAT_INTERVAL_MS = 60_000;

function resolveAgentHeartbeatIntervalMs(): number | undefined {
  const raw = process.env.TRAILSTEP_AGENT_HEARTBEAT_INTERVAL_MS;
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

export interface AgentHeartbeat {
  readonly stop: () => void;
}

export interface StartAgentHeartbeatOptions {
  readonly emit: (event: Event) => Promise<void>;
  readonly runId: string;
  readonly workflowId: string;
  readonly stepId?: string;
  readonly describe: () => string;
  readonly intervalMs?: number;
  /** Optional live probe. When omitted the heartbeat reports elapsed time only. */
  readonly tracker?: AgentProgressTracker;
  /** Opt-in. When set, a stalled attempt emits one `agent.stalled` event. */
  readonly stallTimeoutMs?: number;
  /** Called once when the attempt is first observed as stalled. */
  readonly onStall?: (snapshot: AgentLivenessSnapshot) => void;
}

/**
 * Starts a best-effort agent heartbeat while a long-running agent-kind step
 * is in flight. Fires a `step.progress` event on the interval so long-running
 * work surfaces progress. When a tracker is supplied the elapsed time and the
 * output liveness fields come from the real attempt instead of an interval
 * counter; otherwise the heartbeat falls back to the counter alone. A
 * configured `stallTimeoutMs` reports one `agent.stalled` event and invokes
 * `onStall` once for the first stalled observation. Emit failures are
 * tolerated and the timer is unref'd so it never keeps the process alive on
 * its own. A non-positive interval (or `TRAILSTEP_AGENT_HEARTBEAT_INTERVAL_MS=0`)
 * disables the heartbeat.
 */
export function startAgentHeartbeat(options: StartAgentHeartbeatOptions): AgentHeartbeat {
  const intervalMs =
    options.intervalMs ?? resolveAgentHeartbeatIntervalMs() ?? DEFAULT_AGENT_HEARTBEAT_INTERVAL_MS;

  if (intervalMs <= 0) {
    return { stop: () => undefined };
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let elapsedMs = 0;
  let stallReported = false;

  const emitHeartbeat = async (
    currentElapsedMs: number,
    snapshot: AgentLivenessSnapshot | undefined,
  ): Promise<void> => {
    try {
      await options.emit(
        createEvent({
          runId: options.runId,
          workflowId: options.workflowId,
          ...(options.stepId === undefined ? {} : { stepId: options.stepId }),
          type: "step.progress",
          payload: {
            message: `${options.describe()} still running (elapsed ${currentElapsedMs})`,
            data:
              snapshot === undefined
                ? { heartbeat: true, elapsedMs: currentElapsedMs }
                : {
                    heartbeat: true,
                    elapsedMs: currentElapsedMs,
                    outputBytes: snapshot.outputBytes,
                    msSinceLastOutput: snapshot.msSinceLastOutput,
                    exited: snapshot.exited,
                    ...(snapshot.pid === undefined ? {} : { pid: snapshot.pid }),
                  },
          },
        }),
      );
    } catch {
      // Heartbeats are best-effort progress signals; never surface emit failures.
    }
  };

  const emitStalled = async (snapshot: AgentLivenessSnapshot): Promise<void> => {
    try {
      await options.emit(
        createEvent({
          runId: options.runId,
          workflowId: options.workflowId,
          ...(options.stepId === undefined ? {} : { stepId: options.stepId }),
          type: "agent.stalled",
          payload: {
            message: `${options.describe()} produced no output for ${Math.round(snapshot.msSinceLastOutput)}ms`,
            data: { ...snapshot, stallTimeoutMs: options.stallTimeoutMs },
          },
        }),
      );
    } catch {
      // Stall reporting is best-effort, exactly like the heartbeat itself.
    }
  };

  const reportStallOnce = (snapshot: AgentLivenessSnapshot | undefined): void => {
    const stallTimeoutMs = options.stallTimeoutMs;
    if (
      stallReported ||
      snapshot === undefined ||
      stallTimeoutMs === undefined ||
      options.tracker?.isStalled(stallTimeoutMs) !== true
    ) {
      return;
    }

    stallReported = true;
    void emitStalled(snapshot);
    try {
      options.onStall?.(snapshot);
    } catch {
      // A throwing stall observer must not kill the heartbeat timer.
    }
  };

  const tick = (): void => {
    if (stopped) {
      return;
    }
    elapsedMs += intervalMs;
    const snapshot = options.tracker?.snapshot();
    void emitHeartbeat(snapshot === undefined ? elapsedMs : snapshot.elapsedMs, snapshot);
    reportStallOnce(snapshot);
    if (!stopped) {
      timer = setTimeout(tick, intervalMs);
      timer.unref?.();
    }
  };

  timer = setTimeout(tick, intervalMs);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
