import { normalizeShape } from "../../../authoring/shape/json-schema.js";
import type { ContinuationResult } from "../../../authoring/step/continuation.types.js";
import {
  isAbsoluteDoneNode,
  isAbsoluteFailNode,
  isDoneNode,
  isFailNode,
  isParallelNode,
  isStepNode,
  isWorkflowInvocationNode,
} from "../../../authoring/step/step-node.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import { readCancellationMarker } from "../../cancellation/cancellation.js";
import { stepExecutionFailure } from "../../failures/step-execution-failure.js";
import {
  continuationFailure,
  errorMessage,
  failureFromError,
  unsupportedContinuationFailure,
} from "./continuation-failures.js";
import type {
  RunContinuationOptions,
  RunContinuationResult,
  WorkflowInvocationFrame,
} from "./run-continuation.types.js";
import { runStepExecution } from "./run-step-execution.js";
import {
  splitPostContinuationForInvocationFrames,
  splitPostContinuations,
} from "./workflow-invocation.js";

export type {
  ResumedWaitDetails,
  ResumeWaitOptions,
  RunContinuationOptions,
  RunContinuationResult,
  WaitingWait,
} from "./run-continuation.types.js";

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
  const invocationFrames: WorkflowInvocationFrame[] = [];
  let currentWorkflowId = options.workflowId;
  let currentWorkflowAgents = options.workflowAgents;
  let currentWorkflowTimeout = options.workflowTimeout;
  let currentWorkflowRetry = options.workflowRetry;
  let currentWorkflowOutputSchema: ReturnType<typeof normalizeShape> | undefined;

  const splitPostContinuationsForCurrentFrames = (
    postContinuation:
      | ((output: PlainObject) => ContinuationResult | Promise<ContinuationResult>)
      | undefined,
  ) =>
    splitPostContinuations(
      postContinuation,
      splitPostContinuationForInvocationFrames(
        invocationFrames,
        currentWorkflowOutputSchema,
        currentWorkflowId,
      ),
    );

  while (true) {
    const pendingCancellation = await readCancellationMarker(options.runDir);
    if (pendingCancellation !== undefined) {
      return { status: "cancelled", cancellation: pendingCancellation };
    }

    if (isDoneNode(node)) {
      const frame = invocationFrames.pop();
      if (frame !== undefined) {
        const invocationWorkflowId = frame.invocationWorkflowId;
        let output: PlainObject;
        try {
          output =
            currentWorkflowOutputSchema === undefined
              ? node.output
              : currentWorkflowOutputSchema.assert(
                  node.output,
                  `invoked workflow ${invocationWorkflowId} output`,
                );
        } catch (error) {
          return { status: "failure", failure: failureFromError(error) };
        }

        currentWorkflowId = frame.workflowId;
        currentWorkflowAgents = frame.workflowAgents;
        currentWorkflowTimeout = frame.workflowTimeout;
        currentWorkflowRetry = frame.workflowRetry;
        currentWorkflowOutputSchema = frame.workflowOutputSchema;

        if (frame.postContinuation !== undefined) {
          try {
            node = await frame.postContinuation(output);
          } catch (error) {
            return {
              status: "failure",
              failure: stepExecutionFailure(
                new Error(
                  `workflow invocation post failed for ${invocationWorkflowId}: ${errorMessage(error)}`,
                ),
              ),
            };
          }
          source = `post for workflow invocation ${invocationWorkflowId}`;
          continue;
        }

        return {
          status: "success",
          output,
          ...(node.message === undefined ? {} : { message: node.message }),
        };
      }

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

    if (options.returnContinuationArrays === true && isAbsoluteDoneNode(node)) {
      return {
        status: "absoluteSuccess",
        output: node.output,
        ...(node.message === undefined ? {} : { message: node.message }),
      };
    }

    if (options.returnContinuationArrays === true && isAbsoluteFailNode(node)) {
      return {
        status: "absoluteFailure",
        failure: node.failure,
        ...(node.message === undefined ? {} : { message: node.message }),
      };
    }

    if (Array.isArray(node) && options.returnContinuationArrays === true) {
      return {
        status: "split",
        nodes: node,
        source,
        ...splitPostContinuationsForCurrentFrames(undefined),
      };
    }

    if (isParallelNode(node) && options.returnContinuationArrays === true) {
      return {
        status: "split",
        nodes: node.nodes,
        source,
        ...(node.options === undefined ? {} : { parallelOptions: node.options }),
        ...splitPostContinuationsForCurrentFrames(node.postContinuation),
      };
    }

    if (isWorkflowInvocationNode(node)) {
      const invocation = node;
      const inputSchema = invocation.workflow.inputShape
        ? normalizeShape(invocation.workflow.inputShape)
        : invocation.workflow.input;
      let input: PlainObject;
      try {
        input =
          inputSchema === undefined
            ? invocation.input
            : inputSchema.assert(
                invocation.input,
                `invoked workflow ${invocation.workflow.id} input`,
              );
      } catch (error) {
        return { status: "failure", failure: failureFromError(error) };
      }

      invocationFrames.push({
        workflowId: currentWorkflowId,
        workflowAgents: currentWorkflowAgents,
        ...(currentWorkflowTimeout === undefined
          ? {}
          : { workflowTimeout: currentWorkflowTimeout }),
        ...(currentWorkflowRetry === undefined ? {} : { workflowRetry: currentWorkflowRetry }),
        ...(currentWorkflowOutputSchema === undefined
          ? {}
          : { workflowOutputSchema: currentWorkflowOutputSchema }),
        invocationWorkflowId: invocation.workflow.id,
        ...(invocation.postContinuation === undefined
          ? {}
          : { postContinuation: invocation.postContinuation }),
      });
      currentWorkflowId = invocation.workflow.id;
      currentWorkflowAgents = invocation.workflow.agents ?? {};
      currentWorkflowTimeout = invocation.workflow.timeout;
      currentWorkflowRetry = invocation.workflow.retry;
      currentWorkflowOutputSchema = invocation.workflow.outputShape
        ? normalizeShape(invocation.workflow.outputShape)
        : invocation.workflow.output === undefined
          ? undefined
          : normalizeShape(invocation.workflow.output);
      node = invocation.workflow.start(input);
      source = `workflow.start for workflow ${invocation.workflow.id}`;
      continue;
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

    const outcome = await runStepExecution({
      options,
      stepNode,
      resumeWait,
      stepIndex,
      currentWorkflowId,
      currentWorkflowAgents,
      currentWorkflowTimeout,
      currentWorkflowRetry,
      trailstepConfig,
      splitPostContinuations: splitPostContinuationsForCurrentFrames,
    });

    if (outcome.kind === "result") {
      return outcome.result;
    }

    node = outcome.node;
    source = outcome.source;
  }
}
