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
import {
  type CancellationMarker,
  cancellationPayload,
  isWorkflowCancellationError,
  readCancellationMarker,
} from "../cancellation/cancellation.js";
import { runContinuation } from "../continuation/run-continuation/run-continuation.js";
import { runRootContinuationArrayScheduler } from "./root-continuation-array-scheduler.js";
import { createEvent } from "../events/create-run-event.js";
import { isFailureLikeError } from "../failures/failure-like.js";
import { workflowFailure } from "../failures/workflow-failure.js";
import {
  findDanglingInteractiveSessionStart,
  reattachInProgressStep,
} from "../resume/reattach-in-progress-step/reattach-in-progress-step.js";
import { replayToFailedStep } from "../resume/replay-to-failed-step/replay-to-failed-step.js";
import {
  type ReplayToWaitingStepResult,
  replayToWaitingStep,
} from "../resume/replay-to-waiting-step/replay-to-waiting-step.js";
import { replayToRetryFailure } from "../retry/replay-to-retry-failure.js";
import { createRunContext } from "../run-context/create-run-context.js";
import { runContextStorage } from "../run-context/run-context-storage.js";
import { resolveAndValidateRunCwds } from "./cwd.js";
import { initializeRun } from "./initialize-run.js";
import { parseTrailStepConfigInput } from "./trailstep-config-input.js";

