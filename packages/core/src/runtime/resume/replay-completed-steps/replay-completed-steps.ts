import type { ContinuationResult, StepNode } from "../../../authoring/step/continuation.types.js";
import {
  firstPromptPhase,
  getStepPhases,
  hasPromptPhase,
  isStepNode,
} from "../../../authoring/step/step-node.js";
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

    if (node.config.id !== completedEvent.stepId) {
      return {
        status: "failure",
        failure: replayFailure(
          "resume_step_id_drift",
          `Expected completed step ${node.config.id} but found ${completedEvent.stepId ?? "<missing>"}.`,
        ),
      };
    }

    if (hasPromptPhase(node)) {
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

      const promptPhase = firstPromptPhase(getStepPhases(node));
      const outputSchema = promptPhase ? resolveStepOutputSchema(promptPhase) : undefined;
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
      const recordedWaitOutputs = readCompletedStepWaitOutputs({
        events: options.events,
        completedEvent,
        stepId: completedNode.config.id,
      });
      if (recordedWaitOutputs.status === "failure") {
        return recordedWaitOutputs;
      }
      node = await withStepContext(completedNode.config.id, stepDir, async () =>
        replayStepPhases(completedNode, validatedOutput, recordedWaitOutputs.waitOutputs),
      );
    } else {
      const stepDir = resolveStepArtifactPaths({
        runDir: options.runDir,
        stepId: node.config.id,
        stepIndex,
      }).stepDir;
      const completedNode = node;
      const recordedWaitOutputs = readCompletedStepWaitOutputs({
        events: options.events,
        completedEvent,
        stepId: completedNode.config.id,
      });
      if (recordedWaitOutputs.status === "failure") {
        return recordedWaitOutputs;
      }
      node = await withStepContext(completedNode.config.id, stepDir, async () =>
        replayStepPhases(completedNode, undefined, recordedWaitOutputs.waitOutputs),
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

async function replayStepPhases(
  stepNode: StepNode,
  recordedPromptOutput?: PlainObject,
  recordedWaitOutputs: Readonly<Record<string, PlainObject>> = {},
): Promise<ContinuationResult> {
  let phaseValue = stepNode.config.input;
  let usedRecordedPromptOutput = false;
  let nextNode: ContinuationResult | undefined;

  for (const phase of getStepPhases(stepNode)) {
    if (phase.kind === "display" || phase.kind === "wait") {
      continue;
    }

    if (nextNode !== undefined) {
      throw new Error(`step ${stepNode.config.id} has executable phases after a do phase`);
    }

    if (phase.kind === "prompt") {
      if (recordedPromptOutput === undefined || usedRecordedPromptOutput) {
        throw new Error(`step ${stepNode.config.id} has no recorded output to replay prompt phase`);
      }
      phaseValue = recordedPromptOutput;
      usedRecordedPromptOutput = true;
      continue;
    }

    nextNode = await phase.onOutput(
      withWaitsDoContext(phaseValue, recordedWaitOutputs),
      stepNode.config.input,
    );
  }

  if (nextNode === undefined) {
    throw new Error(`step ${stepNode.config.id} has no do phase`);
  }

  return nextNode;
}

function readCompletedStepWaitOutputs(options: {
  readonly events: readonly Event[];
  readonly completedEvent: Event;
  readonly stepId: string;
}):
  | { readonly status: "success"; readonly waitOutputs: Readonly<Record<string, PlainObject>> }
  | { readonly status: "failure"; readonly failure: Failure } {
  const completedEventIndex = options.events.indexOf(options.completedEvent);
  const priorEvents =
    completedEventIndex === -1 ? options.events : options.events.slice(0, completedEventIndex);
  let stepStartedIndex = -1;
  for (let index = priorEvents.length - 1; index >= 0; index -= 1) {
    const event = priorEvents[index];
    if (event?.type === "step.started" && event.stepId === options.stepId) {
      stepStartedIndex = index;
      break;
    }
  }
  const inStepEvents =
    stepStartedIndex === -1 ? priorEvents : priorEvents.slice(stepStartedIndex + 1);
  const waitOutputs: Record<string, PlainObject> = {};

  for (const event of inStepEvents) {
    if (event.type !== "wait.satisfied" || event.stepId !== options.stepId) {
      continue;
    }

    const waitId = typeof event.payload.waitId === "string" ? event.payload.waitId : undefined;
    const output = readPlainPayload(event, "output");
    if (!waitId || !output) {
      return {
        status: "failure",
        failure: replayFailure(
          "resume_missing_wait_output",
          `Completed step ${options.stepId} has an invalid recorded satisfied wait output.`,
        ),
      };
    }

    if (Object.hasOwn(waitOutputs, waitId)) {
      return {
        status: "failure",
        failure: replayFailure(
          "resume_duplicate_wait_id",
          `Completed step ${options.stepId} has duplicate wait id '${waitId}'.`,
        ),
      };
    }
    waitOutputs[waitId] = output;
  }

  return { status: "success", waitOutputs };
}

function withWaitsDoContext(
  output: PlainObject,
  waits: Readonly<Record<string, PlainObject>>,
): PlainObject {
  return new Proxy(output, {
    get(target, property, receiver) {
      if (property === "output") {
        return target;
      }
      if (property === "waits") {
        return waits;
      }
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      return property === "output" || property === "waits" || Reflect.has(target, property);
    },
    getOwnPropertyDescriptor(target, property) {
      if (property === "output") {
        return { configurable: true, enumerable: false, value: target };
      }
      if (property === "waits") {
        return { configurable: true, enumerable: false, value: waits };
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
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
