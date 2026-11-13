import type { Event } from "../../contracts/events/event.types.js";

/**
 * One lifecycle-cycle rule shared by every run-state consumer.
 *
 * A run can be reopened after a terminal/cancelled cycle: `workflow.resumed`
 * (continue after a failure or wait) and `workflow.retryStarted` (manual retry)
 * both start a new lifecycle cycle. The current cycle starts immediately after
 * the most recent reopen event, so an earlier cycle's terminal, cancellation or
 * pending wait must never decide the current state.
 *
 * Keep this module leaf-like: it imports only the event contract so the
 * classifier, run summaries, evidence queries and the runtime can all depend on
 * it without creating an import cycle.
 */

export type LifecycleReopenEventType = "workflow.resumed" | "workflow.retryStarted";

export type LifecycleTerminalState = "completed" | "failed" | "cancelled";

export interface LifecycleTerminal {
  readonly state: LifecycleTerminalState;
  readonly event: Event;
}

/** True when this event reopens the run and starts a new lifecycle cycle. */
export function isLifecycleReopenEvent(
  event: Pick<Event, "type">,
): event is Event & { readonly type: LifecycleReopenEventType } {
  return event.type === "workflow.resumed" || event.type === "workflow.retryStarted";
}

/**
 * Index of the first event of the run's current lifecycle cycle: everything
 * after the most recent reopen event, or zero when the run was never reopened.
 */
export function findLifecycleCycleStartIndex(events: readonly Event[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && isLifecycleReopenEvent(event)) {
      return index + 1;
    }
  }
  return 0;
}

/** Events belonging to the current lifecycle cycle, in trail order. */
export function selectCurrentLifecycleCycle(events: readonly Event[]): readonly Event[] {
  return events.slice(findLifecycleCycleStartIndex(events));
}

/**
 * The current cycle's terminal event, if any. Scanning backwards means the
 * newest terminal event wins when a trail contains more than one; callers must
 * pass the cycle window when they want current-cycle semantics.
 */
export function findLifecycleTerminalEvent(
  events: readonly Event[],
): LifecycleTerminal | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "workflow.completed") {
      return { state: "completed", event };
    }
    if (event?.type === "workflow.failed") {
      return { state: "failed", event };
    }
    if (event?.type === "workflow.cancelled") {
      return { state: "cancelled", event };
    }
  }
  return undefined;
}
