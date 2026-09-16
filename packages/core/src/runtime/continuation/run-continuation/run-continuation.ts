import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dispatchAgentStep } from "../../../agent-execution/dispatch-agent-step/dispatch-agent-step.js";
import type { TrailStepConfig } from "../../../agent-targeting/targeting.types.js";
import { jsonSchema, normalizeShape } from "../../../authoring/shape/json-schema.js";
import type {
  CheckWaitHelpers,
  ContinuationResult,
  DisplayPhase,
  PromptPhase,
  StepCwdInput,
  StepDisplayValue,
  StepNode,
  WaitCheckResult,
  WaitDefinition,
  WaitPhase,
} from "../../../authoring/step/continuation.types.js";
import {
  firstPromptPhase,
  getStepPhases,
  isAbsoluteDoneNode,
  isAbsoluteFailNode,
  isDoneNode,
  isFailNode,
  isStepNode,
  isWorkflowInvocationNode,
} from "../../../authoring/step/step-node.js";
import type { WorkflowAgentRole } from "../../../contracts/agents/agent-role.types.js";
import type { Failure } from "../../../contracts/failures/failure.js";
import { TrailStepFailureError } from "../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import type {
  Event,
  RunWorkflowOptions,
} from "../../../runtime/run-workflow/run-workflow.types.js";
import {
  resolveStepArtifactPaths,
  resolveWaitArtifactPaths,
  type WaitArtifactPaths,
} from "../../artifacts/step-artifacts.js";
import {
  type CancellationMarker,
  cancellationPayload,
  isWorkflowCancellationError,
  readCancellationMarker,
  throwIfCancellationRequested,
  WorkflowCancellationError,
} from "../../cancellation/cancellation.js";
import { createEvent } from "../../events/create-run-event.js";
import { stepExecutionFailure } from "../../failures/step-execution-failure.js";
import { runContextStorage } from "../../run-context/run-context-storage.js";
import { withStepContext } from "../../run-context/with-step-context.js";
import { validateDirectoryCwd } from "../../run-workflow/cwd.js";
import type { TimeoutPolicyInput } from "../../timeout/timeout-policy.js";
import { resolveTimeoutPolicy } from "../../timeout/timeout-policy.js";
import { resolveStepOutputSchema } from "../resolve-step-output-schema/resolve-step-output-schema.js";

export interface RunContinuationOptions {
  readonly node: ContinuationResult;
  readonly runId: string;
  readonly workflowId: string;
  readonly emit: (event: Event) => Promise<void>;
  readonly maxSteps: number;
  readonly initialSource: string;
  readonly initialExecutedSteps?: number;
  readonly allocateStepIndex?: () => number;
  readonly workflowAgents: Readonly<Record<string, WorkflowAgentRole>>;
  readonly workflowTimeout?: TimeoutPolicyInput;
  readonly runDir: string;
  readonly projectCwd?: string;
  readonly cwd: string;
  readonly trailstepConfig?: TrailStepConfig;
  readonly workingAgentProcessRunner?: RunWorkflowOptions["workingAgentProcessRunner"];
  readonly providerWorkingRunner?: RunWorkflowOptions["providerWorkingRunner"];
  readonly processRunner?: RunWorkflowOptions["processRunner"];
  readonly resumeWait?: ResumeWaitOptions;
}

export interface ResumeWaitOptions {
  readonly stepId: string;
  readonly stepIndex: number;
  readonly phaseIndex: number;
  readonly phaseValue: PlainObject;
  readonly waitOutputs: Readonly<Record<string, PlainObject>>;
  readonly seenWaitIds: readonly string[];
  readonly wait: ResumedWaitDetails;
}

type WaitKind = "input" | "check";

export interface ResumedWaitDetails {
  readonly waitId: string;
  readonly kind: WaitKind;
  readonly message: string;
  readonly artifactPaths: WaitArtifactPaths;
  readonly outputSchema: Record<string, unknown>;
}

export interface WaitingWait {
  readonly stepId: string;
  readonly waitId: string;
  readonly kind?: WaitKind;
  readonly message: string;
  readonly retryAfterSeconds?: number;
  readonly artifactPaths: WaitArtifactPaths;
}

export type RunContinuationResult =
  | { readonly status: "success"; readonly output: PlainObject; readonly message?: string }
  | { readonly status: "failure"; readonly failure: Failure; readonly message?: string }
  | { readonly status: "waiting"; readonly wait: WaitingWait }
  | { readonly status: "cancelled"; readonly cancellation: CancellationMarker };

