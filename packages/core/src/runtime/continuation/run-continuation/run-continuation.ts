import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dispatchAgentStep } from "../../../agent-execution/dispatch-agent-step/dispatch-agent-step.js";
import type { TrailStepConfig } from "../../../agent-targeting/targeting.types.js";
import { jsonSchema, normalizeShape } from "../../../authoring/shape/json-schema.js";
import type {
  ContinuationResult,
  DisplayPhase,
  PromptPhase,
  StepDisplayValue,
  StepNode,
  WaitDefinition,
  WaitPhase,
} from "../../../authoring/step/continuation.types.js";
import {
  firstPromptPhase,
  getStepPhases,
  isDoneNode,
  isFailNode,
  isStepNode,
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
import { createEvent } from "../../events/create-run-event.js";
import { stepExecutionFailure } from "../../failures/step-execution-failure.js";
import { withStepContext } from "../../run-context/with-step-context.js";
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
  readonly workflowAgents: Readonly<Record<string, WorkflowAgentRole>>;
  readonly workflowTimeout?: TimeoutPolicyInput;
  readonly runDir: string;
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

export interface ResumedWaitDetails {
  readonly waitId: string;
  readonly kind: "input";
  readonly message: string;
  readonly artifactPaths: WaitArtifactPaths;
  readonly outputSchema: Record<string, unknown>;
}

export interface WaitingWait {
  readonly stepId: string;
  readonly waitId: string;
  readonly message: string;
  readonly artifactPaths: WaitArtifactPaths;
}

export type RunContinuationResult =
  | { readonly status: "success"; readonly output: PlainObject }
  | { readonly status: "failure"; readonly failure: Failure }
  | { readonly status: "waiting"; readonly wait: WaitingWait };

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
    if (isDoneNode(node)) {
      return { status: "success", output: node.output };
    }

    if (isFailNode(node)) {
      return { status: "failure", failure: node.failure };
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
      executedSteps += 1;
      stepIndex = executedSteps;
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
      const stepArtifacts = resolveStepArtifactPaths({
        runDir: options.runDir,
        stepId: config.id,
        stepIndex,
      });

      const stepResult = await runWithStepTimeout({
        stepId: config.id,
        timeoutMs: timeoutPolicy.timeoutMs,
        run: async (signal) =>
          await withStepContext(
            config.id,
            stepArtifacts.stepDir,
            async () => {
              const phaseResult = await runStepPhases({
                stepNode,
                timeoutMs: timeoutPolicy.timeoutMs,
                signal,
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
                handleWait: async (phase, output, phaseIndex, waits) => {
                  return await handleWaitPhase({
                    phase,
                    input: config.input,
                    output,
                    waits,
                    phaseIndex,
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
                    cwd: options.cwd,
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
            { maxSubPrompts },
          ),
      });

      if (stepResult.status === "waiting") {
        return stepResult;
      }

      const nextNode = stepResult.node;
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
        return { status: "failure", failure: nextNode.failure };
      }

      node = nextNode;
      source = `step ${config.id}`;
    } catch (error) {
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
        if (!isStepNode(nextNode) && !isDoneNode(nextNode) && !isFailNode(nextNode)) {
          return {
            status: "failure",
            failure: continuationFailure(`error continuation for step ${config.id}`),
          };
        }

        node = nextNode;
        source = `error continuation for step ${config.id}`;
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

async function runStepPhases(options: {
  readonly stepNode: StepNode;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
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
    if (phase.kind === "display") {
      await options.emitDisplay(phase, phaseValue, phaseIndex);
      throwIfStepTimedOut(options.signal, stepNode.config.id, options.timeoutMs);
      continue;
    }

    if (phase.kind === "wait") {
      const waitResult =
        options.resume !== undefined && phaseIndex === options.resume.startPhaseIndex
          ? await options.handleResumedWait(options.resume.wait)
          : await options.handleWait(phase, phaseValue, phaseIndex, waitOutputs);
      const waitId = waitResult.status === "waiting" ? waitResult.wait.waitId : waitResult.waitId;
      if (seenWaitIds.has(waitId)) {
        throw new Error(`step ${stepNode.config.id} has duplicate wait id '${waitId}'`);
      }
      seenWaitIds.add(waitId);

      if (waitResult.status === "waiting") {
        return waitResult;
      }

      waitOutputs[waitResult.waitId] = waitResult.output;
      throwIfStepTimedOut(options.signal, stepNode.config.id, options.timeoutMs);
      continue;
    }

    if (nextNode !== undefined) {
      throw new Error(`step ${stepNode.config.id} has executable phases after a do phase`);
    }

    if (phase.kind === "prompt") {
      phaseValue = await options.dispatchPrompt(phase);
      throwIfStepTimedOut(options.signal, stepNode.config.id, options.timeoutMs);
      continue;
    }

    nextNode = await phase.onOutput(
      withWaitsDoContext(phaseValue, waitOutputs),
      stepNode.config.input,
    );
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
  readonly stepId: string;
  readonly stepArtifactId: string;
  readonly runDir: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly emit: (event: Event) => Promise<void>;
}): Promise<HandleWaitResult> {
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
  return typeof phase.wait === "function" ? await phase.wait(context) : phase.wait;
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

async function runWithStepTimeout<T>(options: {
  readonly stepId: string;
  readonly timeoutMs?: number;
  readonly run: (signal?: AbortSignal) => Promise<T>;
}): Promise<T> {
  if (options.timeoutMs === undefined) {
    return await options.run();
  }

  const timeoutMs = options.timeoutMs;
  const abortController = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      abortController.abort();
      reject(stepTimeoutFailure(options.stepId, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([options.run(abortController.signal), timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
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
