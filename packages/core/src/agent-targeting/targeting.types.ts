import type { WorkflowAgentThinking } from "../contracts/agents/agent-role.types.js";

export interface StepKitCustomProviderConfig {
  readonly binary: string;
  readonly args?: readonly string[];
  readonly interactiveArgs?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface StepKitAgentTarget {
  /**
   * Either a key declared in the top-level `customProviders` object, or a
   * built-in provider registry id (e.g. `"claude"`). The registry is checked
   * first; `customProviders` is the fallback/escape hatch.
   */
  readonly provider: string;
  readonly model?: string;
  readonly thinking?: WorkflowAgentThinking;
  readonly args?: readonly string[];
  /** Undefined means bypass (per-tool confirmation is skipped by default). */
  readonly permissionMode?: "bypass" | "prompt";
}

export type StepKitAgentMappings = Readonly<Record<string, readonly StepKitAgentTarget[]>>;

export interface StepKitWorkflowConfig {
  readonly agents?: StepKitAgentMappings;
  readonly settings?: Readonly<Record<string, unknown>>;
}

export interface StepKitConfig {
  readonly version: 1;
  readonly customProviders: Readonly<Record<string, StepKitCustomProviderConfig>>;
  readonly agents: StepKitAgentMappings;
  readonly workflows?: Readonly<Record<string, StepKitWorkflowConfig>>;
}

export interface ResolveAgentTargetsOptions {
  readonly config: StepKitConfig;
  readonly workflowId: string;
  readonly roleName: string;
  readonly roleSize: string;
}
