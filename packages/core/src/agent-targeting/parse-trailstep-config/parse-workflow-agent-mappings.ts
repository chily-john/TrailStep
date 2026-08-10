import type { TrailStepSettings } from "../targeting.types.js";
import { parseAgentMappings } from "./parse-agent-mappings.js";
import type { RawTrailStepAgentMappings } from "./parse-agent-targets.js";
import { parseSettings } from "./parse-settings.js";
import { isRecord } from "./parse-utils.js";

export interface RawTrailStepWorkflowConfig {
  readonly agents?: RawTrailStepAgentMappings;
  readonly settings?: TrailStepSettings;
}

export function parseWorkflows(
  value: unknown,
  diagnostics: string[],
): Record<string, RawTrailStepWorkflowConfig> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const workflows: Record<string, RawTrailStepWorkflowConfig> = {};

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

    const settings = parseSettings(
      `workflows.${workflowId}.settings`,
      workflow.settings,
      diagnostics,
    );

    workflows[workflowId] = {
      ...(agents === undefined ? {} : { agents }),
      ...(settings === undefined ? {} : { settings }),
    };
  }

  return workflows;
}
