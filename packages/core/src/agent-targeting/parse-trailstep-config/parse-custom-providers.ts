import type { WorkflowAgentThinking } from "../../contracts/agents/agent-role.types.js";
import type {
  TrailStepCustomProviderConfig,
  TrailStepCustomProviderModelOverrideSupport,
  TrailStepCustomProviderThinkingOverrideSupport,
} from "../targeting.types.js";
import { isRecord, parseOptionalStringArray, parseOptionalStringRecord } from "./parse-utils.js";

const THINKING_LEVELS = new Set<WorkflowAgentThinking>(["low", "medium", "high", "xhigh", "max"]);

export function parseCustomProviders(
  value: unknown,
  diagnostics: string[],
): Record<string, TrailStepCustomProviderConfig> {
  const customProviders: Record<string, TrailStepCustomProviderConfig> = {};

  if (value === undefined) {
    return customProviders;
  }

  if (!isRecord(value)) {
    diagnostics.push("customProviders must be an object.");
    return customProviders;
  }

  for (const [name, providerConfig] of Object.entries(value)) {
    if (!isRecord(providerConfig)) {
      diagnostics.push(`customProviders.${name} must be an object.`);
      continue;
    }

    if (typeof providerConfig.binary !== "string" || providerConfig.binary.length === 0) {
      diagnostics.push(`customProviders.${name}.binary must be a non-empty string.`);
      continue;
    }

    const args = parseOptionalStringArray(
      `customProviders.${name}.args`,
      providerConfig.args,
      diagnostics,
    );
    const interactiveArgs = parseOptionalStringArray(
      `customProviders.${name}.interactiveArgs`,
      providerConfig.interactiveArgs,
      diagnostics,
    );
    const model = parseCustomProviderModelSupport(
      `customProviders.${name}.model`,
      providerConfig.model,
      diagnostics,
    );
    const thinking = parseCustomProviderThinkingSupport(
      `customProviders.${name}.thinking`,
      providerConfig.thinking,
      diagnostics,
    );
    const env = parseOptionalStringRecord(
      `customProviders.${name}.env`,
      providerConfig.env,
      diagnostics,
    );

    if (providerConfig.cwd !== undefined && typeof providerConfig.cwd !== "string") {
      diagnostics.push(`customProviders.${name}.cwd must be a string when present.`);
    }

    customProviders[name] = {
      binary: providerConfig.binary,
      ...(args === undefined ? {} : { args }),
      ...(interactiveArgs === undefined ? {} : { interactiveArgs }),
      ...(model === undefined ? {} : { model }),
      ...(thinking === undefined ? {} : { thinking }),
      ...(typeof providerConfig.cwd === "string" ? { cwd: providerConfig.cwd } : {}),
      ...(env === undefined ? {} : { env }),
    };
  }

  return customProviders;
}

function parseCustomProviderModelSupport(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepCustomProviderModelOverrideSupport | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value) || typeof value.supported !== "boolean") {
    diagnostics.push(`${path} must be an object with a boolean supported field when present.`);
    return undefined;
  }

  if (!value.supported) {
    return { supported: false };
  }

  if (value.flag !== undefined && (typeof value.flag !== "string" || value.flag.length === 0)) {
    diagnostics.push(`${path}.flag must be a non-empty string when present.`);
    return undefined;
  }

  return {
    supported: true,
    ...(typeof value.flag === "string" ? { flag: value.flag } : {}),
  };
}

function parseCustomProviderThinkingSupport(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepCustomProviderThinkingOverrideSupport | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value) || typeof value.supported !== "boolean") {
    diagnostics.push(`${path} must be an object with a boolean supported field when present.`);
    return undefined;
  }

  if (!value.supported) {
    if (value.levels !== undefined && (!Array.isArray(value.levels) || value.levels.length > 0)) {
      diagnostics.push(`${path}.levels must be an empty array when thinking support is disabled.`);
      return undefined;
    }

    return value.levels === undefined ? { supported: false } : { supported: false, levels: [] };
  }

  if (value.flag !== undefined && (typeof value.flag !== "string" || value.flag.length === 0)) {
    diagnostics.push(`${path}.flag must be a non-empty string when present.`);
    return undefined;
  }

  if (!Array.isArray(value.levels) || value.levels.length === 0) {
    diagnostics.push(`${path}.levels must be a non-empty array of supported thinking levels.`);
    return undefined;
  }

  const levels: WorkflowAgentThinking[] = [];
  for (const [index, level] of value.levels.entries()) {
    if (typeof level !== "string" || !THINKING_LEVELS.has(level as WorkflowAgentThinking)) {
      diagnostics.push(`${path}.levels[${index}] must be one of low, medium, high, xhigh, or max.`);
      continue;
    }
    levels.push(level as WorkflowAgentThinking);
  }

  if (levels.length !== value.levels.length) {
    return undefined;
  }

  return {
    supported: true,
    ...(typeof value.flag === "string" ? { flag: value.flag } : {}),
    levels,
  };
}
