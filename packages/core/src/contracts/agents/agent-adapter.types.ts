import type { PlainObject, Schema } from "../shapes/shape.types.js";
import type { AgentExecutionConfig } from "./agent-execution.types.js";
import type { AgentMessage, AgentPrompt, AgentTool } from "./agent-message.types.js";
import type { AgentModelTarget, WorkflowAgentRole } from "./agent-role.types.js";

/**
 * Configuration for a step that dispatches to an agent.
 *
 * Declared here (next to the adapter contract it points at) because the
 * adapter request embeds the step config and the step config embeds the
 * adapter selection: the two declarations are mutually recursive and must
 * live in a single leaf module to keep the import graph acyclic.
 */
export interface AgentStepRequestConfig<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly kind?: "agent";
  readonly id: string;
  readonly output: Schema<TOutput>;
  readonly prompt: AgentPrompt<TInput>;
  readonly requirements: WorkflowAgentRole;
  /**
   * Optional lean execution context for this step. Step-level execution wins
   * over `requirements.execution`; omitted entirely means current provider
   * behavior (no hygiene flags rendered).
   */
  readonly execution?: AgentExecutionConfig;
  readonly adapter?: AgentAdapterSelection<TInput, TOutput>;
  readonly timeout?: number;
}

export interface AgentAdapterRequest<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly AgentTool<TOutput>[];
  readonly requirements: WorkflowAgentRole;
  readonly model: AgentModelTarget;
  readonly step: AgentStepRequestConfig<TInput, TOutput>;
  readonly input: TInput;
}

export type AgentAdapter<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> = {
  bivarianceHack(request: AgentAdapterRequest<TInput, TOutput>): void | Promise<void>;
}["bivarianceHack"];

export interface AgentAdapterObject<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  runAgentStep(request: AgentAdapterRequest<TInput, TOutput>): void | Promise<void>;
}

export type AgentAdapterSelection<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> = AgentAdapter<TInput, TOutput> | AgentAdapterObject<TInput, TOutput>;

export type {
  AgentMessage,
  AgentPrompt,
  AgentPromptRenderer,
  AgentTool,
} from "./agent-message.types.js";
