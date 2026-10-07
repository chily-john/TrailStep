import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { normalizeShape } from "../../authoring/shape/json-schema.js";
import type { ContinuationResult } from "../../authoring/step/continuation.types.js";
import type { Failure } from "../../contracts/failures/failure.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import type {
  Event,
  Result,
  RunWorkflowOptions,
} from "../../runtime/run-workflow/run-workflow.types.js";
import { appendEvent, readRunState, writeRunState } from "../artifacts/run-storage.js";
import {
  type CancellationMarker,
  cancellationPayload,
  isWorkflowCancellationError,
  readCancellationMarker,
} from "../cancellation/cancellation.js";
import { runContinuation } from "../continuation/run-continuation/run-continuation.js";
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
import { runRootContinuationArrayScheduler } from "./root-continuation-array-scheduler.js";
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
    let isWaitContinueTrackResume = false;
    let branchResumes: Record<string, import("../continuation/run-continuation/run-continuation.js").ResumeWaitOptions> = {};
    let isTrackRetry = false;

    if (isResume) {
      const danglingAnchor = findDanglingInteractiveSessionStart(previousEvents);
      const replay = await replayWithoutClobberingStateOnFailure(runDir, () =>
        danglingAnchor
          ? reattachInProgressStep({
              workflow: options.workflow,
              events: previousEvents,
              runDir,
            })
          : replayToFailedStep({
              workflow: options.workflow,
              events: previousEvents,
              runDir,
            }),
      );
      if (replay.status === "failure") {
        return failResumeValidation(replay.failure);
      }
      await runContext.state.hydratePersisted();

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
      const hasParallelTrack = await hasSupportedRootParallelTrackRetryMetadata(runDir);
      if (hasParallelTrack) {
        const answeredBranches = await findAnsweredParallelBranches(runDir);
        if (answeredBranches.length === 0) {
          return failResumeValidation({
            code: "continue_parallel_track_unsupported",
            message:
              "Continuing a waiting parallel track is not yet supported; retry the run or restart the workflow instead.",
          });
        }

        const persistedInput = readWorkflowStartedInput(previousEvents);
        if (persistedInput === undefined) {
          return failResumeValidation({
            code: "continue_target_not_found",
            message: "Continue target workflow started payload missing input.",
          });
        }
        await runContext.state.hydratePersisted();
        await runContext.globalState.hydratePersisted();
        workflowInput = inputSchema
          ? (inputSchema.assert(persistedInput, "workflow input") as TInput)
          : (persistedInput as TInput);
        startNode = options.workflow.start(workflowInput);
        isWaitContinueTrackResume = true;
        waitResume = undefined;

        branchResumes = {};
        for (const branchId of answeredBranches) {
          const replay = await replayWithoutClobberingStateOnFailure(runDir, () =>
            replayToWaitingStep({
              workflow: options.workflow,
              events: previousEvents,
              runDir,
              branchId,
            }),
          );
          if (replay.status === "success") {
            branchResumes[branchId] = {
              stepId: replay.resumedStepId,
              stepIndex: replay.stepIndex,
              phaseIndex: replay.phaseIndex,
              phaseValue: replay.phaseValue,
              waitOutputs: replay.waitOutputs,
              seenWaitIds: replay.seenWaitIds,
              wait: replay.wait,
            } as import("../continuation/run-continuation/run-continuation.js").ResumeWaitOptions;
          }
        }

        const firstReplay = await replayWithoutClobberingStateOnFailure(runDir, () =>
          replayToWaitingStep({
            workflow: options.workflow,
            events: previousEvents,
            runDir,
            branchId: answeredBranches[0],
          }),
        );
        if (firstReplay.status === "success") {
          await emit(
            createEvent({
              runId,
              workflowId: options.workflow.id,
              type: "workflow.resumed",
              payload: {
                resumeKind: "wait",
                resumedFromRunDir: runDir,
                resumedStepId: firstReplay.resumedStepId,
                sourceWaitEventId: firstReplay.sourceWaitEventId,
              },
            }),
          );
        }
      } else {
        const replay = await replayWithoutClobberingStateOnFailure(runDir, () =>
          replayToWaitingStep({
            workflow: options.workflow,
            events: previousEvents,
            runDir,
          }),
        );
        if (replay.status === "failure") {
          return failResumeValidation(replay.failure);
        }
        await runContext.state.hydratePersisted();

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
      }
    } else if (isRetry) {
      if (await hasSupportedRootParallelTrackRetryMetadata(runDir)) {
        const persistedInput = readWorkflowStartedInput(previousEvents);
        if (persistedInput === undefined) {
          return failResumeValidation({
            code: "retry_target_not_found",
            message: "workflow.started payload is missing input.",
          });
        }
        await runContext.state.hydratePersisted();
        await runContext.globalState.hydratePersisted();
        workflowInput = inputSchema
          ? (inputSchema.assert(persistedInput, "workflow input") as TInput)
          : (persistedInput as TInput);
        isTrackRetry = true;
        await emit(
          createEvent({
            runId,
            workflowId: options.workflow.id,
            type: "workflow.retryStarted",
            payload: {
              retryKind: options.retry.kind,
              retryPlanner: "track",
              retriedFromRunDir: runDir,
            },
          }),
        );
      } else {
        const replay = await replayWithoutClobberingStateOnFailure(runDir, () =>
          replayToRetryFailure({
            workflow: options.workflow,
            events: previousEvents,
            runDir,
          }),
        );
        if (replay.status === "failure") {
          return failResumeValidation(replay.failure);
        }
        await runContext.state.hydratePersisted();

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
      }
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
    const rootNodes = Array.isArray(rootNode) ? rootNode : [rootNode];
    const shouldUseRootArrayScheduler =
      (!isResume && !isRetry && !isWaitContinue) || isTrackRetry || isWaitContinueTrackResume;
    const continuationResult = shouldUseRootArrayScheduler
      ? await runRootContinuationArrayScheduler({
          nodes: rootNodes,
          ...(Array.isArray(rootNode) ? { rootIsArray: true } : {}),
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
          ...(isTrackRetry
            ? {
                retry: {
                  initialExecutedSteps: previousEvents.filter(
                    (event) => event.type === "step.started",
                  ).length,
                  track: options.retry?.track,
                },
              }
            : isWaitContinueTrackResume
              ? {
                  retry: {
                    initialExecutedSteps: previousEvents.filter(
                      (event) => event.type === "step.started",
                    ).length,
                    track: { mode: "wait-answered" } as import("./run-workflow.types.js").RunWorkflowTrackRetryOptions,
                  },
                  waitResumeBranches: branchResumes,
                }
              : {}),
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

    if (
      continuationResult.status === "failure" ||
      continuationResult.status === "absoluteFailure"
    ) {
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

    if (continuationResult.status === "split") {
      return await failWorkflow({
        code: "unsupported_continuation",
        message: "A continuation array escaped workflow scheduling.",
      });
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

async function replayWithoutClobberingStateOnFailure<T extends { readonly status: string }>(
  runDir: string,
  replay: () => Promise<T>,
): Promise<T> {
  const stateBeforeReplay = await readRunState(runDir);
  const result = await replay();
  if (result.status === "failure") {
    await writeRunState(runDir, stateBeforeReplay);
  }
  return result;
}

async function hasSupportedRootParallelTrackRetryMetadata(runDir: string): Promise<boolean> {
  try {
    const track = JSON.parse(await readFile(join(runDir, "track.json"), "utf8")) as {
      readonly rootBranchId?: unknown;
      readonly splitOccurred?: unknown;
      readonly branches?: unknown;
    };
    if (
      track.splitOccurred !== true ||
      typeof track.rootBranchId !== "string" ||
      !Array.isArray(track.branches) ||
      !track.branches.every((branchId): branchId is string => typeof branchId === "string")
    ) {
      return false;
    }

    const branches = await Promise.all(
      track.branches.map(async (branchId) => {
        const branch = JSON.parse(
          await readFile(join(runDir, "branches", `${branchId}.json`), "utf8"),
        ) as { readonly branchId?: unknown; readonly parentBranchId?: unknown };
        return branch;
      }),
    );

    return branches.every((branch) =>
      branch.branchId === track.rootBranchId
        ? branch.parentBranchId === undefined
        : branch.parentBranchId === track.rootBranchId,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function findAnsweredParallelBranches(runDir: string): Promise<string[]> {
  try {
    const track = JSON.parse(await readFile(join(runDir, "track.json"), "utf8")) as {
      readonly splitOccurred?: unknown;
      readonly branches?: unknown;
    };
    if (track.splitOccurred !== true || !Array.isArray(track.branches)) {
      return [];
    }
    const answered: string[] = [];
    for (const branchId of track.branches as unknown[]) {
      if (typeof branchId !== "string") continue;
      let branchState: { readonly status?: unknown; readonly wait?: unknown } | undefined;
      try {
        branchState = JSON.parse(await readFile(join(runDir, "branches", `${branchId}.json`), "utf8")) as {
          readonly status?: unknown;
          readonly wait?: unknown;
        };
      } catch {
        continue;
      }
      if (branchState?.status !== "waiting") continue;
      if (branchState.wait === undefined || typeof branchState.wait !== "object" || branchState.wait === null) {
        continue;
      }
      const wait = branchState.wait as {
        readonly artifactPaths?: { readonly answerFile?: unknown };
      };
      const answerFile = wait.artifactPaths?.answerFile;
      if (typeof answerFile !== "string") continue;
      try {
        await readFile(join(runDir, answerFile), "utf8");
        answered.push(branchId);
      } catch {
        // no recorded answer artifact
      }
    }
    return answered;
  } catch {
    return [];
  }
}

function readWorkflowStartedInput(events: readonly Event[]): PlainObject | undefined {
  const started = events.find((event) => event.type === "workflow.started");
  const input = started?.payload.input;
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as PlainObject)
    : undefined;
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
