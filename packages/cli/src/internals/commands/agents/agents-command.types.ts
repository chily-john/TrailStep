import type { ConfiguredCustomProvider } from "../../agent-config/configure-target-flow.js";
import type { WorkflowRegistryScope } from "../../workflow-registry/workflow-registry.js";

export const THINKING_CHOICES = ["none", "low", "medium", "high", "xhigh", "max"] as const;

export type AgentEntryItems = readonly Record<string, unknown>[];

export interface AgentEntryEditResult {
  readonly entry: AgentEntryItems;
  readonly customProviders: readonly ConfiguredCustomProvider[];
}

export type AgentCommandArgs =
  | {
      readonly action: "set";
      readonly name: string;
      readonly provider: string;
      readonly model?: string;
      readonly thinking?: (typeof THINKING_CHOICES)[number];
      readonly scope: WorkflowRegistryScope;
    }
  | {
      readonly action: "delete";
      readonly name: string;
      readonly scope: WorkflowRegistryScope;
    }
  | {
      readonly action: "rename";
      readonly oldName: string;
      readonly newName: string;
      readonly scope: WorkflowRegistryScope;
    }
  | {
      readonly action: "explain";
      readonly name: string;
      readonly scope: WorkflowRegistryScope;
    }
  | {
      readonly action: "explain-workflow";
      readonly workflowRef: string;
    }
  | {
      readonly action: "interactive";
    };

export interface MergedRawRoleConfig {
  readonly agents: Record<string, unknown>;
  workflowRoleEntry(workflowId: string, roleName: string): unknown;
}

export interface InteractiveNamedAgentRow {
  readonly kind: "named-agent";
  readonly name: string;
  readonly label: string;
}

export interface InteractiveWorkflowRoleRow {
  readonly kind: "workflow-role";
  readonly workflowId: string;
  readonly roleName: string;
  readonly label: string;
  readonly state: "dash" | "ref" | "inline";
  readonly ref?: string;
}

export type InteractiveRow = InteractiveNamedAgentRow | InteractiveWorkflowRoleRow;
