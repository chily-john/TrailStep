import { basename } from "node:path";
import { normalizeShape } from "../../authoring/shape/json-schema.js";
import type { ContinuationResult } from "../../authoring/step/continuation.types.js";
import type { Failure } from "../../contracts/failures/failure.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import type {
  Event,
  Result,
  RunWorkflowOptions,
} from "../../runtime/run-workflow/run-workflow.types.js";
import { appendEvent } from "../artifacts/run-storage.js";
import { runContinuation } from "../continuation/run-continuation/run-continuation.js";
import { createEvent } from "../events/create-run-event.js";
import { isFailureLikeError } from "../failures/failure-like.js";
import { workflowFailure } from "../failures/workflow-failure.js";
import {
  findDanglingInteractiveSessionStart,
  reattachInProgressStep,
} from "../resume/reattach-in-progress-step/reattach-in-progress-step.js";
import { replayToFailedStep } from "../resume/replay-to-failed-step/replay-to-failed-step.js";
import { createRunContext } from "../run-context/create-run-context.js";
import { runContextStorage } from "../run-context/run-context-storage.js";
import { initializeRun } from "./initialize-run.js";
import { parseStepKitConfigInput } from "./stepkit-config-input.js";

export async function runWorkflow<TInput extends PlainObject, TOutput extends PlainObject>(
  options: RunWorkflowOptions<TInput, TOutput>,
): Promise<Result<TOutput>> {
  const maxSteps = options.maxSteps ?? 1000;
  const isResume = options.resume !== undefined;
  const initialized = await initializeRun(options).catch((error) => {
    if (options.resume && isFailureLikeError(error)) {
      return {
        status: "failure" as const,
        runId: basename(options.resume.runDir),
        runName: basename(options.resume.runDir),
        runDir: options.resume.runDir,
        previousEvents: [],
        failure: workflowFailure(error),
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
  const stepkitConfig =
    options.stepkitConfig === undefined
      ? undefined
      : parseStepKitConfigInput(options.stepkitConfig);
  const cwd = options.cwd ?? process.cwd();
  const events: Event[] = [...previousEvents];

  const emit = async (event: Event): Promise<void> => {
    events.push(event);
    await appendEvent(runDir, event);
    await options.eventSink?.(event);
  };

  const runContext = createRunContext({
    runId,
    runName,
    runDir,
    workflowId: options.workflow.id,
    workflowAgents: options.workflow.agents ?? {},
    cwd,
    stepkitConfig,
    workingAgentProcessRunner: options.workingAgentProcessRunner,
    providerWorkingRunner: options.providerWorkingRunner,
    emit,
    events: () => events,
  });

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
    return await runContextStorage.run(runContext, () => runWorkflowBody());
  } catch (error) {
    return await failWorkflow(workflowFailure(error));
  }

  async function runWorkflowBody(): Promise<Result<TOutput>> {
    const inputSchema = options.workflow.inputShape
      ? normalizeShape(options.workflow.inputShape)
      : options.workflow.input;

    let workflowInput: TInput;
    let startNode: ContinuationResult | undefined;

    if (isResume) {
      const danglingAnchor = findDanglingInteractiveSessionStart(previousEvents);
      const replay = danglingAnchor
        ? await reattachInProgressStep({
            workflow: options.workflow,
            events: previousEvents,
            runDir,
          })
        : await replayToFailedStep({
            workflow: options.workflow,
            events: previousEvents,
            runDir,
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
      // The original run already used one step-index slot per step.started
      // event ever recorded (successful or failed) -- newly-dispatched steps
      // after resume must continue that sequence, not restart at 1, or their
      // artifact directories collide with the pre-resume steps' directories.
      initialExecutedSteps: isResume
        ? previousEvents.filter((event) => event.type === "step.started").length
        : undefined,
      workflowAgents: options.workflow.agents ?? {},
      runDir,
      cwd,
      stepkitConfig,
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
  }
}

