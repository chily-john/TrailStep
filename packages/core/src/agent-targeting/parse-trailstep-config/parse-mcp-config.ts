import { isRecord } from "../../json/guards.js";
import type { TrailStepMcpConfig } from "../targeting.types.js";

/**
 * Parses the optional `mcp` config section (MCP server behavior switches).
 *
 * `perWorkflowTools` must be a boolean when present; invalid values are
 * reported as diagnostics and dropped from the parsed section. The effective
 * default (`true`) is applied by the MCP server when the key or section is
 * absent, mirroring how other optional sections stay absent when unset.
 */
export function parseMcpConfig(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepMcpConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return undefined;
  }

  const config: Record<string, unknown> = { ...value };

  if (value.perWorkflowTools !== undefined && typeof value.perWorkflowTools !== "boolean") {
    diagnostics.push(`${path}.perWorkflowTools must be a boolean when present.`);
    delete config.perWorkflowTools;
  }

  return config as TrailStepMcpConfig;
}
