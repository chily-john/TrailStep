import {
  type ProviderRegistryKey,
  providerRegistry,
  type TrailStepAgentTarget,
  type TrailStepCustomProviderConfig,
} from "@trailstep/core";

import { CliUsageError, type TrailStepCliPrompts } from "../command.types.js";

const PROVIDER_DEFAULT_CHOICE = "Use provider default";
const TYPE_MANUALLY_CHOICE = "Type manually";
const MODEL_OVERRIDE_CHOICES = [PROVIDER_DEFAULT_CHOICE, TYPE_MANUALLY_CHOICE] as const;
const GENERIC_THINKING_LEVEL_CHOICES = ["low", "medium", "high", "xhigh", "max"] as const;
const GENERIC_THINKING_OVERRIDE_CHOICES = [
  PROVIDER_DEFAULT_CHOICE,
  ...GENERIC_THINKING_LEVEL_CHOICES,
] as const;

export interface ConfigureLiteralAgentTargetOptions {
  readonly prompts: TrailStepCliPrompts;
  readonly providerChoices: readonly string[];
}

export interface ConfiguredCustomProvider {
  readonly name: string;
  readonly config: TrailStepCustomProviderConfig;
}

export interface ConfigureLiteralAgentTargetResult {
  readonly target: TrailStepAgentTarget;
  readonly customProvider?: ConfiguredCustomProvider;
}

export async function configureLiteralAgentTarget(
  options: ConfigureLiteralAgentTargetOptions,
): Promise<ConfigureLiteralAgentTargetResult> {
  const providerSelection = await options.prompts.select("Provider", [
    ...options.providerChoices,
    "custom",
  ]);
  const customProvider =
    providerSelection === "custom" ? await promptCustomProvider(options.prompts) : undefined;
  const provider = customProvider?.name ?? providerSelection;
  const modelSelection = await options.prompts.select("Model override", MODEL_OVERRIDE_CHOICES);
  if (!MODEL_OVERRIDE_CHOICES.includes(modelSelection as (typeof MODEL_OVERRIDE_CHOICES)[number])) {
    throw new CliUsageError(`Invalid model override selection: ${modelSelection}`);
  }
  const model =
    modelSelection === TYPE_MANUALLY_CHOICE ? (await options.prompts.text("Model")).trim() : "";

  const thinkingChoices = thinkingOverrideChoicesForProvider(providerSelection, customProvider);
  let thinkingSelection: string = PROVIDER_DEFAULT_CHOICE;
  if (thinkingChoices.length > 0) {
    thinkingSelection = await options.prompts.select(
      "Reasoning/thinking override",
      thinkingChoices,
    );
    if (!thinkingChoices.includes(thinkingSelection)) {
      throw new CliUsageError(`Invalid thinking override selection: ${thinkingSelection}`);
    }
  }

  const target: TrailStepAgentTarget = {
    provider,
    ...(model.length === 0 ? {} : { model }),
    ...(thinkingSelection === PROVIDER_DEFAULT_CHOICE
      ? {}
      : { thinking: thinkingSelection as TrailStepAgentTarget["thinking"] }),
  };

  return {
    target,
    ...(customProvider === undefined ? {} : { customProvider }),
  };
}

function thinkingOverrideChoicesForProvider(
  providerSelection: string,
  customProvider: ConfiguredCustomProvider | undefined,
): readonly string[] {
  if (customProvider !== undefined) {
    return GENERIC_THINKING_OVERRIDE_CHOICES;
  }
  if (!Object.hasOwn(providerRegistry, providerSelection)) {
    return GENERIC_THINKING_OVERRIDE_CHOICES;
  }

  const thinkingSupport = providerRegistry[providerSelection as ProviderRegistryKey].spec.thinking;
  if (!thinkingSupport.supported) {
    return [];
  }

  return [PROVIDER_DEFAULT_CHOICE, ...thinkingSupport.levels];
}

async function promptCustomProvider(
  prompts: TrailStepCliPrompts,
): Promise<ConfiguredCustomProvider> {
  const name = (await prompts.text("Custom provider name")).trim();
  if (name.length === 0) {
    throw new CliUsageError("Custom provider name is required.");
  }

  const binary = (await prompts.text("Custom provider binary")).trim();
  if (binary.length === 0) {
    throw new CliUsageError("Custom provider binary is required.");
  }

  return { name, config: { binary } };
}
