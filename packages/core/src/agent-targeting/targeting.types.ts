import type {
  WorkflowAgentSize,
  WorkflowAgentThinking,
} from "../contracts/agents/agent-role.types.js";

export type StepKitAgentMode = "working" | "interactive";

export interface StepKitCustomAgentConfig {
  readonly binary: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface StepKitAgentTarget {
  /**
   * Either a key declared in the top-level `customAgents` object, or a
   * built-in provider registry id (e.g. `"claude"`). The registry is checked
   * first; `customAgents` is the fallback/escape hatch.
   */
  readonly provider: string;
  readonly model?: string;
  readonly thinking?: WorkflowAgentThinking;
  readonly args?: readonly string[];
}

export type StepKitSizeAgentMappings = Partial<
  Readonly<Record<WorkflowAgentSize, readonly StepKitAgentTarget[]>>
>;

export type StepKitRoleAgentMappings = Readonly<Record<string, readonly StepKitAgentTarget[]>>;

export interface StepKitWorkflowConfig {
  readonly workingAgents?: StepKitRoleAgentMappings;
  readonly interactiveAgents?: StepKitRoleAgentMappings;
  readonly settings?: Readonly<Record<string, unknown>>;
}

export interface StepKitConfig {
  readonly version: 1;
  readonly customAgents: Readonly<Record<string, StepKitCustomAgentConfig>>;
  readonly workingAgents: StepKitSizeAgentMappings;
  readonly interactiveAgents: StepKitSizeAgentMappings;
  readonly workflows?: Readonly<Record<string, StepKitWorkflowConfig>>;
}

export interface ResolveAgentTargetsOptions {
  readonly config: StepKitConfig;
  readonly workflowId: string;
  readonly roleName: string;
  readonly roleSize: WorkflowAgentSize;
  readonly mode: StepKitAgentMode;
}
