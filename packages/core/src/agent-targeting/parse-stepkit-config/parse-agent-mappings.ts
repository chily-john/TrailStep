import {
  parseTargetArray,
  type RawStepKitAgentMappings,
  type RawStepKitAgentTarget,
} from "./parse-agent-targets.js";
import { isRecord } from "./parse-utils.js";

export function parseAgentMappings(
  path: string,
  value: unknown,
  diagnostics: string[],
): RawStepKitAgentMappings {
  const mappings: Record<string, readonly RawStepKitAgentTarget[]> = {};

  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object.`);
    return mappings;
  }

  for (const [name, entry] of Object.entries(value)) {
    mappings[name] = parseTargetArray(`${path}.${name}`, entry, diagnostics);
  }

  return mappings;
}