export async function runWorkflow<TInput extends PlainObject, TOutput extends PlainObject>(
  options: RunWorkflowOptions<TInput, TOutput>,
): Promise<Result<TOutput>> {
  const maxSteps = options.maxSteps ?? 1000;
  const isResume = options.resume !== undefined;
  const isRetry = options.retry !== undefined;
  const isWaitContinue = options.continue !== undefined;
  const initialized = await initializeRun(options).catch((error) => {
    const existingRunDir =
      options.resume?.runDir ?? options.retry?.runDir ?? options.continue?.runDir;
    if (existingRunDir && isFailureLikeError(error)) {
      return {
        status: "failure" as const,
        runId: basename(existingRunDir),
        runName: basename(existingRunDir),
        runDir: existingRunDir,
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
  const trailstepConfig =
    options.trailstepConfig === undefined
      ? undefined
      : parseTrailStepConfigInput(options.trailstepConfig);
  const { projectCwd, cwd } = await resolveAndValidateRunCwds(options);
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
    projectCwd,
    cwd,
    executionCwd: cwd,
    trailstepConfig,
    workingAgentProcessRunner: options.workingAgentProcessRunner,
    providerWorkingRunner: options.providerWorkingRunner,
    emit,
    events: () => events,
    ...(isResume || isRetry ? { initialState: {} } : {}),
  });

  const cancelWorkflow = async (cancellation: CancellationMarker): Promise<Result<TOutput>> => {
    if (!events.some((event) => event.type === "workflow.cancelRequested")) {
      await emit(
        createEvent({
          runId,
          workflowId: options.workflow.id,
          type: "workflow.cancelRequested",
          payload: cancellationPayload(cancellation),
        }),
      );
    }

    if (!events.some((event) => event.type === "workflow.cancelled")) {
      await emit(
        createEvent({
          runId,
          workflowId: options.workflow.id,
          type: "workflow.cancelled",
          payload: cancellationPayload(cancellation),
        }),
      );
    }

    return {
      status: "cancelled",
      runId,
      runDir,
      cancellation,
      events,
    } as unknown as Result<TOutput>;
  };

  const failWorkflow = async (failure: Failure, message?: string): Promise<Result<TOutput>> => {
    await emit(
      createEvent({
        runId,
        workflowId: options.workflow.id,
        type: "workflow.failed",
        payload: {
          failure,
          ...(message === undefined ? {} : { message }),
        },
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
    if (isWorkflowCancellationError(error)) {
      return await cancelWorkflow(error.cancellation);
    }

    return await failWorkflow(workflowFailure(error));
  }

  async function runWorkflowBody(): Promise<Result<TOutput>> {
    const inputSchema = options.workflow.inputShape
      ? normalizeShape(options.workflow.inputShape)
      : options.workflow.input;

    const previousTerminalStatus = readPreviousTerminalWorkflowStatus(previousEvents);
    const existingCancellation = readExistingCancellationEvent(previousEvents);
    const cancellation =
      previousTerminalStatus === undefined || previousTerminalStatus === "cancelled"
        ? (existingCancellation ?? (await readCancellationMarker(runDir)))
        : undefined;
    if (cancellation !== undefined) {
      return await cancelWorkflow(cancellation);
    }

    let workflowInput: TInput;
    let startNode: ContinuationResult | undefined;
    let waitResume: ReplayToWaitingStepResult | undefined;

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
    } else if (isWaitContinue) {
      const replay = await replayToWaitingStep({
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
      waitResume = replay;
      await emit(
        createEvent({
          runId,
          workflowId: options.workflow.id,
          type: "workflow.resumed",
          payload: {
            resumeKind: "wait",
            resumedFromRunDir: runDir,
            resumedStepId: replay.resumedStepId,
            sourceWaitEventId: replay.sourceWaitEventId,
          },
        }),
      );
    } else if (isRetry) {
      const replay = await replayToRetryFailure({
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
          type: "workflow.retryStarted",
          payload: {
            retryKind: options.retry.kind,
            retriedFromRunDir: runDir,
            retriedStepId: replay.retriedStepId,
            sourceFailureEventId: replay.sourceFailureEventId,
            sourceFailureReplayPosition: replay.sourceFailureReplayPosition,
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

    const rootNode = startNode ?? options.workflow.start(workflowInput);
    const continuationResult =
      !isResume && !isRetry && !isWaitContinue && Array.isArray(rootNode)
        ? await runRootContinuationArrayScheduler({
            nodes: rootNode,
            runId,
            workflowId: options.workflow.id,
            emit,
            maxSteps,
            initialSource: `workflow.start for workflow ${options.workflow.id}`,
            workers: options.scheduler?.workers,
            workflowAgents: options.workflow.agents ?? {},
            workflowTimeout: options.workflow.timeout,
            runDir,
            projectCwd,
            cwd,
            trailstepConfig,
            workingAgentProcessRunner: options.workingAgentProcessRunner,
            providerWorkingRunner: options.providerWorkingRunner,
            processRunner: options.processRunner,
          })
        : await runContinuation({
            node: rootNode,
            runId,
            workflowId: options.workflow.id,
            emit,
            maxSteps,
            initialSource: isRetry
              ? `retry for workflow ${options.workflow.id}`
              : isResume
                ? `resume for workflow ${options.workflow.id}`
                : `workflow.start for workflow ${options.workflow.id}`,
            // The original run already used one step-index slot per step.started
            // event ever recorded (successful or failed) -- newly-dispatched steps
            // after resume must continue that sequence, not restart at 1, or their
            // artifact directories collide with the pre-resume steps' directories.
            initialExecutedSteps:
              isResume || isRetry || isWaitContinue
                ? previousEvents.filter((event) => event.type === "step.started").length
                : undefined,
            ...(waitResume === undefined
              ? {}
              : {
                  resumeWait: {
                    stepId: waitResume.resumedStepId,
                    stepIndex: waitResume.stepIndex,
                    phaseIndex: waitResume.phaseIndex,
                    phaseValue: waitResume.phaseValue,
                    waitOutputs: waitResume.waitOutputs,
                    seenWaitIds: waitResume.seenWaitIds,
                    wait: waitResume.wait,
                  },
                }),
            workflowAgents: options.workflow.agents ?? {},
            workflowTimeout: options.workflow.timeout,
            runDir,
            projectCwd,
            cwd,
            trailstepConfig,
            workingAgentProcessRunner: options.workingAgentProcessRunner,
            providerWorkingRunner: options.providerWorkingRunner,
            processRunner: options.processRunner,
          });

    if (continuationResult.status === "failure") {
      return await failWorkflow(continuationResult.failure, continuationResult.message);
    }

    if (continuationResult.status === "cancelled") {
      return await cancelWorkflow(continuationResult.cancellation);
    }

    if (continuationResult.status === "waiting") {
      return {
        status: "waiting",
        runId,
        runDir,
        wait: continuationResult.wait,
        events,
      } as unknown as Result<TOutput>;
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
        payload: {
          output,
          ...(continuationResult.message === undefined
            ? {}
            : { message: continuationResult.message }),
        },
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

function readPreviousTerminalWorkflowStatus(
  events: readonly Event[],
): "completed" | "failed" | "cancelled" | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "workflow.completed") {
      return "completed";
    }
    if (event?.type === "workflow.failed") {
      return "failed";
    }
    if (event?.type === "workflow.cancelled") {
      return "cancelled";
    }
  }

  return undefined;
}

function readExistingCancellationEvent(events: readonly Event[]): CancellationMarker | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "workflow.cancelled") {
      continue;
    }

    return cancellationFromPayload(event.payload);
  }

  return undefined;
}

function cancellationFromPayload(payload: Record<string, unknown>): CancellationMarker {
  return {
    ...(typeof payload.requestedAt === "string" ? { requestedAt: payload.requestedAt } : {}),
    ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
    ...(typeof payload.source === "string" ? { source: payload.source } : {}),
  };
}
