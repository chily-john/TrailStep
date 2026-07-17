import type { AgentStepRequestConfig } from "../../authoring/step/agent-step.types.js";
import type { PlainObject } from "../shapes/shape.types.js";
import type { AgentMessage, AgentTool } from "./agent-message.types.js";
import type { AgentModelTarget, WorkflowAgentRole } from "./agent-role.types.js";

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
