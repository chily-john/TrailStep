import { dispatchAgentStep } from "../../../agent-execution/dispatch-agent-step/dispatch-agent-step.js";
import type { TrailStepConfig } from "../../../agent-targeting/targeting.types.js";
import type { ContinuationResult, StepNode } from "../../../authoring/step/continuation.types.js";
import {
  isAbsoluteDoneNode,
  isAbsoluteFailNode,
  isDoneNode,
  isFailNode,
  isParallelNode,
  isStepNode,
  isWorkflowInvocationNode,
} from "../../../authoring/step/step-node.js";
import type { WorkflowAgentRole } from "../../../contracts/agents/agent-role.types.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import { resolveStepArtifactPaths } from "../../artifacts/step-artifacts.js";
import { readCancellationMarker } from "../../cancellation/cancellation.js";
import { createEvent } from "../../events/create-run-event.js";
import { withStepContext } from "../../run-context/with-step-context.js";
import type { TimeoutPolicy } from "../../timeout/timeout-policy.js";
import { resolveStepOutputSchema } from "../resolve-step-output-schema/resolve-step-output-schema.js";
import { continuationFailure, unsupportedContinuationFailure } from "./continuation-failures.js";
import { resolveDisplayPayload } from "./display-phase.js";
import type {
  ResumeWaitOptions,
  RunContinuationOptions,
  RunContinuationResult,
  StepPostContinuations,
} from "./run-continuation.types.js";
import { runWithStepControl, throwIfStepTimedOut } from "./step-control.js";
import { resolveStepExecutionCwd } from "./step-cwd.js";
import { runStepPhases } from "./step-phases.js";
import { handleResumedWaitPhase, handleWaitPhase } from "./wait-phase.js";

export type StepAttemptOutcome =
  | { readonly kind: "next"; readonly node: ContinuationResult; readonly source: string }
  | { readonly kind: "result"; readonly result: RunContinuationResult };

export interface StepAttemptContext {
  readonly options: RunContinuationOptions;
  readonly stepNode: StepNode;
  readonly resumeWait: ResumeWaitOptions | undefined;
  readonly stepIndex: number;
  readonly currentWorkflowId: string;
  readonly currentWorkflowAgents: Readonly<Record<string, WorkflowAgentRole>>;
  readonly trailstepConfig: TrailStepConfig | undefined;
  readonly timeoutPolicy: TimeoutPolicy;
  readonly maxSubPrompts: unknown;
  readonly hasPrompt: boolean;
  readonly attempt: number;
  readonly initialAttempt: number;
  readonly attemptWaitOutputs: Record<string, PlainObject>;
  readonly splitPostContinuations: (
    postContinuation: import("./workflow-invocation.js").SplitPostContinuation | undefined,
  ) => StepPostContinuations;
}

/**
 * Runs a single attempt of a step: resolves the step cwd and artifacts, runs
 * the phase pipeline under timeout/cancellation control, and shapes the
 * attempt outcome (waiting, split, absolute, failure, or the next node).
 */
export async function runStepAttempt(context: StepAttemptContext): Promise<StepAttemptOutcome> {
  const { options, stepNode } = context;
  const { config } = stepNode;
  const resumeWait = context.resumeWait;
  const currentWorkflowId = context.currentWorkflowId;
  const currentWorkflowAgents = context.currentWorkflowAgents;
  const trailstepConfig = context.trailstepConfig;
  const stepIndex = context.stepIndex;
  const timeoutPolicy = context.timeoutPolicy;

  const stepCwd = await resolveStepExecutionCwd({
    stepId: config.id,
    workflowId: currentWorkflowId,
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
            sharedWaitOutputs: context.attemptWaitOutputs,
            ...(resumeWait === undefined || context.attempt > context.initialAttempt
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
                  workflowId: currentWorkflowId,
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
                workflowId: currentWorkflowId,
                emit: options.emit,
              });
            },
            handleResumedWait: async (wait) =>
              await handleResumedWaitPhase({
                wait,
                stepId: config.id,
                runDir: options.runDir,
                runId: options.runId,
                workflowId: currentWorkflowId,
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
                workflowId: currentWorkflowId,
                emit: options.emit,
                workflowAgents: currentWorkflowAgents,
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
                  workflowId: currentWorkflowId,
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
                workflowId: currentWorkflowId,
                stepId: config.id,
                type: "step.failed",
                payload: { failure: nextNode.failure },
              }),
            );
            return phaseResult;
          }

          if (!context.hasPrompt) {
            // A no-prompt step's .do(...) IS its work — only report completion once it has
            // actually run without throwing or returning fail(...), matching the with-prompt
            // case's "step.completed means the step's own work succeeded" meaning.
            await options.emit(
              createEvent({
                runId: options.runId,
                workflowId: currentWorkflowId,
                stepId: config.id,
                type: "step.completed",
                payload: {},
              }),
            );
          }

          throwIfStepTimedOut(signal, config.id, timeoutPolicy.timeoutMs);
          return phaseResult;
        },
        { maxSubPrompts: context.maxSubPrompts, cwd: stepCwd, executionCwd: stepCwd },
      ),
  });

  if (stepResult.status === "waiting") {
    return { kind: "result", result: stepResult };
  }

  const nextNode = stepResult.node;
  if (Array.isArray(nextNode) && options.returnContinuationArrays === true) {
    return {
      kind: "result",
      result: {
        status: "split",
        nodes: nextNode,
        source: `step ${config.id}`,
        ...context.splitPostContinuations(undefined),
      },
    };
  }

  if (isParallelNode(nextNode) && options.returnContinuationArrays === true) {
    return {
      kind: "result",
      result: {
        status: "split",
        nodes: nextNode.nodes,
        source: `step ${config.id}`,
        ...context.splitPostContinuations(nextNode.postContinuation),
      },
    };
  }

  if (options.returnContinuationArrays === true && isAbsoluteDoneNode(nextNode)) {
    return {
      kind: "result",
      result: {
        status: "absoluteSuccess",
        output: nextNode.output,
        ...(nextNode.message === undefined ? {} : { message: nextNode.message }),
      },
    };
  }

  if (options.returnContinuationArrays === true && isAbsoluteFailNode(nextNode)) {
    return {
      kind: "result",
      result: {
        status: "absoluteFailure",
        failure: nextNode.failure,
        ...(nextNode.message === undefined ? {} : { message: nextNode.message }),
      },
    };
  }

  const unsupportedStepFailure = unsupportedContinuationFailure(nextNode, `step ${config.id}`);
  if (unsupportedStepFailure !== undefined) {
    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: currentWorkflowId,
        stepId: config.id,
        type: "step.failed",
        payload: { failure: unsupportedStepFailure },
      }),
    );
    return { kind: "result", result: { status: "failure", failure: unsupportedStepFailure } };
  }

  if (
    !isStepNode(nextNode) &&
    !isWorkflowInvocationNode(nextNode) &&
    !isDoneNode(nextNode) &&
    !isFailNode(nextNode)
  ) {
    const failure = continuationFailure(`step ${config.id}`);
    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: currentWorkflowId,
        stepId: config.id,
        type: "step.failed",
        payload: { failure },
      }),
    );
    return { kind: "result", result: { status: "failure", failure } };
  }

  if (isFailNode(nextNode)) {
    return {
      kind: "result",
      result: {
        status: "failure",
        failure: nextNode.failure,
        ...(nextNode.message === undefined ? {} : { message: nextNode.message }),
      },
    };
  }

  return { kind: "next", node: nextNode, source: `step ${config.id}` };
}
