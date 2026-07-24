import {
  readCompletedInteractiveOutput,
  waitForInteractiveCompletion,
} from "../../../agent-execution/interactive-agent/run-interactive-agent-command/run-interactive-agent-command.js";
import type { ContinuationResult } from "../../../authoring/step/continuation.types.js";
import type { Failure } from "../../../contracts/failures/failure.js";
import { StepKitFailureError } from "../../../contracts/failures/failure.js";
import type { PlainObject, Schema } from "../../../contracts/shapes/shape.types.js";
import type {
  Event,
  RunWorkflowOptions,
} from "../../../runtime/run-workflow/run-workflow.types.js";
import { resolveStepArtifactPaths } from "../../artifacts/step-artifacts.js";
import { resolveStepOutputSchema } from "../../continuation/resolve-step-output-schema/resolve-step-output-schema.js";
import { replayCompletedSteps } from "../replay-completed-steps/replay-completed-steps.js";

/**
 * Detects the "process died mid-interactive-step" resume shape: the run's
 * last event is `interactive.sessionStarted` for a step, with nothing after
 * it — no `interactive.sessionCompleted`, `step.completed`, `step.failed`,
 * `workflow.failed`, or `workflow.completed` was ever written, because the
 * process was killed before any of those could be recorded. Anything else
 * (an already-terminal `workflow.failed`/`workflow.completed` run) is not
 * this shape, even if an interactive.sessionStarted appears earlier in
 * history — `run-workflow.ts` falls back to `replayToFailedStep` for that.
 */
export function findDanglingInteractiveSessionStart(events: readonly Event[]): Event | undefined {
  const anchor = events.at(-1);
  if (anchor?.type !== "interactive.sessionStarted" || !anchor.stepId) {
    return undefined;
  }

  const hasTerminalWorkflowEvent = events.some(
    (event) => event.type === "workflow.failed" || event.type === "workflow.completed",
  );

  return hasTerminalWorkflowEvent ? undefined : anchor;
}

export async function reattachInProgressStep<
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
      readonly node: ContinuationResult;
      readonly resumedStepId: string;
      readonly sourceFailureEventId: string;
    }
  | { readonly status: "failure"; readonly failure: Failure }
> {
  const anchor = findDanglingInteractiveSessionStart(options.events);
  if (!anchor?.stepId) {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_target_not_dangling",
        "Resume target has no dangling interactive.sessionStarted event to reattach.",
      ),
    };
  }

  const stepIndex = anchor.payload.stepIndex;
  if (typeof stepIndex !== "number") {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_missing_step_index",
        `Dangling interactive.sessionStarted event for step ${anchor.stepId} has no recorded stepIndex.`,
      ),
    };
  }

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

  const replay = await replayCompletedSteps({
    workflow: options.workflow,
    events: options.events,
    input,
    targetStepId: anchor.stepId,
  });
  if (replay.status === "failure") {
    return replay;
  }

  const { node } = replay;
  const artifactPaths = resolveStepArtifactPaths({
    runDir: options.runDir,
    stepId: anchor.stepId,
    stepIndex,
  });

  const outputSchema = resolveStepOutputSchema(node.config);
  if (!outputSchema) {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_output_schema_unresolvable",
        `Step ${node.config.id} has no resolvable output schema to reattach with.`,
      ),
    };
  }

  const reattached = await readReattachedInteractiveOutput({
    stepId: anchor.stepId,
    interactiveFile: artifactPaths.interactiveFile,
    outputSchema,
  });
  if (reattached.status === "failure") {
    return reattached;
  }

  const nextNode = await node.onOutput(
    outputSchema.assert(reattached.output, `step ${node.config.id} output`),
  );

  return {
    status: "success",
    input,
    node: nextNode,
    resumedStepId: anchor.stepId,
    sourceFailureEventId: anchor.id,
  };
}

/**
 * Reads the anchor step's already-existing interactive.json protocol file —
 * never spawns a new agent process. If the session was still "active" when
 * the previous process died, re-enters the same file-polling wait the live
 * dispatch path uses (`waitForInteractiveCompletion`) rather than giving up.
 */
async function readReattachedInteractiveOutput(options: {
  readonly stepId: string;
  readonly interactiveFile: string;
  readonly outputSchema: Schema;
}): Promise<
  | { readonly status: "success"; readonly output: PlainObject }
  | { readonly status: "failure"; readonly failure: Failure }
> {
  const first = await tryReadCompletedInteractiveOutput(options);
  if (first.status !== "still-active") {
    return first;
  }

  const abortController = new AbortController();
  await waitForInteractiveCompletion(options.interactiveFile, abortController.signal);

  const second = await tryReadCompletedInteractiveOutput(options);
  if (second.status !== "still-active") {
    return second;
  }

  throw new StepKitFailureError({
    code: "interactive_session_incomplete",
    message: `Interactive agent step ${options.stepId} did not complete after reattaching.`,
  });
}

async function tryReadCompletedInteractiveOutput(options: {
  readonly stepId: string;
  readonly interactiveFile: string;
  readonly outputSchema: Schema;
}): Promise<
  | { readonly status: "success"; readonly output: PlainObject }
  | { readonly status: "failure"; readonly failure: Failure }
  | { readonly status: "still-active" }
> {
  try {
    return { status: "success", output: await readCompletedInteractiveOutput(options) };
  } catch (error) {
    if (error instanceof StepKitFailureError) {
      if (error.failure.code === "interactive_session_incomplete") {
        return { status: "still-active" };
      }

      if (error.failure.code === "interactive_session_cancelled") {
        return {
          status: "failure",
          failure: resumeFailure(
            "resume_interactive_session_cancelled",
            `Interactive agent step ${options.stepId} was cancelled and cannot be resumed.`,
          ),
        };
      }

      if (error.failure.code === "interactive_session_invalid") {
        return {
          status: "failure",
          failure: resumeFailure(
            "resume_interactive_protocol_missing",
            `Interactive agent step ${options.stepId} has no readable interactive.json to reattach to.`,
          ),
        };
      }
    }

    throw error;
  }
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
