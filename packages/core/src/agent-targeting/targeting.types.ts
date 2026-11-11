import type { AgentExecutionConfig } from "../contracts/agents/agent-execution.types.js";
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

export interface TrailStepEvidenceSettings {
  /** Wire/config contract version. Unknown versions must not be guessed. */
  readonly schemaVersion: 1;
  /** Opt-in. Omitted/false means no evidence package import or invocation. */
  readonly usage: boolean;
  /**
   * Explicitly authorized provider session roots keyed by registered package
   * provider id. Relative roots are resolved by the declaring config scope
   * before scope merging. Missing/empty roots with `usage: true` yield an
   * unavailable observation, never a fabricated zero.
   */
  readonly providerRoots?: Readonly<Record<string, readonly string[]>>;
}

export interface TrailStepSettings {
  readonly retry?: RetryPolicyInput;
  /** Backoff retry policy for transient working-agent spawn failures. */
  readonly spawnRetry?: SpawnRetryPolicyInput;
  readonly timeout?: TimeoutPolicyInput;
  /** Opt-in. Reports a stall when an agent attempt produces no output for this long. */
  readonly stallTimeout?: TimeoutPolicyInput;
  /**
   * Execution (hygiene) block applied to agent roles that do not define
   * their own block. Merged field by field with the per-workflow block and
   * the agent role's block (per-workflow wins over this one).
   */
  readonly execution?: AgentExecutionConfig;
  /** Opt-in provider evidence collection (A3). Default off. */
  readonly evidence?: TrailStepEvidenceSettings;
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
