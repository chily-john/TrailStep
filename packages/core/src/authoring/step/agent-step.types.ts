import type {
  AgentAdapterSelection,
  AgentPrompt,
} from "../../contracts/agents/agent-adapter.types.js";
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
  readonly adapter?: AgentAdapterSelection<TInput, TOutput>;
}
