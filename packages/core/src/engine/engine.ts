import { basename } from "node:path";

import type { ContinuationResult, StepNode } from "../authoring/continuation.types.js";
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
import type { RunContext } from "../shared/run-context.types.js";
import type { PlainObject } from "../shared/shape.types.js";
import type { Event, Result, RunWorkflowOptions } from "./engine.types.js";
import { createRunContext } from "./run-context.js";
import { createEvent } from "./run-events.js";
import { appendEvent, createRunDirectory, readRunEvents } from "./run-storage.js";
import { dispatchContinuationStep, dispatchWorkflowStep } from "./step-dispatch.js";

export async function runWorkflow<TInput extends PlainObject, TOutput extends PlainObject>(
  options: RunWorkflowOptions<TInput, TOutput>,
): Promise<Result<TOutput>> {
  const maxSteps = options.maxSteps ?? 1000;
  const isResume = options.resume !== undefined;
  const initialized = await initializeRun(options).catch((error) => {
    if (options.resume && (error instanceof StepKitFailureError || isFailureLikeError(error))) {
      return {
        status: "failure" as const,
        runId: basename(options.resume.runDir),
        runName: basename(options.resume.runDir),
        runDir: options.resume.runDir,
        previousEvents: [],
        failure: unknownWorkflowFailure(error),
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
  const events: Event[] = [...previousEvents];
  const runContext = createRunContext({ runId, runName, runDir });

  const emit = async (event: Event): Promise<void> => {
    events.push(event);
    await appendEvent(runDir, event);
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
    const inputSchema = options.workflow.inputShape
      ? normalizeShape(options.workflow.inputShape)
      : options.workflow.input;

    if (!inputSchema) {
      throw new Error("workflow inputShape is required");
    }

    let workflowInput: TInput;
    let startNode: ContinuationResult | undefined;

    if (isResume) {
      const replay = await replayContinuationToFailedStep({
        workflow: options.workflow,
        events: previousEvents,
        runContext,
      });
      if (replay.status === "failure") {
        return failResumeValidation(replay.failure);
      }

      workflowInput = inputSchema.assert(replay.input, "workflow input") as TInput;
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
      workflowInput = inputSchema.assert(options.input, "workflow input");
      await emit(
        createEvent({
          runId,
          workflowId: options.workflow.id,
          type: "workflow.started",
          payload: { input: workflowInput },
        }),
      );
    }

    let current: PlainObject;

    if (options.workflow.start) {
      const continuationResult = await runContinuation({
        node: startNode ?? options.workflow.start(workflowInput),
        runId,
        workflowId: options.workflow.id,
        emit,
        maxSteps,
        initialSource: isResume
          ? `resume for workflow ${options.workflow.id}`
          : `workflow.start for workflow ${options.workflow.id}`,
        workflowAgents: options.workflow.agents ?? {},
        runDir,
        runContext,
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
      if (isResume) {
        return failResumeValidation(
          resumeFailure("resume_unsupported_history", "Resume requires a continuation workflow."),
        );
      }

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
            run: runContext,
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

async function initializeRun<TInput extends PlainObject, TOutput extends PlainObject>(
  options: RunWorkflowOptions<TInput, TOutput>,
): Promise<{
  readonly runId: string;
  readonly runName: string;
  readonly runDir: string;
  readonly previousEvents: readonly Event[];
}> {
  if (options.resume) {
    const previousEvents = await readRunEvents(options.resume.runDir);
    const startedEvent = previousEvents.find((event) => event.type === "workflow.started");
    return {
      runId: startedEvent?.runId ?? basename(options.resume.runDir),
      runName: startedEvent?.runId ?? basename(options.resume.runDir),
      runDir: options.resume.runDir,
      previousEvents,
    };
  }

  const cwd = options.cwd ?? process.cwd();
  const { runId, runDir } = await createRunDirectory({ cwd, runName: options.runName });
  return { runId, runName: options.runName, runDir, previousEvents: [] };
}

async function replayContinuationToFailedStep<
  TInput extends PlainObject,
  TOutput extends PlainObject,
>(options: {
  readonly workflow: RunWorkflowOptions<TInput, TOutput>["workflow"];
  readonly events: readonly Event[];
  readonly runContext: RunContext;
}): Promise<
  | {
      readonly status: "success";
      readonly input: PlainObject;
      readonly node: StepNode;
      readonly resumedStepId: string;
      readonly sourceFailureEventId: string;
    }
  | { readonly status: "failure"; readonly failure: Failure }
> {
  const startedEvent = options.events.find((event) => event.type === "workflow.started");
  if (!startedEvent) {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_target_not_found",
        "Resume target has no workflow.started event.",
      ),
    };
  }

  if (startedEvent.workflowId !== options.workflow.id) {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_workflow_mismatch",
        `Resume target workflow ${startedEvent.workflowId} does not match ${options.workflow.id}.`,
      ),
    };
  }

  const terminalEvent = options.events.at(-1);
  if (terminalEvent?.type !== "workflow.failed") {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_target_not_failed",
        "Resume target must end in workflow.failed.",
      ),
    };
  }

  const recoveredFailedStep = options.events.find(
    (event, index) =>
      event.type === "step.failed" &&
      options.events.slice(index + 1).some(
        (laterEvent) =>
          laterEvent.type === "step.completed" && laterEvent.stepId === event.stepId,
      ),
  );
  if (recoveredFailedStep) {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_unsupported_history",
        `Resume does not support recovered onError history for step ${recoveredFailedStep.stepId ?? "<missing>"}.`,
      ),
    };
  }

  const failedStepEvents = options.events.filter((event) => event.type === "step.failed");
  if (failedStepEvents.length !== 1) {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_multiple_failed_steps",
        "Resume target must contain exactly one failed step.",
      ),
    };
  }

  const failedStepEvent = failedStepEvents[0];
  if (!failedStepEvent) {
    return {
      status: "failure",
      failure: resumeFailure("resume_target_not_failed", "Resume target has no failed step."),
    };
  }

  if (!failedStepEvent.stepId) {
    return {
      status: "failure",
      failure: resumeFailure("resume_target_not_failed", "Failed step event has no step id."),
    };
  }

  if (!options.workflow.start) {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_unsupported_history",
        "Resume requires a continuation workflow.",
      ),
    };
  }

  const input = readPlainPayload(startedEvent, "input");
  if (!input) {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_target_not_found",
        "workflow.started payload is missing input.",
      ),
    };
  }

  let node: ContinuationResult = options.workflow.start(input as TInput);
  const completedStepEvents = options.events.filter((event) => event.type === "step.completed");

  for (const completedEvent of completedStepEvents) {
    if (!isStepNode(node)) {
      return {
        status: "failure",
        failure: resumeFailure(
          "resume_step_id_drift",
          "Completed history continues after the current workflow reaches done.",
        ),
      };
    }

    if (node.config.id === failedStepEvent.stepId) {
      return {
        status: "failure",
        failure: resumeFailure(
          "resume_target_not_failed",
          "Failed step already has a completed output in the target history.",
        ),
      };
    }

    if (node.config.id !== completedEvent.stepId) {
      return {
        status: "failure",
        failure: resumeFailure(
          "resume_step_id_drift",
          `Expected completed step ${node.config.id} but found ${completedEvent.stepId ?? "<missing>"}.`,
        ),
      };
    }

    if (node.config.run === undefined) {
      return {
        status: "failure",
        failure: resumeFailure(
          "resume_unsupported_history",
          `Resume does not support non-code step ${node.config.id}.`,
        ),
      };
    }

    const output = readPlainPayload(completedEvent, "output");
    if (!output) {
      return {
        status: "failure",
        failure: resumeFailure(
          "resume_missing_completed_output",
          `Completed step ${node.config.id} is missing output.`,
        ),
      };
    }

    node = await node.onOutput(output, options.runContext);
  }

  if (!isStepNode(node) || node.config.id !== failedStepEvent.stepId) {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_step_id_drift",
        `Failed step ${failedStepEvent.stepId} is not the next live step.`,
      ),
    };
  }

  if (node.config.run === undefined) {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_unsupported_history",
        `Resume does not support non-code step ${node.config.id}.`,
      ),
    };
  }

  if (node.onError) {
    return {
      status: "failure",
      failure: resumeFailure(
        "resume_unsupported_history",
        `Resume does not support onError history for step ${node.config.id}.`,
      ),
    };
  }

  const resumeNode = node;
  return {
    status: "success",
    input,
    node: resumeNode,
    resumedStepId: failedStepEvent.stepId,
    sourceFailureEventId: failedStepEvent.id,
  };
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
  readonly runContext: RunContext;
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

      const nextNode = await stepNode.onOutput(output, options.runContext);
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

function readPlainPayload(event: Event, key: string): PlainObject | undefined {
  const value = event.payload[key];
  return isPlainObject(value) ? value : undefined;
}

function isPlainObject(value: unknown): value is PlainObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function resumeFailure(code: string, message: string): Failure {
  return { code, message };
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