export async function runContinuation(
  options: RunContinuationOptions,
): Promise<RunContinuationResult> {
  let node: ContinuationResult = options.node;
  let source = options.initialSource;
  // A resumed run's newly-dispatched steps must continue the on-disk step
  // index sequence from where the original run left off (every step.started
  // ever recorded, successful or failed), not restart at 1 -- otherwise their
  // artifact directories collide with/shadow the pre-resume steps' dirs.
  let executedSteps = options.initialExecutedSteps ?? 0;
  let pendingResumeWait = options.resumeWait;
  const trailstepConfig = options.trailstepConfig;

  while (true) {
    const pendingCancellation = await readCancellationMarker(options.runDir);
    if (pendingCancellation !== undefined) {
      return { status: "cancelled", cancellation: pendingCancellation };
    }

    if (isDoneNode(node)) {
      return {
        status: "success",
        output: node.output,
        ...(node.message === undefined ? {} : { message: node.message }),
      };
    }

    if (isFailNode(node)) {
      return {
        status: "failure",
        failure: node.failure,
        ...(node.message === undefined ? {} : { message: node.message }),
      };
    }

    const unsupportedFailure = unsupportedContinuationFailure(node, source);
    if (unsupportedFailure !== undefined) {
      return {
        status: "failure",
        failure: unsupportedFailure,
      };
    }

    if (!isStepNode(node)) {
      return {
        status: "failure",
        failure: continuationFailure(source),
      };
    }

    const stepNode = node;
    const { config } = stepNode;
    const resumeWait = pendingResumeWait;
    if (resumeWait !== undefined && resumeWait.stepId !== config.id) {
      return {
        status: "failure",
        failure: continuationFailure(`wait resume for step ${resumeWait.stepId}`),
      };
    }

    let stepIndex: number;
    if (resumeWait === undefined) {
      if (executedSteps >= options.maxSteps) {
        return {
          status: "failure",
          failure: stepExecutionFailure(
            new Error(`workflow exceeded maxSteps guard (${options.maxSteps})`),
          ),
        };
      }
      if (options.allocateStepIndex !== undefined) {
        stepIndex = options.allocateStepIndex();
        executedSteps += 1;
      } else {
        executedSteps += 1;
        stepIndex = executedSteps;
      }
    } else {
      stepIndex = resumeWait.stepIndex;
      pendingResumeWait = undefined;
    }
    const phases = getStepPhases(stepNode);
    const hasPrompt = phases.some((phase) => phase.kind === "prompt");
    const timeoutPolicy = resolveTimeoutPolicy({
      global: trailstepConfig?.settings?.timeout,
      workflow:
        options.workflowTimeout ??
        trailstepConfig?.workflows?.[options.workflowId]?.settings?.timeout,
      step: config.timeout,
    });
    const maxSubPrompts =
      firstPromptPhase(phases)?.maxSubPrompts ??
      config.maxSubPrompts ??
      trailstepConfig?.workflows?.[options.workflowId]?.settings?.maxSubPrompts;

    if (resumeWait === undefined) {
      await options.emit(
        createEvent({
          runId: options.runId,
          workflowId: options.workflowId,
          stepId: config.id,
          type: "step.started",
          payload: {
            stepName: config.id,
            ...(config.title === undefined ? {} : { title: config.title }),
            ...(config.description === undefined ? {} : { description: config.description }),
            kind: hasPrompt ? "agent" : "code",
          },
        }),
      );
    }

    try {
      const stepCwd = await resolveStepExecutionCwd({
        stepId: config.id,
        workflowId: options.workflowId,
        defaultCwd: options.cwd,
        input: config.input,
        cwdInput: config.cwd,
      });
      const stepArtifacts = resolveStepArtifactPaths({
        runDir: options.runDir,
        stepId: config.id,
        stepIndex,
      });

      const stepResult = await runWithStepControl({
        stepId: config.id,
        timeoutMs: timeoutPolicy.timeoutMs,
        readCancellation: async () => await readCancellationMarker(options.runDir),
        run: async (signal) =>
          await withStepContext(
            config.id,
            stepArtifacts.stepDir,
            async () => {
              const phaseResult = await runStepPhases({
                stepNode,
                timeoutMs: timeoutPolicy.timeoutMs,
                signal,
                readCancellation: async () => await readCancellationMarker(options.runDir),
                ...(resumeWait === undefined
                  ? {}
                  : {
                      resume: {
                        startPhaseIndex: resumeWait.phaseIndex,
                        phaseValue: resumeWait.phaseValue,
                        waitOutputs: resumeWait.waitOutputs,
                        seenWaitIds: resumeWait.seenWaitIds,
                        wait: resumeWait.wait,
                      },
                    }),
                emitDisplay: async (phase, output, phaseIndex) => {
                  const payload = await resolveDisplayPayload({
                    phase,
                    input: config.input,
                    output,
                    phaseIndex,
                    stepId: config.id,
                  });

                  await options.emit(
                    createEvent({
                      runId: options.runId,
                      workflowId: options.workflowId,
                      stepId: config.id,
                      type: "step.display",
                      payload,
                    }),
                  );
                },
                handleWait: async (phase, output, phaseIndex, waits, previousWaitId) => {
                  return await handleWaitPhase({
                    phase,
                    input: config.input,
                    output,
                    waits,
                    phaseIndex,
                    previousWaitId,
                    stepId: config.id,
                    stepArtifactId: stepArtifacts.artifactStepId,
                    runDir: options.runDir,
                    runId: options.runId,
                    workflowId: options.workflowId,
                    emit: options.emit,
                  });
                },
                handleResumedWait: async (wait) =>
                  await handleResumedWaitPhase({
                    wait,
                    stepId: config.id,
                    runDir: options.runDir,
                    runId: options.runId,
                    workflowId: options.workflowId,
                    emit: options.emit,
                  }),
                dispatchPrompt: async (phase) => {
                  const outputSchema = resolveStepOutputSchema(phase);
                  if (!outputSchema) {
                    throw new Error(`step ${config.id} with a prompt requires an output shape`);
                  }

                  const rawOutput = await dispatchAgentStep({
                    config: { ...config, ...phase },
                    outputSchema,
                    interactiveOutputMode:
                      phase.mode === "interactive" && phase.output !== undefined
                        ? "json"
                        : "session-file",
                    runId: options.runId,
                    workflowId: options.workflowId,
                    emit: options.emit,
                    workflowAgents: options.workflowAgents,
                    runDir: options.runDir,
                    projectCwd: options.projectCwd ?? options.cwd,
                    cwd: stepCwd,
                    trailstepConfig,
                    workingAgentProcessRunner: options.workingAgentProcessRunner,
                    providerWorkingRunner: options.providerWorkingRunner,
                    processRunner: options.processRunner,
                    stepIndex,
                    signal,
                  });
                  throwIfStepTimedOut(signal, config.id, timeoutPolicy.timeoutMs);
                  const output = outputSchema.assert(rawOutput, `step ${config.id} output`);

                  await options.emit(
                    createEvent({
                      runId: options.runId,
                      workflowId: options.workflowId,
                      stepId: config.id,
                      type: "step.completed",
                      payload: { output },
                    }),
                  );

                  return output;
                },
              });

              if (phaseResult.status === "waiting") {
                return phaseResult;
              }

              const nextNode = phaseResult.node;
              if (isFailNode(nextNode)) {
                await options.emit(
                  createEvent({
                    runId: options.runId,
                    workflowId: options.workflowId,
                    stepId: config.id,
                    type: "step.failed",
                    payload: { failure: nextNode.failure },
                  }),
                );
                return phaseResult;
              }

              if (!hasPrompt) {
                // A no-prompt step's .do(...) IS its work — only report completion once it has
                // actually run without throwing or returning fail(...), matching the with-prompt
                // case's "step.completed means the step's own work succeeded" meaning.
                await options.emit(
                  createEvent({
                    runId: options.runId,
                    workflowId: options.workflowId,
                    stepId: config.id,
                    type: "step.completed",
                    payload: {},
                  }),
                );
              }

              throwIfStepTimedOut(signal, config.id, timeoutPolicy.timeoutMs);
              return phaseResult;
            },
            { maxSubPrompts, cwd: stepCwd, executionCwd: stepCwd },
          ),
      });

      if (stepResult.status === "waiting") {
        return stepResult;
      }

      const nextNode = stepResult.node;
      const unsupportedStepFailure = unsupportedContinuationFailure(nextNode, `step ${config.id}`);
      if (unsupportedStepFailure !== undefined) {
        await options.emit(
          createEvent({
            runId: options.runId,
            workflowId: options.workflowId,
            stepId: config.id,
            type: "step.failed",
            payload: { failure: unsupportedStepFailure },
          }),
        );
        return { status: "failure", failure: unsupportedStepFailure };
      }

      if (!isStepNode(nextNode) && !isDoneNode(nextNode) && !isFailNode(nextNode)) {
        const failure = continuationFailure(`step ${config.id}`);
        await options.emit(
          createEvent({
            runId: options.runId,
            workflowId: options.workflowId,
            stepId: config.id,
            type: "step.failed",
            payload: { failure },
          }),
        );
        return { status: "failure", failure };
      }

      if (isFailNode(nextNode)) {
        return {
          status: "failure",
          failure: nextNode.failure,
          ...(nextNode.message === undefined ? {} : { message: nextNode.message }),
        };
      }

      node = nextNode;
      source = `step ${config.id}`;
    } catch (error) {
      if (isWorkflowCancellationError(error)) {
        await options.emit(
          createEvent({
            runId: options.runId,
            workflowId: options.workflowId,
            stepId: config.id,
            type: "step.cancelled",
            payload: cancellationPayload(error.cancellation),
          }),
        );
        return { status: "cancelled", cancellation: error.cancellation };
      }

      const failure = stepExecutionFailure(error);

      await options.emit(
        createEvent({
          runId: options.runId,
          workflowId: options.workflowId,
          stepId: config.id,
          type: "step.failed",
          payload: { failure },
        }),
      );

      if (!stepNode.onError) {
        return { status: "failure", failure };
      }

      try {
        const nextNode = stepNode.onError(failure);
        const errorSource = `error continuation for step ${config.id}`;
        const unsupportedErrorFailure = unsupportedContinuationFailure(nextNode, errorSource);
        if (unsupportedErrorFailure !== undefined) {
          return {
            status: "failure",
            failure: unsupportedErrorFailure,
          };
        }

        if (!isStepNode(nextNode) && !isDoneNode(nextNode) && !isFailNode(nextNode)) {
          return {
            status: "failure",
            failure: continuationFailure(errorSource),
          };
        }

        node = nextNode;
        source = errorSource;
      } catch (errorContinuationError) {
        return {
          status: "failure",
          failure: stepExecutionFailure(
            new Error(
              `error continuation for step ${config.id} failed: ${errorMessage(errorContinuationError)}`,
            ),
          ),
        };
      }
    }
  }
}

