import type {
  AgentAdapterSelection,
  AgentPrompt,
} from "../../contracts/agents/agent-adapter.types.js";
import type { AgentExecutionConfig } from "../../contracts/agents/agent-execution.types.js";
import type { WorkflowAgentRole } from "../../contracts/agents/agent-role.types.js";
import type { PlainObject, Schema } from "../../contracts/shapes/shape.types.js";

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
