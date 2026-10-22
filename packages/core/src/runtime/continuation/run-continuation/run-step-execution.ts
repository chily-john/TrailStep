import type { TrailStepConfig } from "../../../agent-targeting/targeting.types.js";
import type { StepNode } from "../../../authoring/step/continuation.types.js";
import {
  firstPromptPhase,
  getStepPhases,
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
import {
  cancellationPayload,
  isWorkflowCancellationError,
} from "../../cancellation/cancellation.js";
import { createEvent } from "../../events/create-run-event.js";
import { stepExecutionFailure } from "../../failures/step-execution-failure.js";
import { type RetryPolicyInput, resolveRetryPolicy } from "../../retry/retry-policy.js";
import { shouldRetryStepFailure } from "../../retry/retryable-failures.js";
import { readRecordedStepAttempts } from "../../retry/step-attempt-history.js";
import { resolveTimeoutPolicy, type TimeoutPolicyInput } from "../../timeout/timeout-policy.js";
import {
  continuationFailure,
  errorMessage,
  exhaustedStepAttemptFailure,
  unsupportedContinuationFailure,
} from "./continuation-failures.js";
import type {
  ResumeWaitOptions,
  RunContinuationOptions,
  StepPostContinuations,
} from "./run-continuation.types.js";
import { runStepAttempt, type StepAttemptOutcome } from "./step-attempt.js";
import type { SplitPostContinuation } from "./workflow-invocation.js";

export type { StepPostContinuations };

export type StepExecutionOutcome = StepAttemptOutcome;

export interface StepExecutionContext {
  readonly options: RunContinuationOptions;
  readonly stepNode: StepNode;
  readonly resumeWait: ResumeWaitOptions | undefined;
  readonly stepIndex: number;
  readonly currentWorkflowId: string;
  readonly currentWorkflowAgents: Readonly<Record<string, WorkflowAgentRole>>;
  readonly currentWorkflowTimeout: TimeoutPolicyInput | undefined;
  readonly currentWorkflowRetry: RetryPolicyInput | undefined;
  readonly trailstepConfig: TrailStepConfig | undefined;
  readonly splitPostContinuations: (
    postContinuation: SplitPostContinuation | undefined,
  ) => StepPostContinuations;
}

/**
 * Runs a step node end to end: resolves the step's timeout/retry policies,
 * emits the step lifecycle events, and drives the attempt loop (including
 * automatic retries and the author's error continuation).
 */
export async function runStepExecution(
  context: StepExecutionContext,
): Promise<StepExecutionOutcome> {
  const { options, stepNode } = context;
  const { config } = stepNode;
  const resumeWait = context.resumeWait;
  const currentWorkflowId = context.currentWorkflowId;
  const trailstepConfig = context.trailstepConfig;

  const phases = getStepPhases(stepNode);
  const hasPrompt = phases.some((phase) => phase.kind === "prompt");
  const timeoutPolicy = resolveTimeoutPolicy({
    global: trailstepConfig?.settings?.timeout,
    workflow:
      context.currentWorkflowTimeout ??
      trailstepConfig?.workflows?.[currentWorkflowId]?.settings?.timeout,
    step: config.timeout,
  });
  const maxSubPrompts =
    firstPromptPhase(phases)?.maxSubPrompts ??
    config.maxSubPrompts ??
    trailstepConfig?.workflows?.[currentWorkflowId]?.settings?.maxSubPrompts;
  const retryPolicy = resolveRetryPolicy({
    global: trailstepConfig?.settings?.retry,
    workflow:
      context.currentWorkflowRetry ??
      trailstepConfig?.workflows?.[currentWorkflowId]?.settings?.retry,
    step: config.retry,
  });
  // Automatic retry is skipped when the step's do phase is explicitly
  // non-idempotent (re-executing it must never happen silently) or when the
  // author supplied an explicit error continuation (they took over failure
  // handling).
  const doPhaseAllowsAutomaticRetry = !phases.some(
    (phase) => phase.kind === "do" && phase.idempotent === false,
  );
  const recordedAttempts = await readRecordedStepAttempts({
    runDir: options.runDir,
    stepId: config.id,
  });
  const initialAttempt = recordedAttempts.attemptFailures + 1;
  // Satisfied wait outputs stay shared across retry attempts of this step so
  // a retried attempt records each wait satisfied exactly once.
  const attemptWaitOutputs: Record<string, PlainObject> = {
    ...(resumeWait?.waitOutputs ?? {}),
  };

  if (resumeWait === undefined && recordedAttempts.attemptFailures >= retryPolicy.maxAttempts) {
    const failure = exhaustedStepAttemptFailure({
      stepId: config.id,
      attemptFailures: recordedAttempts.attemptFailures,
      maxAttempts: retryPolicy.maxAttempts,
      ...(recordedAttempts.lastFailure === undefined
        ? {}
        : { recordedFailure: recordedAttempts.lastFailure }),
    });
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

  if (resumeWait === undefined) {
    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: currentWorkflowId,
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

  let attempt = initialAttempt;
  for (;;) {
    try {
      return await runStepAttempt({
        options,
        stepNode,
        resumeWait,
        stepIndex: context.stepIndex,
        currentWorkflowId,
        currentWorkflowAgents: context.currentWorkflowAgents,
        trailstepConfig,
        timeoutPolicy,
        maxSubPrompts,
        hasPrompt,
        attempt,
        initialAttempt,
        attemptWaitOutputs,
        splitPostContinuations: context.splitPostContinuations,
      });
    } catch (error) {
      if (isWorkflowCancellationError(error)) {
        await options.emit(
          createEvent({
            runId: options.runId,
            workflowId: currentWorkflowId,
            stepId: config.id,
            type: "step.cancelled",
            payload: cancellationPayload(error.cancellation),
          }),
        );
        return {
          kind: "result",
          result: { status: "cancelled", cancellation: error.cancellation },
        };
      }

      const failure = stepExecutionFailure(error);
      // Automatic retry applies ONLY to retryable failures (transient by
      // default). A permanent failure fails the step on the first attempt and
      // produces the exact same event trail as before automatic retry existed.
      const failureIsRetryable = shouldRetryStepFailure(failure, retryPolicy.retryOn);

      if (
        doPhaseAllowsAutomaticRetry &&
        !stepNode.onError &&
        failureIsRetryable &&
        attempt < retryPolicy.maxAttempts
      ) {
        const failedAttempt = attempt;
        attempt += 1;
        await options.emit(
          createEvent({
            runId: options.runId,
            workflowId: currentWorkflowId,
            stepId: config.id,
            type: "step.attemptFailed",
            payload: {
              attempt: failedAttempt,
              failure,
              maxAttempts: retryPolicy.maxAttempts,
            },
          }),
        );
        continue;
      }

      await options.emit(
        createEvent({
          runId: options.runId,
          workflowId: currentWorkflowId,
          stepId: config.id,
          type: "step.failed",
          payload: { failure },
        }),
      );

      if (!stepNode.onError) {
        return { kind: "result", result: { status: "failure", failure } };
      }

      try {
        const nextNode = stepNode.onError(failure);
        const errorSource = `error continuation for step ${config.id}`;
        if (Array.isArray(nextNode) && options.returnContinuationArrays === true) {
          return {
            kind: "result",
            result: {
              status: "split",
              nodes: nextNode,
              source: errorSource,
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
              source: errorSource,
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

        const unsupportedErrorFailure = unsupportedContinuationFailure(nextNode, errorSource);
        if (unsupportedErrorFailure !== undefined) {
          return {
            kind: "result",
            result: { status: "failure", failure: unsupportedErrorFailure },
          };
        }

        if (
          !isStepNode(nextNode) &&
          !isWorkflowInvocationNode(nextNode) &&
          !isDoneNode(nextNode) &&
          !isFailNode(nextNode)
        ) {
          return {
            kind: "result",
            result: { status: "failure", failure: continuationFailure(errorSource) },
          };
        }

        return { kind: "next", node: nextNode, source: errorSource };
      } catch (errorContinuationError) {
        return {
          kind: "result",
          result: {
            status: "failure",
            failure: stepExecutionFailure(
              new Error(
                `error continuation for step ${config.id} failed: ${errorMessage(errorContinuationError)}`,
              ),
            ),
          },
        };
      }
    }
  }
}
