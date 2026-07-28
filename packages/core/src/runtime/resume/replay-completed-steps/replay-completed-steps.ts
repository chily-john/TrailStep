import type { ContinuationResult, StepNode } from "../../../authoring/step/continuation.types.js";
import { isStepNode } from "../../../authoring/step/step-node.js";
import type { Failure } from "../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import type {
  Event,
  RunWorkflowOptions,
} from "../../../runtime/run-workflow/run-workflow.types.js";
import { resolveStepArtifactPaths } from "../../artifacts/step-artifacts.js";
import { resolveStepOutputSchema } from "../../continuation/resolve-step-output-schema/resolve-step-output-schema.js";
import { withStepContext } from "../../run-context/with-step-context.js";

/**
 * Walks a workflow's `start(...)` continuation forward through its recorded
 * `step.completed` history — trusting each completed prompt/agent step's
 * persisted output rather than recomputing it — until it reaches
 * `targetStepId`. Shared by `replayToFailedStep` (target = the step that
 * failed) and `reattachInProgressStep` (target = a dangling interactive
 * step): both need the identical "replay what already happened" walk: only
 * their handling of the target step once reached differs.
 */
export async function replayCompletedSteps<
  TInput extends PlainObject,
  TOutput extends PlainObject,
>(options: {
  readonly workflow: RunWorkflowOptions<TInput, TOutput>["workflow"];
  readonly events: readonly Event[];
  readonly input: PlainObject;
  readonly targetStepId: string;
  readonly runDir: string;
}): Promise<
  | { readonly status: "success"; readonly node: StepNode }
  | { readonly status: "failure"; readonly failure: Failure }
> {
  let node: ContinuationResult = options.workflow.start(options.input as TInput);
  const completedStepEvents = options.events.filter((event) => event.type === "step.completed");

  for (const [completedIndex, completedEvent] of completedStepEvents.entries()) {
    const stepIndex = completedIndex + 1;
    if (!isStepNode(node)) {
      return {
        status: "failure",
        failure: replayFailure(
          "resume_step_id_drift",
          "Completed history continues after the current workflow reaches done.",
        ),
      };
    }

    if (node.config.id === options.targetStepId) {
      return {
        status: "failure",
        failure: replayFailure(
          "resume_target_not_failed",
          `Target step ${node.config.id} already has a completed output in the target history.`,
        ),
      };
    }

    if (node.config.id !== completedEvent.stepId) {
      return {
        status: "failure",
        failure: replayFailure(
          "resume_step_id_drift",
          `Expected completed step ${node.config.id} but found ${completedEvent.stepId ?? "<missing>"}.`,
        ),
      };
    }

    if (node.config.prompt !== undefined) {
      const recordedOutput = readPlainPayload(completedEvent, "output");
      if (!recordedOutput) {
        return {
          status: "failure",
          failure: replayFailure(
            "resume_missing_step_output",
            `Completed step ${node.config.id} has no recorded output to resume from.`,
          ),
        };
      }

      const outputSchema = resolveStepOutputSchema(node.config);
      if (!outputSchema) {
        return {
          status: "failure",
          failure: replayFailure(
            "resume_output_schema_unresolvable",
            `Step ${node.config.id} has no resolvable output schema to replay with.`,
          ),
        };
      }
      const validatedOutput = outputSchema.assert(recordedOutput, `step ${node.config.id} output`);

      const stepDir = resolveStepArtifactPaths({
        runDir: options.runDir,
        stepId: node.config.id,
        stepIndex,
      }).stepDir;
      const completedNode = node;
      node = await withStepContext(completedNode.config.id, stepDir, async () =>
        completedNode.onOutput(validatedOutput, completedNode.config.input),
      );
    } else {
      const stepDir = resolveStepArtifactPaths({
        runDir: options.runDir,
        stepId: node.config.id,
        stepIndex,
      }).stepDir;
      const completedNode = node;
      node = await withStepContext(completedNode.config.id, stepDir, async () =>
        completedNode.onOutput(completedNode.config.input, completedNode.config.input),
      );
    }
  }

  if (!isStepNode(node) || node.config.id !== options.targetStepId) {
    return {
      status: "failure",
      failure: replayFailure(
        "resume_step_id_drift",
        `Target step ${options.targetStepId} is not the next live step.`,
      ),
    };
  }

  return { status: "success", node };
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

function replayFailure(code: string, message: string): Failure {
  return { code, message };
}