type RunStepPhasesResult =
  | { readonly status: "continued"; readonly node: ContinuationResult }
  | { readonly status: "waiting"; readonly wait: WaitingWait };

type HandleWaitResult =
  | { readonly status: "satisfied"; readonly waitId: string; readonly output: PlainObject }
  | { readonly status: "waiting"; readonly wait: WaitingWait };

async function resolveStepExecutionCwd(options: {
  readonly stepId: string;
  readonly workflowId: string;
  readonly defaultCwd: string;
  readonly input: PlainObject;
  readonly cwdInput: StepCwdInput | undefined;
}): Promise<string> {
  if (options.cwdInput === undefined) {
    return options.defaultCwd;
  }

  const cwd =
    typeof options.cwdInput === "function"
      ? await resolveStepCwdCallback(options.cwdInput, options)
      : options.cwdInput;

  if (typeof cwd !== "string") {
    throw new TypeError(`step ${options.stepId} cwd must resolve to a string.`);
  }

  await validateDirectoryCwd(cwd, `step ${options.stepId} cwd`);
  return cwd;
}

async function resolveStepCwdCallback(
  cwdInput: Exclude<StepCwdInput, string>,
  options: {
    readonly stepId: string;
    readonly workflowId: string;
    readonly input: PlainObject;
  },
): Promise<unknown> {
  const context = runContextStorage.getStore();
  if (!context) {
    throw new Error(`step ${options.stepId} cwd callback requires an active run context.`);
  }

  return await cwdInput({
    input: options.input,
    state: context.state,
    workflow: { id: options.workflowId },
  });
}

