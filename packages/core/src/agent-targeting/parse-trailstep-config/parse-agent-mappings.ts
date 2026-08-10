import {
  parseTargetArray,
  type RawTrailStepAgentMappings,
  type RawTrailStepAgentTarget,
} from "./parse-agent-targets.js";
import { isRecord } from "./parse-utils.js";

export function parseAgentMappings(
  path: string,
  value: unknown,
  diagnostics: string[],
): RawTrailStepAgentMappings {
  const mappings: Record<string, readonly RawTrailStepAgentTarget[]> = {};

  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object.`);
    return mappings;
  }

  for (const [name, entry] of Object.entries(value)) {
    mappings[name] = parseTargetArray(`${path}.${name}`, entry, diagnostics);
  }

  return mappings;
}
