import { dispatchAgentStep } from "../../../agent-execution/dispatch-agent-step/dispatch-agent-step.js";
import type { StepKitConfig } from "../../../agent-targeting/targeting.types.js";
import type { ContinuationResult } from "../../../authoring/step/continuation.types.js";
import { isDoneNode, isFailNode, isStepNode } from "../../../authoring/step/step-node.js";
import type { WorkflowAgentRole } from "../../../contracts/agents/agent-role.types.js";
import type { Failure } from "../../../contracts/failures/failure.js";
import { StepKitFailureError } from "../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import type {
  Event,
  RunWorkflowOptions,
} from "../../../runtime/run-workflow/run-workflow.types.js";
import { resolveStepArtifactPaths } from "../../artifacts/step-artifacts.js";
import { createEvent } from "../../events/create-run-event.js";
import { stepExecutionFailure } from "../../failures/step-execution-failure.js";
import { withStepContext } from "../../run-context/with-step-context.js";
import { resolveTimeoutPolicy } from "../../timeout/timeout-policy.js";
import type { TimeoutPolicyInput } from "../../timeout/timeout-policy.js";
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
  readonly stepkitConfig?: StepKitConfig;
  readonly workingAgentProcessRunner?: RunWorkflowOptions["workingAgentProcessRunner"];
  readonly providerWorkingRunner?: RunWorkflowOptions["providerWorkingRunner"];
  readonly processRunner?: RunWorkflowOptions["processRunner"];
}

export type RunContinuationResult =
  | { readonly status: "success"; readonly output: PlainObject }
  | { readonly status: "failure"; readonly failure: Failure };

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
  const stepkitConfig = options.stepkitConfig;

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

    if (executedSteps >= options.maxSteps) {
      return {
        status: "failure",
        failure: stepExecutionFailure(
          new Error(`workflow exceeded maxSteps guard (${options.maxSteps})`),
        ),
      };
    }
    executedSteps += 1;
    const stepIndex = executedSteps;

    const stepNode = node;
    const { config } = stepNode;
    const hasPrompt = config.prompt !== undefined;
    const timeoutPolicy = resolveTimeoutPolicy({
      global: stepkitConfig?.settings?.timeout,
      workflow:
        options.workflowTimeout ?? stepkitConfig?.workflows?.[options.workflowId]?.settings?.timeout,
      step: config.timeout,
    });
    const maxSubPrompts =
      config.maxSubPrompts ??
      stepkitConfig?.workflows?.[options.workflowId]?.settings?.maxSubPrompts;

    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: config.id,
        type: "step.started",
        payload: { stepName: config.id, kind: hasPrompt ? "agent" : "code" },
      }),
    );

    try {
      const stepDir = resolveStepArtifactPaths({
        runDir: options.runDir,
        stepId: config.id,
        stepIndex,
      }).stepDir;

      const nextNode = await runWithStepTimeout({
        stepId: config.id,
        timeoutMs: timeoutPolicy.timeoutMs,
        run: async (signal) =>
          await withStepContext(
            config.id,
            stepDir,
            async () => {
          let paramForNext: PlainObject;

          if (hasPrompt) {
            const outputSchema = resolveStepOutputSchema(config);
            if (!outputSchema) {
              throw new Error(`step ${config.id} with a prompt requires an output shape`);
            }

            const rawOutput = await dispatchAgentStep({
              config: config as typeof config & { prompt: NonNullable<typeof config.prompt> },
              outputSchema,
              interactiveOutputMode:
                config.mode === "interactive" && config.output !== undefined
                  ? "json"
                  : "session-file",
              runId: options.runId,
              workflowId: options.workflowId,
              emit: options.emit,
              workflowAgents: options.workflowAgents,
              runDir: options.runDir,
              cwd: options.cwd,
              stepkitConfig,
              workingAgentProcessRunner: options.workingAgentProcessRunner,
              providerWorkingRunner: options.providerWorkingRunner,
              processRunner: options.processRunner,
              stepIndex,
              signal,
            });
            throwIfStepTimedOut(signal, config.id, timeoutPolicy.timeoutMs);
            paramForNext = outputSchema.assert(rawOutput, `step ${config.id} output`);

            await options.emit(
              createEvent({
                runId: options.runId,
                workflowId: options.workflowId,
                stepId: config.id,
                type: "step.completed",
                payload: { output: paramForNext },
              }),
            );
          } else {
            paramForNext = config.input;
          }

          const nextNode = await stepNode.onOutput(paramForNext, config.input);
          throwIfStepTimedOut(signal, config.id, timeoutPolicy.timeoutMs);

          if (!hasPrompt) {
            // A no-prompt step's .do(...) IS its work — only report completion once it has
            // actually run without throwing, matching the with-prompt case's "step.completed
            // means the step's own work succeeded" meaning (a thrown .do() must never be
            // preceded by step.completed, or resume's already-completed guard sees both).
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
          return nextNode;
            },
            { maxSubPrompts },
          ),
      });

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

function stepTimeoutFailure(stepId: string, timeoutMs: number): StepKitFailureError {
  return new StepKitFailureError({
    code: "step_timeout",
    message: `Step ${stepId} timed out after ${timeoutMs}ms.`,
    details: { stepId, timeoutMs },
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof StepKitFailureError) {
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

