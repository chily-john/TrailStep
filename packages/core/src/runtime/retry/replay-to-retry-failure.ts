import type { StepNode } from "../../authoring/step/continuation.types.js";
import type { Failure } from "../../contracts/failures/failure.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import { replayCompletedSteps } from "../resume/replay-completed-steps/replay-completed-steps.js";
import type { Event, RunWorkflowOptions } from "../run-workflow/run-workflow.types.js";
import { selectLatestUnresolvedFailure } from "./latest-unresolved-failure.js";

export async function replayToRetryFailure<
  TInput extends PlainObject,
  TOutput extends PlainObject,
>(options: {
  readonly workflow: RunWorkflowOptions<TInput, TOutput>["workflow"];
  readonly events: readonly Event[];
  readonly runDir: string;
}): Promise<
  | {
      readonly status: "success";
      readonly input: PlainObject;
      readonly node: StepNode;
      readonly retriedStepId: string;
      readonly sourceFailureEventId: string;
      readonly sourceFailureReplayPosition: number;
    }
  | { readonly status: "failure"; readonly failure: Failure }
> {
  const failure = selectLatestUnresolvedFailure(options.events);
  if (!failure) {
    return {
      status: "failure",
      failure: retryFailure(
        "retry_target_not_failed",
        "Retry target has no latest unresolved failure.",
      ),
    };
  }

  if (failure.workflowId !== options.workflow.id) {
    return {
      status: "failure",
      failure: retryFailure(
        "retry_workflow_mismatch",
        `Retry target workflow ${failure.workflowId} does not match ${options.workflow.id}.`,
      ),
    };
  }

  if (!failure.workflowInput) {
    return {
      status: "failure",
      failure: retryFailure("retry_target_not_found", "workflow.started payload is missing input."),
    };
  }

  if (!failure.stepId) {
    return {
      status: "failure",
      failure: retryFailure(
        "retry_target_not_failed",
        failure.event.type === "workflow.failed"
          ? "Workflow failure has no associated step ID. This run may use unsupported historical retry metadata."
          : "Failed retry target event has no step ID.",
      ),
    };
  }

  const replay = await replayCompletedSteps({
    workflow: options.workflow,
    events: eventsBeforeRetryTarget(
      options.events,
      failure.replayPosition,
      failure.stepId,
      failure.event,
    ),
    input: failure.workflowInput,
    targetStepId: failure.stepId,
    runDir: options.runDir,
  });
  if (replay.status === "failure") {
    return replay;
  }

  const { node } = replay;
  if (node.onError) {
    return {
      status: "failure",
      failure: retryFailure(
        "retry_unsupported_history",
        `Retry does not support onError history for step ${node.config.id}.`,
      ),
    };
  }

  return {
    status: "success",
    input: failure.workflowInput,
    node,
    retriedStepId: failure.stepId,
    sourceFailureEventId: failure.sourceFailureEventId ?? failure.event.id,
    sourceFailureReplayPosition: failure.replayPosition,
  };
}

function eventsBeforeRetryTarget(
  events: readonly Event[],
  replayPosition: number,
  targetStepId: string,
  targetEvent: Event,
): readonly Event[] {
  const eventsBeforeFailure = events.slice(0, replayPosition);
  const excludedPositions = new Set<number>();

  for (const event of eventsBeforeFailure) {
    if (event.type !== "workflow.retryStarted") {
      continue;
    }

    const resolvedPosition = readSourceFailureReplayPosition(event);
    if (resolvedPosition === undefined || resolvedPosition >= replayPosition) {
      continue;
    }

    for (const position of resolvedAttemptPositions(events, resolvedPosition)) {
      excludedPositions.add(position);
    }
  }

  if (targetEvent.type === "step.started") {
    return eventsBeforeFailure.filter((_, index) => !excludedPositions.has(index));
  }

  let targetAttemptStartPosition = -1;
  for (let index = eventsBeforeFailure.length - 1; index >= 0; index -= 1) {
    const event = eventsBeforeFailure[index];
    if (excludedPositions.has(index)) {
      continue;
    }

    if (event?.type === "step.started" && event.stepId === targetStepId) {
      targetAttemptStartPosition = index;
      break;
    }
  }

  return eventsBeforeFailure.filter((event, index) => {
    if (excludedPositions.has(index)) {
      return false;
    }

    return (
      targetAttemptStartPosition === -1 ||
      index <= targetAttemptStartPosition ||
      event.type !== "step.completed" ||
      event.stepId !== targetStepId
    );
  });
}

function readSourceFailureReplayPosition(event: Event): number | undefined {
  const { sourceFailureReplayPosition } = event.payload;
  return typeof sourceFailureReplayPosition === "number" ? sourceFailureReplayPosition : undefined;
}

function resolvedAttemptPositions(
  events: readonly Event[],
  resolvedPosition: number,
): readonly number[] {
  const resolvedEvent = events[resolvedPosition];
  if (!resolvedEvent?.stepId) {
    return [resolvedPosition];
  }

  const attemptStartPosition = findAttemptStartPosition(
    events,
    resolvedPosition,
    resolvedEvent.stepId,
  );
  const startPosition = attemptStartPosition === -1 ? resolvedPosition : attemptStartPosition;
  const positions: number[] = [];
  for (let position = startPosition; position <= resolvedPosition; position += 1) {
    positions.push(position);
  }

  return positions;
}

function findAttemptStartPosition(
  events: readonly Event[],
  resolvedPosition: number,
  stepId: string,
): number {
  for (let index = resolvedPosition; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "step.started" && event.stepId === stepId) {
      return index;
    }
  }

  return -1;
}

function retryFailure(code: string, message: string): Failure {
  return { code, message };
}
