import type { TrailStepAgentTarget, TrailStepCustomProviderConfig } from "@trailstep/core";

import { CliUsageError, type TrailStepCliPrompts } from "../command.types.js";

const THINKING_CHOICES = ["none", "low", "medium", "high", "xhigh", "max"] as const;

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
  const model = (await options.prompts.text("Model")).trim();
  const thinking = await options.prompts.select("Thinking", THINKING_CHOICES);

  if (!THINKING_CHOICES.includes(thinking as (typeof THINKING_CHOICES)[number])) {
    throw new CliUsageError(`Invalid thinking selection: ${thinking}`);
  }

  const target: TrailStepAgentTarget = {
    provider,
    ...(model.length === 0 ? {} : { model }),
    ...(thinking === "none" ? {} : { thinking: thinking as TrailStepAgentTarget["thinking"] }),
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
