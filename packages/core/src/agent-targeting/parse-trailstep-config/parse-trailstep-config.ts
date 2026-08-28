import { parseTrailStepProviderRegistrations } from "../../providers/provider-manifest.js";
import type { TrailStepConfig } from "../targeting.types.js";
import { expandAgentRefs } from "./expand-agent-refs.js";
import { parseAgentMappings } from "./parse-agent-mappings.js";
import { parseCustomProviders } from "./parse-custom-providers.js";
import { parseSettings } from "./parse-settings.js";
import { isRecord, throwValidationFailure } from "./parse-utils.js";
import { parseWorkflows } from "./parse-workflow-agent-mappings.js";
import { validateProviderReferences } from "./validate-provider-references.js";

export type ParsedTrailStepConfig = TrailStepConfig & {
  readonly providers: NonNullable<TrailStepConfig["providers"]>;
};

const parsedConfigs = new WeakSet<TrailStepConfig>();

export function isParsedTrailStepConfig(value: unknown): value is TrailStepConfig {
  return isRecord(value) && parsedConfigs.has(value as unknown as TrailStepConfig);
}

export function parseTrailStepConfig(value: unknown): ParsedTrailStepConfig {
  const diagnostics: string[] = [];

  if (!isRecord(value)) {
    throwValidationFailure(["config must be an object."]);
  }

  if (value.version !== 1) {
    diagnostics.push("version must be 1.");
  }

  const customProviders = parseCustomProviders(value.customProviders, diagnostics);
  const providers = parseTrailStepProviderRegistrations("providers", value.providers, diagnostics);
  const providerNames = new Set([...Object.keys(customProviders), ...Object.keys(providers)]);
  const agents = parseAgentMappings("agents", value.agents, diagnostics);
  const settings = parseSettings("settings", value.settings, diagnostics);
  const workflows = parseWorkflows(value.workflows, diagnostics);

  if (diagnostics.length > 0) {
    throwValidationFailure(diagnostics);
  }

  validateProviderReferences({ agents, workflows, providerNames });
  const expanded = expandAgentRefs({ agents, workflows });

  const config = {
    version: 1,
    customProviders,
    ...(Object.keys(providers).length === 0 ? {} : { providers }),
    agents: expanded.agents,
    ...(settings === undefined ? {} : { settings }),
    ...(expanded.workflows === undefined ? {} : { workflows: expanded.workflows }),
  } as ParsedTrailStepConfig;

  if (Object.keys(providers).length === 0) {
    Object.defineProperty(config, "providers", { value: providers, enumerable: false });
  }

  parsedConfigs.add(config);

  return config;
}