async function runStepPhases(options: {
  readonly stepNode: StepNode;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly readCancellation: () => Promise<CancellationMarker | undefined>;
  readonly emitDisplay: (
    phase: DisplayPhase,
    output: PlainObject,
    phaseIndex: number,
  ) => Promise<void>;
  readonly handleWait: (
    phase: WaitPhase,
    output: PlainObject,
    phaseIndex: number,
    waits: Readonly<Record<string, PlainObject>>,
    previousWaitId?: string,
  ) => Promise<HandleWaitResult>;
  readonly handleResumedWait: (wait: ResumedWaitDetails) => Promise<HandleWaitResult>;
  readonly dispatchPrompt: (phase: PromptPhase) => Promise<PlainObject>;
  readonly resume?: {
    readonly startPhaseIndex: number;
    readonly phaseValue: PlainObject;
    readonly waitOutputs: Readonly<Record<string, PlainObject>>;
    readonly seenWaitIds: readonly string[];
    readonly wait: ResumedWaitDetails;
  };
}): Promise<RunStepPhasesResult> {
  const { stepNode } = options;
  let phaseValue = options.resume?.phaseValue ?? stepNode.config.input;
  let nextNode: ContinuationResult | undefined;
  const waitOutputs: Record<string, PlainObject> = { ...(options.resume?.waitOutputs ?? {}) };
  const seenWaitIds = new Set<string>(options.resume?.seenWaitIds ?? []);
  const phases = getStepPhases(stepNode);
  assertNoDuplicateStaticWaitIds(phases, stepNode.config.id);

  for (const [phaseIndex, phase] of phases.entries()) {
    if (phaseIndex < (options.resume?.startPhaseIndex ?? 0)) {
      continue;
    }
    throwIfCancellationRequested(await options.readCancellation());

    if (phase.kind === "display") {
      await options.emitDisplay(phase, phaseValue, phaseIndex);
      throwIfCancellationRequested(await options.readCancellation());
      throwIfStepTimedOut(options.signal, stepNode.config.id, options.timeoutMs);
      continue;
    }

    if (phase.kind === "wait") {
      const waitResult =
        options.resume !== undefined && phaseIndex === options.resume.startPhaseIndex
          ? options.resume.wait.kind === "check"
            ? await options.handleWait(
                phase,
                phaseValue,
                phaseIndex,
                waitOutputs,
                options.resume.wait.waitId,
              )
            : await options.handleResumedWait(options.resume.wait)
          : await options.handleWait(phase, phaseValue, phaseIndex, waitOutputs);
      const waitId = waitResult.status === "waiting" ? waitResult.wait.waitId : waitResult.waitId;
      if (seenWaitIds.has(waitId)) {
        throw new Error(`step ${stepNode.config.id} has duplicate wait id '${waitId}'`);
      }
      seenWaitIds.add(waitId);

      if (waitResult.status === "waiting") {
        throwIfCancellationRequested(await options.readCancellation());
        return waitResult;
      }

      waitOutputs[waitResult.waitId] = waitResult.output;
      throwIfCancellationRequested(await options.readCancellation());
      throwIfStepTimedOut(options.signal, stepNode.config.id, options.timeoutMs);
      continue;
    }

    if (nextNode !== undefined) {
      throw new Error(`step ${stepNode.config.id} has executable phases after a do phase`);
    }

    if (phase.kind === "prompt") {
      phaseValue = await options.dispatchPrompt(phase);
      throwIfCancellationRequested(await options.readCancellation());
      throwIfStepTimedOut(options.signal, stepNode.config.id, options.timeoutMs);
      continue;
    }

    nextNode = await phase.onOutput(
      withWaitsDoContext(phaseValue, waitOutputs),
      stepNode.config.input,
    );
    throwIfCancellationRequested(await options.readCancellation());
    throwIfStepTimedOut(options.signal, stepNode.config.id, options.timeoutMs);
  }

  if (nextNode === undefined) {
    throw new Error(`step ${stepNode.config.id} has no do phase`);
  }

  return { status: "continued", node: nextNode };
}

