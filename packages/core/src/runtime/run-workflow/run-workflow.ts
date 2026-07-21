import { basename } from "node:path";
import { normalizeShape } from "../../authoring/shape/json-schema.js";
import type { ContinuationResult } from "../../authoring/step/continuation.types.js";
import type { Failure } from "../../contracts/failures/failure.js";
import { StepKitFailureError } from "../../contracts/failures/failure.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import type {
  Event,
  Result,
  RunWorkflowOptions,
} from "../../runtime/run-workflow/run-workflow.types.js";
import { appendEvent, createRunDirectory, readRunEvents } from "../artifacts/run-storage.js";
import { runContinuation } from "../continuation/run-continuation/run-continuation.js";
import { createEvent } from "../events/create-run-event.js";
import { replayToFailedStep } from "../resume/replay-to-failed-step/replay-to-failed-step.js";
import { createRunContext } from "../run-context/create-run-context.js";

export async function runWorkflow<TInput extends PlainObject, TOutput extends PlainObject>(
  options: RunWorkflowOptions<TInput, TOutput>,
): Promise<Result<TOutput>> {
  const maxSteps = options.maxSteps ?? 1000;
  const isResume = options.resume !== undefined;
  const initialized = await initializeRun(options).catch((error) => {
    if (options.resume && (error instanceof StepKitFailureError || isFailureLikeError(error))) {
      return {
        status: "failure" as const,
        runId: basename(options.resume.runDir),
        runName: basename(options.resume.runDir),
        runDir: options.resume.runDir,
        previousEvents: [],
        failure: unknownWorkflowFailure(error),
      };
    }

    throw error;
  });

  if ("status" in initialized && initialized.status === "failure") {
    return {
      status: "failure",
      runId: initialized.runId,
      runDir: initialized.runDir,
      failure: initialized.failure,
      events: initialized.previousEvents,
    };
  }

  const { runId, runName, runDir, previousEvents } = initialized;
  const cwd = options.cwd ?? process.cwd();
  const events: Event[] = [...previousEvents];
  const runContext = createRunContext({ runId, runName, runDir });

  const emit = async (event: Event): Promise<void> => {
    events.push(event);
    await appendEvent(runDir, event);
    await options.eventSink?.(event);
  };

  const failWorkflow = async (failure: Failure): Promise<Result<TOutput>> => {
    await emit(
      createEvent({
        runId,
        workflowId: options.workflow.id,
        type: "workflow.failed",
        payload: { failure },
      }),
    );
    return {
      status: "failure",
      runId,
      runDir,
      failure,
      events,
    };
  };

  const failResumeValidation = (failure: Failure): Result<TOutput> => ({
    status: "failure",
    runId,
    runDir,
    failure,
    events,
  });

  try {
    const inputSchema = options.workflow.inputShape
      ? normalizeShape(options.workflow.inputShape)
      : options.workflow.input;

    let workflowInput: TInput;
    let startNode: ContinuationResult | undefined;

    if (isResume) {
      const replay = await replayToFailedStep({
        workflow: options.workflow,
        events: previousEvents,
        runContext,
      });
      if (replay.status === "failure") {
        return failResumeValidation(replay.failure);
      }

      workflowInput = inputSchema
        ? (inputSchema.assert(replay.input, "workflow input") as TInput)
        : (replay.input as TInput);
      startNode = replay.node;
      await emit(
        createEvent({
          runId,
          workflowId: options.workflow.id,
          type: "workflow.resumed",
          payload: {
            resumedFromRunDir: runDir,
            resumedStepId: replay.resumedStepId,
            sourceFailureEventId: replay.sourceFailureEventId,
          },
        }),
      );
    } else {
      workflowInput = inputSchema
        ? inputSchema.assert(options.input, "workflow input")
        : (options.input as TInput);
      await emit(
        createEvent({
          runId,
          workflowId: options.workflow.id,
          type: "workflow.started",
          payload: { input: workflowInput },
        }),
      );
    }

    const continuationResult = await runContinuation({
      node: startNode ?? options.workflow.start(workflowInput),
      runId,
      workflowId: options.workflow.id,
      emit,
      maxSteps,
      initialSource: isResume
        ? `resume for workflow ${options.workflow.id}`
        : `workflow.start for workflow ${options.workflow.id}`,
      workflowAgents: options.workflow.agents ?? {},
      runDir,
      cwd,
      runContext,
      stepkitConfig: options.stepkitConfig,
      workingAgentProcessRunner: options.workingAgentProcessRunner,
      providerWorkingRunner: options.providerWorkingRunner,
      processRunner: options.processRunner,
    });

    if (continuationResult.status === "failure") {
      return await failWorkflow(continuationResult.failure);
    }

    const current = continuationResult.output;

    const outputSchema = options.workflow.outputShape
      ? normalizeShape(options.workflow.outputShape)
      : options.workflow.output;
    const output = (
      outputSchema ? outputSchema.assert(current, "workflow output") : current
    ) as TOutput;

    await emit(
      createEvent({
        runId,
        workflowId: options.workflow.id,
        type: "workflow.completed",
        payload: { output },
      }),
    );

    return {
      status: "success",
      runId,
      runDir,
      output,
      events,
    };
  } catch (error) {
    return await failWorkflow(unknownWorkflowFailure(error));
  }
}

async function initializeRun<TInput extends PlainObject, TOutput extends PlainObject>(
  options: RunWorkflowOptions<TInput, TOutput>,
): Promise<{
  readonly runId: string;
  readonly runName: string;
  readonly runDir: string;
  readonly previousEvents: readonly Event[];
}> {
  if (options.resume) {
    const previousEvents = await readRunEvents(options.resume.runDir);
    const startedEvent = previousEvents.find((event) => event.type === "workflow.started");
    return {
      runId: startedEvent?.runId ?? basename(options.resume.runDir),
      runName: startedEvent?.runId ?? basename(options.resume.runDir),
      runDir: options.resume.runDir,
      previousEvents,
    };
  }

  const cwd = options.cwd ?? process.cwd();
  const { runId, runDir } = await createRunDirectory({ cwd, runName: options.runName });
  return { runId, runName: options.runName, runDir, previousEvents: [] };
}

/**
 * Failure-shaping helpers specific to workflow-execution orchestration
 * (not part of the public API — only `Failure` itself is exported from
 * `contracts/failures/failure.ts` and re-exported from the package entry point).
 */

function unknownWorkflowFailure(error: unknown): Failure {
  if (error instanceof StepKitFailureError) {
    return error.failure;
  }

  if (isFailureLikeError(error)) {
    return error.failure;
  }

  return {
    code: "workflow_failed",
    message: error instanceof Error ? error.message : "Unknown workflow failure.",
    ...(error === undefined ? {} : { details: { cause: error } }),
  };
}

function isFailureLikeError(error: unknown): error is { readonly failure: Failure } {
  return (
    typeof error === "object" &&
    error !== null &&
    "failure" in error &&
    typeof error.failure === "object" &&
    error.failure !== null &&
    "code" in error.failure &&
    "message" in error.failure
  );
}
