import type { TrailStepCliPrompts } from "../command.types.js";
import { addAgentEntryItem, readAgentEntryItems } from "./agent-entry-items-flow.js";
import { configureLiteralAgentTarget } from "./configure-target-flow.js";

export interface AgentSetupWizardOptions {
  readonly config: Record<string, unknown>;
  readonly agentName: string;
  readonly prompts: TrailStepCliPrompts;
  readonly providerChoices: readonly string[];
}

export async function runAgentSetupWizard(
  options: AgentSetupWizardOptions,
): Promise<Record<string, unknown>> {
  const configured = await configureLiteralAgentTarget({
    prompts: options.prompts,
    providerChoices: options.providerChoices,
  });

  const agents = toMutableRecord(options.config.agents);
  const existingItems = readAgentEntryItems(agents[options.agentName]);
  agents[options.agentName] = addAgentEntryItem(existingItems, { ...configured.target });

  if (configured.customProvider === undefined) {
    return { ...options.config, agents };
  }

  const customProviders = toMutableRecord(options.config.customProviders);
  customProviders[configured.customProvider.name] = { ...configured.customProvider.config };
  return { ...options.config, customProviders, agents };
}

export function hasConfiguredAgentEntries(config: Record<string, unknown>): boolean {
  const agents = toMutableRecord(config.agents);
  return Object.values(agents).some((entry) => readAgentEntryItems(entry).length > 0);
}

function toMutableRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  return { ...value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
