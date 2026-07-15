import type { ContinuationResult } from "../authoring/continuation.types.js";
import { normalizeShape } from "../authoring/json-schema.js";
import type {
  Step,
  StepInputMapperContext,
  StepInvocation,
  WorkflowStep,
} from "../authoring/step-kinds/step.types.js";
import { isDoneNode, isStepNode } from "../authoring/step-node.js";
import type { WorkflowAgentRole } from "../shared/agent-role.types.js";
import type { Failure } from "../shared/failure.js";
import { StepKitFailureError } from "../shared/failure.js";
import type { PlainObject } from "../shared/shape.types.js";
import type { Event, Result, RunWorkflowOptions } from "./engine.types.js";
import { createEvent } from "./run-events.js";
import { createRunDirectory, persistEvents } from "./run-storage.js";
import { dispatchContinuationStep, dispatchWorkflowStep } from "./step-dispatch.js";

export async function runWorkflow<TInput extends PlainObject, TOutput extends PlainObject>(
  options: RunWorkflowOptions<TInput, TOutput>,
): Promise<Result<TOutput>> {
  const cwd = options.cwd ?? process.cwd();
  const { runId, runDir } = await createRunDirectory({ cwd, runName: options.runName });
  const events: Event[] = [];
  const maxSteps = options.maxSteps ?? 1000;

  const emit = async (event: Event): Promise<void> => {
    events.push(event);
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
    await persistEvents(runDir, events);

    return {
      status: "failure",
      runId,
      runDir,
      failure,
      events,
    };
  };

  try {
    const inputSchema = options.workflow.inputShape
      ? normalizeShape(options.workflow.inputShape)
      : options.workflow.input;

    if (!inputSchema) {
      throw new Error("workflow inputShape is required");
    }

    const workflowInput = inputSchema.assert(options.input, "workflow input");

    await emit(
      createEvent({
        runId,
        workflowId: options.workflow.id,
        type: "workflow.started",
        payload: { input: workflowInput },
      }),
    );

    let current: PlainObject;

    if (options.workflow.start) {
      const continuationResult = await runContinuation({
        node: options.workflow.start(workflowInput),
        runId,
        workflowId: options.workflow.id,
        emit,
        maxSteps,
        initialSource: `workflow.start for workflow ${options.workflow.id}`,
        workflowAgents: options.workflow.agents ?? {},
        runDir,
        stepkitConfig: options.stepkitConfig,
        workingAgentProcessRunner: options.workingAgentProcessRunner,
        providerWorkingRunner: options.providerWorkingRunner,
        processRunner: options.processRunner,
      });

      if (continuationResult.status === "failure") {
        return await failWorkflow(continuationResult.failure);
      }

      current = continuationResult.output;
    } else {
      current = workflowInput;
      const stepOutputs: Record<string, PlainObject> = {};

      for (const workflowStep of options.workflow.steps ?? []) {
        const invocation = normalizeStepInvocation(workflowStep);
        const stepResult = await runStep({
          invocation,
          pipelineInput: current,
          mapperContext: {
            workflowInput,
            previousOutput: current,
            stepOutputs: snapshotStepOutputs(stepOutputs),
            run: {
              id: runId,
              name: options.runName,
              path: runDir,
            },
          },
          runId,
          workflowId: options.workflow.id,
          emit,
          runDir,
          processRunner: options.processRunner,
          workflowAdapter: options.workflow.agentAdapter,
        });

        if (stepResult.status === "failure") {
          return await failWorkflow(stepResult.failure);
        }

        current = stepResult.output;
        stepOutputs[invocation.step.id] = stepResult.output;
      }
    }

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

    await persistEvents(runDir, events);

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

async function runContinuation(options: {
  readonly node: ContinuationResult;
  readonly runId: string;
  readonly workflowId: string;
  readonly emit: (event: Event) => Promise<void>;
  readonly maxSteps: number;
  readonly initialSource: string;
  readonly workflowAgents: Readonly<Record<string, WorkflowAgentRole>>;
  readonly runDir: string;
  readonly stepkitConfig: RunWorkflowOptions["stepkitConfig"];
  readonly workingAgentProcessRunner: RunWorkflowOptions["workingAgentProcessRunner"];
  readonly providerWorkingRunner: RunWorkflowOptions["providerWorkingRunner"];
  readonly processRunner: RunWorkflowOptions["processRunner"];
}): Promise<
  | { readonly status: "success"; readonly output: PlainObject }
  | { readonly status: "failure"; readonly failure: Failure }
> {
  let node: ContinuationResult = options.node;
  let source = options.initialSource;
  let executedSteps = 0;

  while (true) {
    if (isDoneNode(node)) {
      return { status: "success", output: node.output };
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

    const stepNode = node;
    const { config } = stepNode;

    try {
      const outputSchema = normalizeShape(config.outputShape);
      const { rawOutput } = await dispatchContinuationStep({
        config,
        outputSchema,
        runId: options.runId,
        workflowId: options.workflowId,
        emit: options.emit,
        workflowAgents: options.workflowAgents,
        runDir: options.runDir,
        stepkitConfig: options.stepkitConfig,
        workingAgentProcessRunner: options.workingAgentProcessRunner,
        providerWorkingRunner: options.providerWorkingRunner,
        processRunner: options.processRunner,
      });

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

      const nextNode = stepNode.onOutput(output);
      if (!isStepNode(nextNode) && !isDoneNode(nextNode)) {
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
      const failure =
        error instanceof StepKitFailureError ? error.failure : stepExecutionFailure(error);

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
        if (!isStepNode(nextNode) && !isDoneNode(nextNode)) {
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

async function runStep<TWorkflowInput extends PlainObject>(options: {
  readonly invocation: StepInvocation<TWorkflowInput>;
  readonly pipelineInput: PlainObject;
  readonly mapperContext: StepInputMapperContext<TWorkflowInput, PlainObject>;
  readonly runId: string;
  readonly workflowId: string;
  readonly emit: (event: Event) => Promise<void>;
  readonly runDir: string;
  readonly processRunner: RunWorkflowOptions["processRunner"];
  readonly workflowAdapter: RunWorkflowOptions["workflow"]["agentAdapter"];
}): Promise<
  | { readonly status: "success"; readonly output: PlainObject }
  | { readonly status: "failure"; readonly failure: Failure }
> {
  const { step } = options.invocation;

  try {
    const rawInput = options.invocation.input
      ? await options.invocation.input(options.mapperContext)
      : options.pipelineInput;

    const rawOutput = await dispatchWorkflowStep({
      step,
      rawInput,
      runId: options.runId,
      workflowId: options.workflowId,
      emit: options.emit,
      runDir: options.runDir,
      processRunner: options.processRunner,
      workflowAdapter: options.workflowAdapter,
    });

    const output = step.output.assert(rawOutput, `step ${step.id} output`);

    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: step.id,
        type: "step.completed",
        payload: { output },
      }),
    );

    return { status: "success", output };
  } catch (error) {
    const failure =
      error instanceof StepKitFailureError ? error.failure : stepExecutionFailure(error);

    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: step.id,
        type: "step.failed",
        payload: { failure },
      }),
    );

    return { status: "failure", failure };
  }
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

function normalizeStepInvocation<TWorkflowInput extends PlainObject>(
  workflowStep: WorkflowStep<TWorkflowInput>,
): StepInvocation<TWorkflowInput> {
  if ("step" in workflowStep) {
    return workflowStep;
  }

  return { step: workflowStep as Step };
}

function snapshotStepOutputs(
  stepOutputs: Record<string, PlainObject>,
): Readonly<Record<string, PlainObject>> {
  return Object.freeze({ ...stepOutputs });
}

/**
 * Failure-shaping helpers specific to workflow-execution orchestration
 * (not part of the public API — only `Failure` itself is exported from
 * `shared/failure.ts` and re-exported from the package entry point).
 */
function continuationFailure(source: string): Failure {
  return {
    code: "invalid_continuation",
    message: `${source} returned an invalid continuation node.`,
  };
}

function stepExecutionFailure(error: unknown): Failure {
  if (error instanceof StepKitFailureError) {
    return error.failure;
  }

  if (isFailureLikeError(error)) {
    return error.failure;
  }

  return {
    code: "step_execution_failed",
    message: error instanceof Error ? error.message : "Step execution failed.",
    ...(error instanceof Error
      ? {
          details: {
            name: error.name,
          },
        }
      : error === undefined
        ? {}
        : { details: { cause: error } }),
  };
}

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
