import { parseAgentMappings } from "./parse-agent-mappings.js";
import type { RawStepKitAgentMappings } from "./parse-agent-targets.js";
import { isRecord } from "./parse-utils.js";

export interface RawStepKitWorkflowConfig {
  readonly agents?: RawStepKitAgentMappings;
  readonly settings?: Readonly<Record<string, unknown>>;
}

export function parseWorkflows(
  value: unknown,
  diagnostics: string[],
): Record<string, RawStepKitWorkflowConfig> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const workflows: Record<string, RawStepKitWorkflowConfig> = {};

  if (!isRecord(value)) {
    diagnostics.push("workflows must be an object when present.");
    return workflows;
  }

  for (const [workflowId, workflow] of Object.entries(value)) {
    if (!isRecord(workflow)) {
      diagnostics.push(`workflows.${workflowId} must be an object.`);
      continue;
    }

    const agents =
      workflow.agents === undefined
        ? undefined
        : parseAgentMappings(`workflows.${workflowId}.agents`, workflow.agents, diagnostics);

    if (workflow.settings !== undefined && !isRecord(workflow.settings)) {
      diagnostics.push(`workflows.${workflowId}.settings must be an object when present.`);
    }

    workflows[workflowId] = {
      ...(agents === undefined ? {} : { agents }),
      ...(isRecord(workflow.settings) ? { settings: workflow.settings } : {}),
    };
  }

  return workflows;
}
