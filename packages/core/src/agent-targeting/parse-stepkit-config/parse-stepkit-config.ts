import type { StepKitConfig } from "../targeting.types.js";
import { expandAgentRefs } from "./expand-agent-refs.js";
import { parseAgentMappings } from "./parse-agent-mappings.js";
import { parseCustomProviders } from "./parse-custom-providers.js";
import { isRecord, throwValidationFailure } from "./parse-utils.js";
import { parseWorkflows } from "./parse-workflow-agent-mappings.js";
import { validateProviderReferences } from "./validate-provider-references.js";

const parsedConfigs = new WeakSet<StepKitConfig>();

export function isParsedStepKitConfig(value: unknown): value is StepKitConfig {
  return isRecord(value) && parsedConfigs.has(value as unknown as StepKitConfig);
}

export function parseStepKitConfig(value: unknown): StepKitConfig {
  const diagnostics: string[] = [];

  if (!isRecord(value)) {
    throwValidationFailure(["config must be an object."]);
  }

  if (value.version !== 1) {
    diagnostics.push("version must be 1.");
  }

  const customProviders = parseCustomProviders(value.customProviders, diagnostics);
  const providerNames = new Set(Object.keys(customProviders));
  const agents = parseAgentMappings("agents", value.agents, diagnostics);
  const workflows = parseWorkflows(value.workflows, diagnostics);

  if (diagnostics.length > 0) {
    throwValidationFailure(diagnostics);
  }

  validateProviderReferences({ agents, workflows, providerNames });
  const expanded = expandAgentRefs({ agents, workflows });

  const config: StepKitConfig = {
    version: 1,
    customProviders,
    agents: expanded.agents,
    ...(expanded.workflows === undefined ? {} : { workflows: expanded.workflows }),
  };

  parsedConfigs.add(config);

  return config;
}
