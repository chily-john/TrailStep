import type { WorkflowAgentSize } from "../../contracts/agents/agent-role.types.js";
import type { StepKitAgentTarget, StepKitSizeAgentMappings } from "../targeting.types.js";
import { AGENT_SIZES, parseTargetArray } from "./parse-agent-targets.js";
import { isRecord } from "./parse-utils.js";

export function parseSizeAgentMappings(
  path: string,
  value: unknown,
  diagnostics: string[],
): StepKitSizeAgentMappings {
  const mappings: Record<string, readonly StepKitAgentTarget[]> = {};

  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object.`);
    return mappings;
  }

  for (const [size, targets] of Object.entries(value)) {
    if (!AGENT_SIZES.has(size as WorkflowAgentSize)) {
      diagnostics.push(
        `${path}.${size} must be one of default, tiny, small, medium, large, or xl.`,
      );
      continue;
    }

    mappings[size] = parseTargetArray(`${path}.${size}`, targets, diagnostics);
  }

  return mappings;
}
