import type { AgentRequirements } from "../shared/agent-role.types.js";
import type { AgentAdapterSelection, AgentPrompt } from "../shared/agent-selection.types.js";
import type { Failure } from "../shared/failure.js";
import type { RunContext } from "../shared/run-context.types.js";
import type { PlainObject, ShapeInput } from "../shared/shape.types.js";

export interface ContinuationStepConfig<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly id: string;
  readonly input: TInput;
  readonly outputShape: ShapeInput<TOutput>;
  run?(input: TInput): TOutput | Promise<TOutput>;
  readonly prompt?: AgentPrompt<TInput>;
  readonly agent?: string;
  readonly agentMode?: "working" | "interactive";
  /** @deprecated Prefer workflow-level `agents` and a step-level `agent` role reference. */
  readonly requirements?: AgentRequirements;
  readonly adapter?: AgentAdapterSelection<TInput, TOutput>;
}

export type StepContinuation<TOutput extends PlainObject = PlainObject> = {
  bivarianceHack(output: TOutput, ctx: RunContext): ContinuationResult | Promise<ContinuationResult>;
}["bivarianceHack"];

export type StepErrorContinuation = {
  bivarianceHack(error: Failure): ContinuationResult;
}["bivarianceHack"];

export interface StepNode<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly kind: "step";
  readonly config: ContinuationStepConfig<TInput, TOutput>;
  readonly onOutput: StepContinuation<TOutput>;
  readonly onError?: StepErrorContinuation;
}

export interface DoneNode<TOutput extends PlainObject = PlainObject> {
  readonly kind: "done";
  readonly output: TOutput;
}

export type ContinuationResult<TOutput extends PlainObject = PlainObject> =
  | StepNode<PlainObject, PlainObject>
  | DoneNode<TOutput>;
