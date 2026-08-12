import type { TrailStepAgentTarget, TrailStepCustomProviderConfig } from "@trailstep/core";

import { CliUsageError, type TrailStepCliPrompts } from "../command.types.js";

const PROVIDER_DEFAULT_CHOICE = "Use provider default";
const TYPE_MANUALLY_CHOICE = "Type manually";
const MODEL_OVERRIDE_CHOICES = [PROVIDER_DEFAULT_CHOICE, TYPE_MANUALLY_CHOICE] as const;
const THINKING_LEVEL_CHOICES = ["low", "medium", "high", "xhigh", "max"] as const;
const THINKING_OVERRIDE_CHOICES = [PROVIDER_DEFAULT_CHOICE, ...THINKING_LEVEL_CHOICES] as const;

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

  const thinkingSelection = await options.prompts.select(
    "Reasoning/thinking override",
    THINKING_OVERRIDE_CHOICES,
  );
  if (
    !THINKING_OVERRIDE_CHOICES.includes(
      thinkingSelection as (typeof THINKING_OVERRIDE_CHOICES)[number],
    )
  ) {
    throw new CliUsageError(`Invalid thinking override selection: ${thinkingSelection}`);
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
