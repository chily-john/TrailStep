import type { StepNode } from "../../authoring/step/continuation.types.js";
import type { Failure } from "../../contracts/failures/failure.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import { readPlainPayload } from "../../runtime/events/read-plain-payload.js";
import { replayCompletedSteps } from "../resume/replay-completed-steps/replay-completed-steps.js";
import type { Event, RunWorkflowOptions } from "./run-workflow.types.js";

/**
 * Replay target for retrying a cancelled run.
 *
 * A cancelled run has no unresolved failure, so the ordinary retry path
 * (replayToRetryFailure) has nothing to target. The retry target of a
 * cancelled run is the step the cancellation interrupted: the run re-executes
 * that step instead of staying bricked.
 */
export async function replayToCancelledStep<
  TInput extends PlainObject,
  TOutput extends PlainObject,
>(options: {
  readonly workflow: RunWorkflowOptions<TInput, TOutput>["workflow"];
  readonly events: readonly Event[];
  readonly runDir: string;
  readonly cancelledEventIndex: number;
}): Promise<
  | {
      readonly status: "success";
      readonly input: PlainObject;
      readonly node: StepNode;
      readonly retriedStepId: string;
      readonly sourceCancellationEventId: string;
    }
  | { readonly status: "failure"; readonly failure: Failure }
> {
  const startedEvent = options.events.find((event) => event.type === "workflow.started");
  if (!startedEvent) {
    return {
      status: "failure",
      failure: retryFailure(
        "retry_target_not_found",
        "Retry target has no workflow.started event.",
      ),
    };
  }

  if (startedEvent.workflowId !== options.workflow.id) {
    return {
      status: "failure",
      failure: retryFailure(
        "retry_workflow_mismatch",
        `Retry target workflow ${startedEvent.workflowId} does not match ${options.workflow.id}.`,
      ),
    };
  }

  const input = readPlainPayload(startedEvent, "input");
  if (!input) {
    return {
      status: "failure",
      failure: retryFailure("retry_target_not_found", "workflow.started payload is missing input."),
    };
  }

  const cancelledEvent = options.events[options.cancelledEventIndex];
  const cancelledStepId = cancelledEvent?.stepId;
  if (
    cancelledEvent?.type !== "step.cancelled" ||
    cancelledStepId === undefined ||
    cancelledStepId === ""
  ) {
    return {
      status: "failure",
      failure: retryFailure(
        "retry_target_not_cancelled",
        "Cancelled run has no cancelled step to retry.",
      ),
    };
  }

  // The cancelled attempt is the last step.started for that step before the
  // cancellation. Everything from that attempt onwards is replayed live.
  let attemptStartIndex = -1;
  for (let index = options.cancelledEventIndex; index >= 0; index -= 1) {
    const event = options.events[index];
    if (event?.type === "step.started" && event.stepId === cancelledStepId) {
      attemptStartIndex = index;
      break;
    }
  }
  if (attemptStartIndex === -1) {
    return {
      status: "failure",
      failure: retryFailure(
        "retry_target_not_cancelled",
        `Cancelled step ${cancelledStepId} has no recorded attempt to retry.`,
      ),
    };
  }

  const replay = await replayCompletedSteps({
    workflow: options.workflow,
    events: options.events.slice(0, attemptStartIndex),
    input,
    targetStepId: cancelledStepId,
    runDir: options.runDir,
  });
  if (replay.status === "failure") {
    return replay;
  }

  return {
    status: "success",
    input,
    node: replay.node,
    retriedStepId: cancelledStepId,
    sourceCancellationEventId: cancelledEvent.id,
  };
}

function retryFailure(code: string, message: string): Failure {
  return { code, message };
}
