import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import type { Event } from "../run-workflow/run-workflow.types.js";

export interface LatestUnresolvedFailure {
  readonly event: Event;
  readonly replayPosition: number;
  readonly sourceFailureEventId?: string;
  readonly workflowId: string;
  readonly workflowInput?: PlainObject;
  readonly stepId?: string;
}

interface ResolvedFailureIdentity {
  readonly eventId?: string;
  readonly replayPosition?: number;
}

export function selectLatestUnresolvedFailure(
  events: readonly Event[],
): LatestUnresolvedFailure | undefined {
  const startedEvent = events.find((event) => event.type === "workflow.started");
  const workflowInput = startedEvent ? readPlainPayload(startedEvent, "input") : undefined;
  const resolvedFailures = events.flatMap((event) =>
    event.type === "workflow.retryStarted" ? readResolvedFailureIdentity(event) : [],
  );

  let workflowFailureFallback: LatestUnresolvedFailure | undefined;
  let laterWorkflowTerminalSeen = false;
  const laterTerminalStepCounts = new Map<string, number>();

  for (let replayPosition = events.length - 1; replayPosition >= 0; replayPosition -= 1) {
    const event = events[replayPosition];
    if (!event) {
      continue;
    }

    if (event.type === "workflow.completed" || event.type === "workflow.cancelled") {
      return undefined;
    }

    if (event.type === "step.completed" || event.type === "step.cancelled") {
      rememberTerminalStep(event, laterTerminalStepCounts);
      continue;
    }

    if (event.type === "step.failed") {
      rememberTerminalStep(event, laterTerminalStepCounts);
      if (isResolvedFailure(event, replayPosition, resolvedFailures)) {
        continue;
      }

      return toLatestUnresolvedFailure(event, replayPosition, workflowInput);
    }

    if (event.type === "workflow.failed") {
      laterWorkflowTerminalSeen = true;
      if (!workflowFailureFallback) {
        if (isResolvedFailure(event, replayPosition, resolvedFailures)) {
          continue;
        }

        workflowFailureFallback = toLatestUnresolvedFailure(event, replayPosition, workflowInput);
      }
      continue;
    }

    if (event.type === "step.started" && event.stepId) {
      if (consumeTerminalStep(event.stepId, laterTerminalStepCounts)) {
        continue;
      }

      if (!laterWorkflowTerminalSeen) {
        if (isResolvedFailure(event, replayPosition, resolvedFailures)) {
          continue;
        }

        return toLatestUnresolvedFailure(event, replayPosition, workflowInput);
      }
    }
  }

  return workflowFailureFallback;
}

function rememberTerminalStep(event: Event, stepCounts: Map<string, number>): void {
  if (event.stepId) {
    stepCounts.set(event.stepId, (stepCounts.get(event.stepId) ?? 0) + 1);
  }
}

function consumeTerminalStep(stepId: string, stepCounts: Map<string, number>): boolean {
  const count = stepCounts.get(stepId) ?? 0;
  if (count <= 0) {
    return false;
  }

  if (count === 1) {
    stepCounts.delete(stepId);
  } else {
    stepCounts.set(stepId, count - 1);
  }
  return true;
}

function readResolvedFailureIdentity(event: Event): readonly ResolvedFailureIdentity[] {
  const { sourceFailureEventId, sourceFailureReplayPosition } = event.payload;
  if (typeof sourceFailureEventId !== "string" && typeof sourceFailureReplayPosition !== "number") {
    return [];
  }

  return [
    {
      eventId: typeof sourceFailureEventId === "string" ? sourceFailureEventId : undefined,
      replayPosition:
        typeof sourceFailureReplayPosition === "number" ? sourceFailureReplayPosition : undefined,
    },
  ];
}

function isResolvedFailure(
  event: Event,
  replayPosition: number,
  resolvedFailures: readonly ResolvedFailureIdentity[],
): boolean {
  return resolvedFailures.some((resolvedFailure) => {
    if (resolvedFailure.replayPosition !== undefined) {
      return resolvedFailure.replayPosition === replayPosition;
    }

    return resolvedFailure.eventId !== undefined && resolvedFailure.eventId === event.id;
  });
}

function toLatestUnresolvedFailure(
  event: Event,
  replayPosition: number,
  workflowInput: PlainObject | undefined,
): LatestUnresolvedFailure {
  return {
    event,
    replayPosition,
    sourceFailureEventId: typeof event.id === "string" ? event.id : undefined,
    workflowId: event.workflowId,
    workflowInput,
    stepId: event.stepId,
  };
}

function readPlainPayload(event: Event, key: string): PlainObject | undefined {
  const value = event.payload[key];
  return isPlainObject(value) ? value : undefined;
}

function isPlainObject(value: unknown): value is PlainObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
