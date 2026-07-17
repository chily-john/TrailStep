import type { ContinuationResult, StepNode } from "../../../authoring/step/continuation.types.js";
import { isStepNode } from "../../../authoring/step/step-node.js";
import type { Failure } from "../../../contracts/failures/failure.js";
import type { RunContext } from "../../../contracts/run-context/run-context.types.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import type {
  Event,
  RunWorkflowOptions,
} from "../../../runtime/run-workflow/run-workflow.types.js";

export async function replayToFailedStep<
  TInput extends PlainObject,
  TOutput extends PlainObject,
>(options: {
  readonly workflow: RunWorkflowOptions<TInput, TOutput>["workflow"];
  readonly events: readonly Event[];
  readonly runContext: RunContext;
}): Promise<
  | {
      readonly status: "success";
      readonly input: PlainObject;
      readonly node: StepNode;
      readonly resumedStepId: string;
      readonly sourceFailureEventId: string;
    }
  | { readonly status: "failure"; readonly failure: Failure }
> {
  const startedEvent = options.events.find((event) => event.type === "workflow.started");
  if (!startedEvent) {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_target_not_found",
        "Resume target has no workflow.started event.",
      ),
    };
  }

  if (startedEvent.workflowId !== options.workflow.id) {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_workflow_mismatch",
        `Resume target workflow ${startedEvent.workflowId} does not match ${options.workflow.id}.`,
      ),
    };
  }

  const terminalEvent = options.events.at(-1);
  if (terminalEvent?.type !== "workflow.failed") {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_target_not_failed",
        "Resume target must end in workflow.failed.",
      ),
    };
  }

  const recoveredFailedStep = options.events.find(
    (event, index) =>
      event.type === "step.failed" &&
      options.events
        .slice(index + 1)
        .some(
          (laterEvent) =>
            laterEvent.type === "step.completed" && laterEvent.stepId === event.stepId,
        ),
  );
  if (recoveredFailedStep) {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_unsupported_history",
        `Resume does not support recovered onError history for step ${recoveredFailedStep.stepId ?? "<missing>"}.`,
      ),
    };
  }

  const failedStepEvents = options.events.filter((event) => event.type === "step.failed");
  if (failedStepEvents.length !== 1) {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_multiple_failed_steps",
        "Resume target must contain exactly one failed step.",
      ),
    };
  }

  const failedStepEvent = failedStepEvents[0];
  if (!failedStepEvent) {
    return {
      status: "failure",
      failure: resumeFailure("resume_target_not_failed", "Resume target has no failed step."),
    };
  }

  if (!failedStepEvent.stepId) {
    return {
      status: "failure",
      failure: resumeFailure("resume_target_not_failed", "Failed step event has no step id."),
    };
  }

  const input = readPlainPayload(startedEvent, "input");
  if (!input) {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_target_not_found",
        "workflow.started payload is missing input.",
      ),
    };
  }

  let node: ContinuationResult = options.workflow.start(input as TInput);
  const completedStepEvents = options.events.filter((event) => event.type === "step.completed");

  for (const completedEvent of completedStepEvents) {
    if (!isStepNode(node)) {
      return {
        status: "failure",
        failure: resumeFailure(
          "resume_step_id_drift",
          "Completed history continues after the current workflow reaches done.",
        ),
      };
    }

    if (node.config.id === failedStepEvent.stepId) {
      return {
        status: "failure",
        failure: resumeFailure(
          "resume_target_not_failed",
          "Failed step already has a completed output in the target history.",
        ),
      };
    }

    if (node.config.id !== completedEvent.stepId) {
      return {
        status: "failure",
        failure: resumeFailure(
          "resume_step_id_drift",
          `Expected completed step ${node.config.id} but found ${completedEvent.stepId ?? "<missing>"}.`,
        ),
      };
    }

    if (node.config.prompt !== undefined) {
      return {
        status: "failure",
        failure: resumeFailure(
          "resume_unsupported_history",
          `Resume does not support non-code step ${node.config.id}.`,
        ),
      };
    }

    node = await node.onOutput(node.config.input, options.runContext);
  }

  if (!isStepNode(node) || node.config.id !== failedStepEvent.stepId) {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_step_id_drift",
        `Failed step ${failedStepEvent.stepId} is not the next live step.`,
      ),
    };
  }

  if (node.config.prompt !== undefined) {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_unsupported_history",
        `Resume does not support non-code step ${node.config.id}.`,
      ),
    };
  }

  if (node.onError) {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_unsupported_history",
        `Resume does not support onError history for step ${node.config.id}.`,
      ),
    };
  }

  const resumeNode = node;
  return {
    status: "success",
    input,
    node: resumeNode,
    resumedStepId: failedStepEvent.stepId,
    sourceFailureEventId: failedStepEvent.id,
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

function resumeFailure(code: string, message: string): Failure {
  return { code, message };
}
