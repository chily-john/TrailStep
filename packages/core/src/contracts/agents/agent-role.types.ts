import type { AgentExecutionConfig } from "./agent-execution.types.js";

export type WorkflowAgentSize = "default" | "tiny" | "small" | "medium" | "large" | "xl";

/** Provider-neutral effort/thinking level threaded into built-in provider adapters. */
export type WorkflowAgentThinking = "low" | "medium" | "high" | "xhigh" | "max";

export interface WorkflowAgentRole {
  readonly description?: string;
  readonly size: WorkflowAgentSize;
  readonly thinking?: WorkflowAgentThinking;
  readonly name?: string;
  /** Optional lean execution context; omitted means current provider behavior. */
  readonly execution?: AgentExecutionConfig;
}

export interface AgentModelTarget {
  readonly adapterKey: string;
  readonly model: string;
}
