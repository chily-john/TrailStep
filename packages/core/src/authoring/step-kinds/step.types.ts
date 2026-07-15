import type { RunContext } from "../../shared/run-context.types.js";
import type { PlainObject } from "../../shared/shape.types.js";
import type { AgentStep } from "./agent-step.types.js";
import type { CodeStep } from "./code-step.types.js";
import type { InteractiveStep } from "./interactive-step.types.js";

export type Step<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> = CodeStep<TInput, TOutput> | InteractiveStep<TOutput> | AgentStep<TInput, TOutput>;

export interface StepInputMapperContext<
  TWorkflowInput extends PlainObject = PlainObject,
  TPreviousOutput extends PlainObject = PlainObject,
> {
  readonly workflowInput: TWorkflowInput;
  readonly previousOutput: TPreviousOutput;
  readonly stepOutputs: Readonly<Record<string, PlainObject>>;
  readonly run: RunContext;
}

export type StepInputMapper<
  TWorkflowInput extends PlainObject = PlainObject,
  TPreviousOutput extends PlainObject = PlainObject,
  TStepInput extends PlainObject = PlainObject,
> = {
  bivarianceHack(
    context: StepInputMapperContext<TWorkflowInput, TPreviousOutput>,
  ): TStepInput | Promise<TStepInput>;
}["bivarianceHack"];

export interface StepInvocation<
  TWorkflowInput extends PlainObject = PlainObject,
  TPreviousOutput extends PlainObject = PlainObject,
  TStepInput extends PlainObject = PlainObject,
  TStepOutput extends PlainObject = PlainObject,
> {
  readonly step: Step<TStepInput, TStepOutput>;
  readonly input?: StepInputMapper<TWorkflowInput, TPreviousOutput, TStepInput>;
}

export type WorkflowStep<TWorkflowInput extends PlainObject = PlainObject> =
  | Step
  | StepInvocation<TWorkflowInput>;
