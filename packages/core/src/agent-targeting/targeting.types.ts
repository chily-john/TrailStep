import type { WorkflowAgentThinking } from "../contracts/agents/agent-role.types.js";
import type { TrailStepProviderRegistration } from "../providers/provider-manifest.js";
import type { RetryPolicyInput } from "../runtime/retry/retry-policy.js";
import type { SpawnRetryPolicyInput } from "../runtime/retry/spawn-retry-policy.js";
import type { TimeoutPolicyInput } from "../runtime/timeout/timeout-policy.js";

export type TrailStepCustomProviderModelOverrideSupport =
  | {
      readonly supported: true;
      readonly flag?: string;
    }
  | {
      readonly supported: false;
    };

export type TrailStepCustomProviderThinkingOverrideSupport =
  | {
      readonly supported: true;
      readonly flag?: string;
      readonly levels: readonly WorkflowAgentThinking[];
    }
  | {
      readonly supported: false;
      readonly levels?: readonly [];
    };

export interface TrailStepCustomProviderConfig {
  readonly binary: string;
  readonly args?: readonly string[];
  readonly interactiveArgs?: readonly string[];
  readonly model?: TrailStepCustomProviderModelOverrideSupport;
  readonly thinking?: TrailStepCustomProviderThinkingOverrideSupport;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface TrailStepAgentTarget {
  /** Either a key declared in top-level `providers` or `customProviders`. */
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
  /** Backoff retry policy for transient working-agent spawn failures. */
  readonly spawnRetry?: SpawnRetryPolicyInput;
  readonly timeout?: TimeoutPolicyInput;
  readonly [key: string]: unknown;
}

export interface TrailStepWorkflowConfig {
  readonly agents?: TrailStepAgentMappings;
  readonly settings?: TrailStepSettings;
}

export interface TrailStepStorageLifecycleRetentionConfig {
  /** Duration string such as "7d"; false disables compression for the matching scope. */
  readonly compressAfter?: string | false;
  /** Duration string such as "30d"; false disables deletion for the matching scope. */
  readonly deleteAfter?: string | false;
}

export interface TrailStepStorageLifecycleConfig extends TrailStepStorageLifecycleRetentionConfig {
  readonly enabled?: boolean;
  readonly runOn?: readonly ("run" | "open" | "runs")[];
  readonly throttle?: string | false;
  readonly workflows?: Readonly<Record<string, TrailStepStorageLifecycleRetentionConfig>>;
}

export interface TrailStepStorageConfig {
  readonly lifecycle?: TrailStepStorageLifecycleConfig;
}

export interface TrailStepMcpConfig {
  /**
   * When true (the default), the TrailStep MCP server exposes one tool per
   * generated per-workflow MCP tool JSON. When false, the server exposes a
   * single `trst_list` discovery tool instead.
   */
  readonly perWorkflowTools?: boolean;
  readonly [key: string]: unknown;
}

export interface TrailStepConfig {
  readonly version: 1;
  readonly customProviders: Readonly<Record<string, TrailStepCustomProviderConfig>>;
  readonly providers?: Readonly<Record<string, TrailStepProviderRegistration>>;
  readonly agents: TrailStepAgentMappings;
  readonly settings?: TrailStepSettings;
  readonly storage?: TrailStepStorageConfig;
  readonly mcp?: TrailStepMcpConfig;
  readonly workflows?: Readonly<Record<string, TrailStepWorkflowConfig>>;
}

export interface ResolveAgentTargetsOptions {
  readonly config: TrailStepConfig;
  readonly workflowId: string;
  readonly roleName: string;
  readonly roleSize: string;
}
