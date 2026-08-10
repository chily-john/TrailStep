import type { WorkflowAgentThinking } from "../contracts/agents/agent-role.types.js";
import type { RetryPolicyInput } from "../runtime/retry/retry-policy.js";
import type { TimeoutPolicyInput } from "../runtime/timeout/timeout-policy.js";

export interface TrailStepCustomProviderConfig {
  readonly binary: string;
  readonly args?: readonly string[];
  readonly interactiveArgs?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface TrailStepAgentTarget {
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

export type TrailStepAgentMappings = Readonly<Record<string, readonly TrailStepAgentTarget[]>>;

export interface TrailStepSettings {
  readonly retry?: RetryPolicyInput;
  readonly timeout?: TimeoutPolicyInput;
  readonly [key: string]: unknown;
}

export interface TrailStepWorkflowConfig {
  readonly agents?: TrailStepAgentMappings;
  readonly settings?: TrailStepSettings;
}

export interface TrailStepConfig {
  readonly version: 1;
  readonly customProviders: Readonly<Record<string, TrailStepCustomProviderConfig>>;
  readonly agents: TrailStepAgentMappings;
  readonly settings?: TrailStepSettings;
  readonly workflows?: Readonly<Record<string, TrailStepWorkflowConfig>>;
}

export interface ResolveAgentTargetsOptions {
  readonly config: TrailStepConfig;
  readonly workflowId: string;
  readonly roleName: string;
  readonly roleSize: string;
}
