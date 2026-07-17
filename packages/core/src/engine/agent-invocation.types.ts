import type { AgentStepRequestConfig } from "../authoring/step-kinds/agent-step.types.js";
import type { AgentModelTarget, WorkflowAgentRole } from "../shared/agent-role.types.js";
import type { AgentMessage, AgentTool } from "../shared/agent-selection.types.js";
import type { PlainObject } from "../shared/shape.types.js";

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