function assertNoDuplicateStaticWaitIds(phases: readonly unknown[], stepId: string): void {
  const seenWaitIds = new Set<string>();
  for (const phase of phases) {
    if (!isPlainObject(phase) || phase.kind !== "wait") {
      continue;
    }
    const wait = phase.wait;
    if (typeof wait === "function" || !isPlainObject(wait) || typeof wait.id !== "string") {
      continue;
    }
    if (seenWaitIds.has(wait.id)) {
      throw new Error(`step ${stepId} has duplicate wait id '${wait.id}'`);
    }
    seenWaitIds.add(wait.id);
  }
}

async function handleWaitPhase(options: {
  readonly phase: WaitPhase;
  readonly input: PlainObject;
  readonly output: PlainObject;
  readonly waits: Readonly<Record<string, PlainObject>>;
  readonly phaseIndex: number;
  readonly previousWaitId?: string;
  readonly stepId: string;
  readonly stepArtifactId: string;
  readonly runDir: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly emit: (event: Event) => Promise<void>;
}): Promise<HandleWaitResult> {
  if (options.phase.options !== undefined) {
    return await handleCheckWaitPhase({
      ...options,
      phase: options.phase as WaitPhase & { readonly options: NonNullable<WaitPhase["options"]> },
    });
  }

  const wait = await resolveWaitDefinition(options.phase, {
    input: options.input,
    output: options.output,
    waits: options.waits,
  });
  validateWaitDefinition(wait, options.stepId, options.phaseIndex);

  const artifactPaths = resolveWaitArtifactPaths({
    runDir: options.runDir,
    stepArtifactId: options.stepArtifactId,
    waitId: wait.id,
  });
  const request = {
    stepId: options.stepId,
    waitId: wait.id,
    kind: wait.kind,
    message: wait.message,
    phaseIndex: options.phaseIndex,
    outputSchema: normalizeShape(wait.output).jsonSchema,
  };

  await mkdir(artifactPaths.waitDir, { recursive: true });
  await writeFile(artifactPaths.requestFile, `${JSON.stringify(request, null, 2)}\n`, "utf8");

  const answerText = await readTextIfExists(artifactPaths.answerFile);
  if (answerText.status === "missing") {
    const waiting = {
      stepId: options.stepId,
      waitId: wait.id,
      message: wait.message,
      artifactPaths: artifactPaths.runRelative,
    };
    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: options.stepId,
        type: "wait.started",
        payload: {
          waitId: wait.id,
          kind: wait.kind,
          message: wait.message,
          phaseIndex: options.phaseIndex,
          artifactPaths: artifactPaths.runRelative,
        },
      }),
    );
    return { status: "waiting", wait: waiting };
  }

  try {
    const parsedAnswer: unknown = JSON.parse(answerText.value);
    if (!isPlainObject(parsedAnswer)) {
      throw new TypeError(`step ${options.stepId} wait ${wait.id} answer must be a plain object`);
    }
    const output = normalizeShape(wait.output).assert(
      parsedAnswer,
      `step ${options.stepId} wait ${wait.id} answer`,
    );
    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: options.stepId,
        type: "wait.satisfied",
        payload: {
          waitId: wait.id,
          kind: wait.kind,
          message: wait.message,
          phaseIndex: options.phaseIndex,
          artifactPaths: artifactPaths.runRelative,
          output,
        },
      }),
    );
    return { status: "satisfied", waitId: wait.id, output };
  } catch (error) {
    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: options.stepId,
        type: "wait.failed",
        payload: {
          waitId: wait.id,
          kind: wait.kind,
          message: wait.message,
          phaseIndex: options.phaseIndex,
          artifactPaths: artifactPaths.runRelative,
          failure: stepExecutionFailure(error),
        },
      }),
    );
    throw error;
  }
}

