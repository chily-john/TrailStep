import type {
  StepKitAgentTarget,
  StepKitRoleAgentMappings,
  StepKitWorkflowConfig,
} from "../targeting.types.js";
import { parseTargetArray } from "./parse-agent-targets.js";
import { isRecord } from "./parse-utils.js";

export function parseWorkflows(
  value: unknown,
  diagnostics: string[],
): Record<string, StepKitWorkflowConfig> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const workflows: Record<string, StepKitWorkflowConfig> = {};

  if (!isRecord(value)) {
    diagnostics.push("workflows must be an object when present.");
    return workflows;
  }

  for (const [workflowId, workflow] of Object.entries(value)) {
    if (!isRecord(workflow)) {
      diagnostics.push(`workflows.${workflowId} must be an object.`);
      continue;
    }

    const workingAgents = parseRoleAgentMappings(
      `workflows.${workflowId}.workingAgents`,
      workflow.workingAgents,
      diagnostics,
    );
    const interactiveAgents = parseRoleAgentMappings(
      `workflows.${workflowId}.interactiveAgents`,
      workflow.interactiveAgents,
      diagnostics,
    );

    if (workflow.settings !== undefined && !isRecord(workflow.settings)) {
      diagnostics.push(`workflows.${workflowId}.settings must be an object when present.`);
    }

    workflows[workflowId] = {
      ...(workingAgents === undefined ? {} : { workingAgents }),
      ...(interactiveAgents === undefined ? {} : { interactiveAgents }),
      ...(isRecord(workflow.settings) ? { settings: workflow.settings } : {}),
    };
  }

  return workflows;
}

function parseRoleAgentMappings(
  path: string,
  value: unknown,
  diagnostics: string[],
): StepKitRoleAgentMappings | undefined {
  if (value === undefined) {
    return undefined;
  }

  const mappings: Record<string, readonly StepKitAgentTarget[]> = {};

  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object.`);
    return mappings;
  }

  for (const [roleName, targets] of Object.entries(value)) {
    mappings[roleName] = parseTargetArray(`${path}.${roleName}`, targets, diagnostics);
  }

  return mappings;
}
