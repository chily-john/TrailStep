import type { AgentRequirements } from "../../shared/agent-role.types.js";
import type { AgentAdapterSelection, AgentPrompt } from "../../shared/agent-selection.types.js";
import type { PlainObject, Schema } from "../../shared/shape.types.js";

export interface AgentStepRequestConfig<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly kind?: "agent";
  readonly id: string;
  readonly output: Schema<TOutput>;
  readonly prompt: AgentPrompt<TInput>;
  readonly requirements: AgentRequirements;
  readonly adapter?: AgentAdapterSelection<TInput, TOutput>;
}

export interface AgentStep<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> extends AgentStepRequestConfig<TInput, TOutput> {
  readonly kind: "agent";
  readonly input: Schema<TInput>;
}