async function handleCheckWaitPhase(options: {
  readonly phase: WaitPhase & { readonly options: NonNullable<WaitPhase["options"]> };
  readonly input: PlainObject;
  readonly output: PlainObject;
  readonly waits: Readonly<Record<string, PlainObject>>;
  readonly phaseIndex: number;
  readonly previousWaitId?: string;
  readonly stepId: string;
  readonly stepArtifactId: string;
  readonly runDir: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly emit: (event: Event) => Promise<void>;
}): Promise<HandleWaitResult> {
  const outputSchema = normalizeShape(options.phase.options.output);
  const defaultWaitId = options.previousWaitId ?? `check-${options.phaseIndex}`;
  let waitId = defaultWaitId;

  try {
    if (typeof options.phase.wait !== "function") {
      throw new TypeError(
        `step ${options.stepId} check wait phase ${options.phaseIndex} requires a callback.`,
      );
    }

    const check = options.phase.wait as (context: {
      readonly input: PlainObject;
      readonly output: PlainObject;
      readonly waits: Readonly<Record<string, PlainObject>>;
      readonly wait: CheckWaitHelpers<PlainObject>;
    }) => WaitCheckResult | Promise<WaitCheckResult>;
    const result = await check({
      input: options.input,
      output: options.output,
      waits: options.waits,
      wait: createCheckWaitHelpers(),
    });
    validateCheckWaitResult(result, options.stepId, options.phaseIndex);

    if (result.status === "pending") {
      validatePendingWait(result, options.stepId, options.phaseIndex);
      waitId = result.id;
      const artifactPaths = resolveWaitArtifactPaths({
        runDir: options.runDir,
        stepArtifactId: options.stepArtifactId,
        waitId,
      });
      const request = {
        stepId: options.stepId,
        waitId,
        kind: "check",
        message: result.message,
        phaseIndex: options.phaseIndex,
        ...(result.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: result.retryAfterSeconds }),
        outputSchema: outputSchema.jsonSchema,
      };

      await mkdir(artifactPaths.waitDir, { recursive: true });
      await writeFile(artifactPaths.requestFile, `${JSON.stringify(request, null, 2)}\n`, "utf8");

      await options.emit(
        createEvent({
          runId: options.runId,
          workflowId: options.workflowId,
          stepId: options.stepId,
          type: "wait.started",
          payload: {
            waitId,
            kind: "check",
            message: result.message,
            phaseIndex: options.phaseIndex,
            ...(result.retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds: result.retryAfterSeconds }),
            artifactPaths: artifactPaths.runRelative,
          },
        }),
      );

      return {
        status: "waiting",
        wait: {
          stepId: options.stepId,
          waitId,
          kind: "check",
          message: result.message,
          ...(result.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: result.retryAfterSeconds }),
          artifactPaths: artifactPaths.runRelative,
        },
      };
    }

    const output = outputSchema.assert(
      result.output,
      `step ${options.stepId} check wait ${waitId} output`,
    );
    const artifactPaths = resolveWaitArtifactPaths({
      runDir: options.runDir,
      stepArtifactId: options.stepArtifactId,
      waitId,
    });
    await mkdir(artifactPaths.waitDir, { recursive: true });
    await writeFile(
      artifactPaths.requestFile,
      `${JSON.stringify(
        {
          stepId: options.stepId,
          waitId,
          kind: "check",
          phaseIndex: options.phaseIndex,
          outputSchema: outputSchema.jsonSchema,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: options.stepId,
        type: "wait.satisfied",
        payload: {
          waitId,
          kind: "check",
          phaseIndex: options.phaseIndex,
          artifactPaths: artifactPaths.runRelative,
          output,
        },
      }),
    );
    return { status: "satisfied", waitId, output };
  } catch (error) {
    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: options.stepId,
        type: "wait.failed",
        payload: {
          waitId,
          kind: "check",
          phaseIndex: options.phaseIndex,
          failure: stepExecutionFailure(error),
        },
      }),
    );
    throw error;
  }
}

async function handleResumedWaitPhase(options: {
  readonly wait: ResumedWaitDetails;
  readonly stepId: string;
  readonly runDir: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly emit: (event: Event) => Promise<void>;
}): Promise<HandleWaitResult> {
  const answerFile = joinRunPath(options.runDir, options.wait.artifactPaths.answerFile);
  const answerText = await readTextIfExists(answerFile);
  if (answerText.status === "missing") {
    return {
      status: "waiting",
      wait: {
        stepId: options.stepId,
        waitId: options.wait.waitId,
        message: options.wait.message,
        artifactPaths: options.wait.artifactPaths,
      },
    };
  }

  try {
    const parsedAnswer: unknown = JSON.parse(answerText.value);
    if (!isPlainObject(parsedAnswer)) {
      throw new TypeError(
        `step ${options.stepId} wait ${options.wait.waitId} answer must be a plain object`,
      );
    }
    const output = jsonSchema<PlainObject>(options.wait.outputSchema).assert(
      parsedAnswer,
      `step ${options.stepId} wait ${options.wait.waitId} answer`,
    );
    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: options.stepId,
        type: "wait.satisfied",
        payload: {
          waitId: options.wait.waitId,
          kind: options.wait.kind,
          message: options.wait.message,
          artifactPaths: options.wait.artifactPaths,
          output,
        },
      }),
    );
    return { status: "satisfied", waitId: options.wait.waitId, output };
  } catch (error) {
    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: options.stepId,
        type: "wait.failed",
        payload: {
          waitId: options.wait.waitId,
          kind: options.wait.kind,
          message: options.wait.message,
          artifactPaths: options.wait.artifactPaths,
          failure: stepExecutionFailure(error),
        },
      }),
    );
    throw error;
  }
}

function joinRunPath(runDir: string, runRelativePath: string): string {
  return join(runDir, ...runRelativePath.split("/"));
}

async function resolveWaitDefinition(
  phase: WaitPhase,
  context: {
    readonly input: PlainObject;
    readonly output: PlainObject;
    readonly waits: Readonly<Record<string, PlainObject>>;
  },
): Promise<WaitDefinition> {
  if (typeof phase.wait !== "function") {
    return phase.wait;
  }

  const resolveInputWait = phase.wait as (context: {
    readonly input: PlainObject;
    readonly output: PlainObject;
    readonly waits: Readonly<Record<string, PlainObject>>;
  }) => WaitDefinition | Promise<WaitDefinition>;
  return await resolveInputWait(context);
}

function createCheckWaitHelpers<TWaitOutput extends PlainObject>(): CheckWaitHelpers<TWaitOutput> {
  return {
    done(output) {
      return { status: "done", output };
    },
    pending(input) {
      return {
        status: "pending",
        id: input.id,
        message: input.message,
        ...(input.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: input.retryAfterSeconds }),
      };
    },
  };
}

function validateCheckWaitResult(
  result: unknown,
  stepId: string,
  phaseIndex: number,
): asserts result is WaitCheckResult {
  const label = `step ${stepId} check wait phase ${phaseIndex}`;
  if (!isPlainObject(result)) {
    throw new TypeError(`${label} must return wait.done(...) or wait.pending(...).`);
  }

  if (result.status !== "done" && result.status !== "pending") {
    throw new TypeError(`${label} must return wait.done(...) or wait.pending(...).`);
  }

  if (result.status === "done" && !("output" in result)) {
    throw new TypeError(`${label} wait.done(...) requires output.`);
  }
}

function validatePendingWait(
  pending: WaitCheckResult,
  stepId: string,
  phaseIndex: number,
): asserts pending is Extract<WaitCheckResult, { readonly status: "pending" }> {
  const label = `step ${stepId} check wait phase ${phaseIndex}`;
  if (pending.status !== "pending") {
    throw new TypeError(`${label} expected a pending result.`);
  }

  if (typeof pending.id !== "string" || pending.id.trim().length === 0) {
    throw new TypeError(`${label} pending result requires a non-empty string id.`);
  }

  if (
    pending.id === "." ||
    pending.id === ".." ||
    pending.id.includes("/") ||
    pending.id.includes("\\")
  ) {
    throw new TypeError(`${label} pending result id must be a single path-safe segment.`);
  }

  if (typeof pending.message !== "string" || pending.message.trim().length === 0) {
    throw new TypeError(`${label} pending result requires a non-empty string message.`);
  }

  if (
    pending.retryAfterSeconds !== undefined &&
    (!Number.isFinite(pending.retryAfterSeconds) || pending.retryAfterSeconds < 0)
  ) {
    throw new TypeError(`${label} pending retryAfterSeconds must be a non-negative number.`);
  }
}

function validateWaitDefinition(wait: WaitDefinition, stepId: string, phaseIndex: number): void {
  const label = `step ${stepId} wait phase ${phaseIndex}`;
  if (!isPlainObject(wait)) {
    throw new TypeError(`${label} must resolve to a wait object.`);
  }

  if (typeof wait.id !== "string" || wait.id.trim().length === 0) {
    throw new TypeError(`${label} requires a non-empty string id.`);
  }

  if (wait.id === "." || wait.id === ".." || wait.id.includes("/") || wait.id.includes("\\")) {
    throw new TypeError(`${label} id must be a single path-safe segment.`);
  }

  if (wait.kind !== "input") {
    throw new TypeError(`${label} kind must be "input".`);
  }

  if (typeof wait.message !== "string" || wait.message.trim().length === 0) {
    throw new TypeError(`${label} requires a non-empty string message.`);
  }

  if (!("output" in wait) || wait.output === undefined) {
    throw new TypeError(`${label} requires an output shape.`);
  }

  normalizeShape(wait.output);
}

async function readTextIfExists(
  path: string,
): Promise<{ readonly status: "found"; readonly value: string } | { readonly status: "missing" }> {
  try {
    return { status: "found", value: await readFile(path, "utf8") };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { status: "missing" };
    }
    throw error;
  }
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

async function resolveDisplayPayload(options: {
  readonly phase: DisplayPhase;
  readonly input: PlainObject;
  readonly output: PlainObject;
  readonly phaseIndex: number;
  readonly stepId: string;
}): Promise<PlainObject> {
  const { phase, input, output, phaseIndex, stepId } = options;
  const rawValue =
    typeof phase.content === "function" ? await phase.content({ input, output }) : phase.content;

  const display = normalizeDisplayValue(rawValue, { stepId, phaseIndex });
  if (typeof display === "string") {
    return { message: display, level: "info", phaseIndex };
  }

  return {
    message: display.message,
    level: display.level ?? "info",
    ...("data" in display ? { data: display.data } : {}),
    phaseIndex,
  };
}

function normalizeDisplayValue(
  value: unknown,
  context: { readonly stepId: string; readonly phaseIndex: number },
): StepDisplayValue {
  const label = `step ${context.stepId} display phase ${context.phaseIndex}`;

  if (typeof value === "string") {
    return value;
  }

  if (!isPlainObject(value) || typeof value.message !== "string") {
    throw new TypeError(`${label} must resolve to a string or an object with a string message.`);
  }

  const level = value.level ?? "info";
  if (!isDisplayLevel(level)) {
    throw new TypeError(`${label} level must be one of: info, warning, error, debug.`);
  }

  return {
    message: value.message,
    level,
    ...("data" in value ? { data: value.data } : {}),
  };
}

function isDisplayLevel(value: unknown): value is "info" | "warning" | "error" | "debug" {
  return value === "info" || value === "warning" || value === "error" || value === "debug";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isPlainObject(value: unknown): value is PlainObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

async function runWithStepControl<T>(options: {
  readonly stepId: string;
  readonly timeoutMs?: number;
  readonly readCancellation: () => Promise<CancellationMarker | undefined>;
  readonly run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const initialCancellation = await options.readCancellation();
  if (initialCancellation !== undefined) {
    throw new WorkflowCancellationError(initialCancellation);
  }

  const abortController = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let stopCancellationWatch: (() => void) | undefined;

  const runPromise = options.run(abortController.signal);
  void runPromise.catch(() => undefined);

  const cancellationPromise = new Promise<never>((_, reject) => {
    stopCancellationWatch = watchCancellation(options.readCancellation, (result) => {
      abortController.abort();
      if ("error" in result) {
        reject(result.error);
        return;
      }
      reject(new WorkflowCancellationError(result.cancellation));
    });
  });

  const raced: Array<Promise<T> | Promise<never>> = [runPromise, cancellationPromise];

  if (options.timeoutMs !== undefined) {
    const timeoutMs = options.timeoutMs;
    raced.push(
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          abortController.abort();
          reject(stepTimeoutFailure(options.stepId, timeoutMs));
        }, timeoutMs);
      }),
    );
  }

  try {
    return await Promise.race(raced);
  } finally {
    stopCancellationWatch?.();
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function watchCancellation(
  readCancellation: () => Promise<CancellationMarker | undefined>,
  onCancel: (
    result: { readonly cancellation: CancellationMarker } | { readonly error: unknown },
  ) => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const poll = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    try {
      const cancellation = await readCancellation();
      if (cancellation !== undefined) {
        stopped = true;
        onCancel({ cancellation });
        return;
      }
    } catch (error) {
      stopped = true;
      onCancel({ error });
      return;
    }

    timer = setTimeout(() => void poll(), 100);
  };

  timer = setTimeout(() => void poll(), 0);

  return () => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  };
}

function throwIfStepTimedOut(
  signal: AbortSignal | undefined,
  stepId: string,
  timeoutMs: number | undefined,
): void {
  if (signal?.aborted && timeoutMs !== undefined) {
    throw stepTimeoutFailure(stepId, timeoutMs);
  }
}

function stepTimeoutFailure(stepId: string, timeoutMs: number): TrailStepFailureError {
  return new TrailStepFailureError({
    code: "step_timeout",
    message: `Step ${stepId} timed out after ${timeoutMs}ms.`,
    details: { stepId, timeoutMs },
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof TrailStepFailureError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Error continuation failed.";
}

function continuationFailure(source: string): Failure {
  return {
    code: "invalid_continuation",
    message: `${source} returned an invalid continuation node.`,
  };
}

function unsupportedContinuationFailure(node: unknown, source: string): Failure | undefined {
  const form = unsupportedContinuationForm(node);
  if (form === undefined) {
    return undefined;
  }

  return {
    code: "unsupported_continuation",
    message: `${source} returned ${form}, but parallel tracks/workflow invocation execution is not implemented yet.`,
  };
}

function unsupportedContinuationForm(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    return "a continuation array";
  }

  if (isWorkflowInvocationNode(node)) {
    return "a workflow invocation continuation";
  }

  if (isAbsoluteDoneNode(node)) {
    return "an absolute done continuation";
  }

  if (isAbsoluteFailNode(node)) {
    return "an absolute fail continuation";
  }

  return undefined;
}
