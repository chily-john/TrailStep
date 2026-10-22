import { createEvent } from "../../runtime/events/create-run-event.js";
import type { Event } from "../../runtime/run-workflow/run-workflow.types.js";

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

/**
 * Starts a best-effort agent heartbeat while a long-running agent-kind step
 * is in flight. Fires a `step.progress` event on the interval so long-running
 * work surfaces progress. Emit failures are tolerated and the timer is unref'd
 * so it never keeps the process alive on its own. A non-positive interval (or
 * `TRAILSTEP_AGENT_HEARTBEAT_INTERVAL_MS=0`) disables the heartbeat.
 */
export function startAgentHeartbeat(options: {
  readonly emit: (event: Event) => Promise<void>;
  readonly runId: string;
  readonly workflowId: string;
  readonly stepId?: string;
  readonly describe: () => string;
  readonly intervalMs?: number;
}): AgentHeartbeat {
  const intervalMs =
    options.intervalMs ?? resolveAgentHeartbeatIntervalMs() ?? DEFAULT_AGENT_HEARTBEAT_INTERVAL_MS;

  if (intervalMs <= 0) {
    return { stop: () => undefined };
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let elapsedMs = 0;

  const emitHeartbeat = async (elapsedMs: number): Promise<void> => {
    try {
      await options.emit(
        createEvent({
          runId: options.runId,
          workflowId: options.workflowId,
          ...(options.stepId === undefined ? {} : { stepId: options.stepId }),
          type: "step.progress",
          payload: {
            message: `${options.describe()} still running (elapsed ${elapsedMs})`,
            data: { heartbeat: true, elapsedMs },
          },
        }),
      );
    } catch {
      // Heartbeats are best-effort progress signals; never surface emit failures.
    }
  };

  const tick = (): void => {
    if (stopped) {
      return;
    }
    elapsedMs += intervalMs;
    void emitHeartbeat(elapsedMs);
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
