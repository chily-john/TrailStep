import type { StepKitCustomAgentConfig } from "../targeting.types.js";
import { isRecord, parseOptionalStringArray, parseOptionalStringRecord } from "./parse-utils.js";

export function parseCustomAgents(
  value: unknown,
  diagnostics: string[],
): Record<string, StepKitCustomAgentConfig> {
  const customAgents: Record<string, StepKitCustomAgentConfig> = {};

  if (!isRecord(value)) {
    diagnostics.push("customAgents must be an object.");
    return customAgents;
  }

  for (const [name, agentConfig] of Object.entries(value)) {
    if (!isRecord(agentConfig)) {
      diagnostics.push(`customAgents.${name} must be an object.`);
      continue;
    }

    if (typeof agentConfig.binary !== "string" || agentConfig.binary.length === 0) {
      diagnostics.push(`customAgents.${name}.binary must be a non-empty string.`);
      continue;
    }

    const args = parseOptionalStringArray(
      `customAgents.${name}.args`,
      agentConfig.args,
      diagnostics,
    );
    const env = parseOptionalStringRecord(`customAgents.${name}.env`, agentConfig.env, diagnostics);

    if (agentConfig.cwd !== undefined && typeof agentConfig.cwd !== "string") {
      diagnostics.push(`customAgents.${name}.cwd must be a string when present.`);
    }

    customAgents[name] = {
      binary: agentConfig.binary,
      ...(args === undefined ? {} : { args }),
      ...(typeof agentConfig.cwd === "string" ? { cwd: agentConfig.cwd } : {}),
      ...(env === undefined ? {} : { env }),
    };
  }

  return customAgents;
}
