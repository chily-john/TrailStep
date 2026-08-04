import type { StepNode } from "../../authoring/step/continuation.types.js";
import type { Failure } from "../../contracts/failures/failure.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import type { Event, RunWorkflowOptions } from "../run-workflow/run-workflow.types.js";
import { replayCompletedSteps } from "../resume/replay-completed-steps/replay-completed-steps.js";
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
      failure: retryFailure(
        "retry_target_not_found",
        "workflow.started payload is missing input.",
      ),
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
    events: options.events.slice(0, failure.replayPosition),
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

function retryFailure(code: string, message: string): Failure {
  return { code, message };
}
