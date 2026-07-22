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
    const entryPath = `${path}.${name}`;
    if (!isRecord(entry)) {
      diagnostics.push(`${entryPath} must be an object with an items array.`);
      continue;
    }

    mappings[name] = parseTargetArray(`${entryPath}.items`, entry.items, diagnostics);
  }

  return mappings;
}
