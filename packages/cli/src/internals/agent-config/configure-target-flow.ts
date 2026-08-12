import {
  type ProviderModelDiscoverySpec,
  type ProviderRegistryKey,
  providerRegistry,
  type TrailStepAgentTarget,
  type TrailStepCustomProviderConfig,
} from "@trailstep/core";

import {
  CliUsageError,
  type PackageCommandRunner,
  type TrailStepCliIo,
  type TrailStepCliPrompts,
} from "../command.types.js";
import { discoverPiModelOverrides } from "./pi-model-discovery.js";

const PROVIDER_DEFAULT_CHOICE = "Use provider default";
const TYPE_MANUALLY_CHOICE = "Type manually";
const MODEL_OVERRIDE_CHOICES = [PROVIDER_DEFAULT_CHOICE, TYPE_MANUALLY_CHOICE] as const;
const PI_DISCOVERY_WARNING =
  "Warning: Could not discover Pi models; continuing with manual model entry.";
const GENERIC_THINKING_LEVEL_CHOICES = ["low", "medium", "high", "xhigh", "max"] as const;
const GENERIC_THINKING_OVERRIDE_CHOICES = [
  PROVIDER_DEFAULT_CHOICE,
  ...GENERIC_THINKING_LEVEL_CHOICES,
] as const;

export interface ConfigureLiteralAgentTargetOptions {
  readonly prompts: TrailStepCliPrompts;
  readonly providerChoices: readonly string[];
  readonly cwd?: string;
  readonly io?: TrailStepCliIo;
  readonly packageCommandRunner?: PackageCommandRunner;
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
  const modelChoices = await modelOverrideChoicesForProvider({
    providerSelection,
    customProvider,
    cwd: options.cwd,
    io: options.io,
    packageCommandRunner: options.packageCommandRunner,
  });
  const modelSelection = await options.prompts.select("Model override", modelChoices);
  if (!modelChoices.includes(modelSelection)) {
    throw new CliUsageError(`Invalid model override selection: ${modelSelection}`);
  }
  const model = await modelOverrideForSelection(modelSelection, options.prompts);

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

interface ModelOverrideChoicesOptions {
  readonly providerSelection: string;
  readonly customProvider: ConfiguredCustomProvider | undefined;
  readonly cwd: string | undefined;
  readonly io: TrailStepCliIo | undefined;
  readonly packageCommandRunner: PackageCommandRunner | undefined;
}

async function modelOverrideChoicesForProvider({
  providerSelection,
  customProvider,
  cwd,
  io,
  packageCommandRunner,
}: ModelOverrideChoicesOptions): Promise<readonly string[]> {
  if (customProvider !== undefined) {
    return MODEL_OVERRIDE_CHOICES;
  }

  const discovery = modelDiscoverySpecForProvider(providerSelection);
  if (discovery === undefined) {
    return MODEL_OVERRIDE_CHOICES;
  }

  try {
    const discoveredModels = await discoverModelOverrides({
      discovery,
      cwd: cwd ?? process.cwd(),
      packageCommandRunner,
    });
    const discoveredChoices = discoveredModelChoices(discoveredModels);
    if (discoveredChoices.length === 0) {
      throw new Error("No usable model choices were discovered.");
    }
    return [PROVIDER_DEFAULT_CHOICE, ...discoveredChoices, TYPE_MANUALLY_CHOICE];
  } catch {
    io?.writeError(PI_DISCOVERY_WARNING);
    return MODEL_OVERRIDE_CHOICES;
  }
}

function modelDiscoverySpecForProvider(
  providerSelection: string,
): ProviderModelDiscoverySpec | undefined {
  if (!Object.hasOwn(providerRegistry, providerSelection)) {
    return undefined;
  }

  const modelSupport = providerRegistry[providerSelection as ProviderRegistryKey].spec.model;
  return modelSupport.supported ? modelSupport.discovery : undefined;
}

async function discoverModelOverrides(options: {
  readonly discovery: ProviderModelDiscoverySpec;
  readonly cwd: string;
  readonly packageCommandRunner: PackageCommandRunner | undefined;
}): Promise<readonly string[]> {
  switch (options.discovery.outputParser) {
    case "pi-list-models-table":
      return await discoverPiModelOverrides({
        cwd: options.cwd,
        command: options.discovery.command,
        args: options.discovery.args,
        packageCommandRunner: options.packageCommandRunner,
      });
  }
}

function discoveredModelChoices(models: readonly string[]): readonly string[] {
  return [...new Set(models.map((model) => model.trim()))].filter(
    (model) =>
      model.length > 0 && model !== PROVIDER_DEFAULT_CHOICE && model !== TYPE_MANUALLY_CHOICE,
  );
}

async function modelOverrideForSelection(
  modelSelection: string,
  prompts: TrailStepCliPrompts,
): Promise<string> {
  if (modelSelection === TYPE_MANUALLY_CHOICE) {
    return (await prompts.text("Model")).trim();
  }
  if (modelSelection === PROVIDER_DEFAULT_CHOICE) {
    return "";
  }
  return modelSelection;
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
