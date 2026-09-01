import type {
  ProviderModelDiscoverySpec,
  TrailStepAgentTarget,
  TrailStepCustomProviderConfig,
  TrailStepCustomProviderModelOverrideSupport,
  TrailStepCustomProviderThinkingOverrideSupport,
  WorkflowAgentThinking,
} from "@trailstep/core";

import {
  CliUsageError,
  type PackageCommandRunner,
  type TrailStepCliIo,
  type TrailStepCliPrompts,
} from "../command.types.js";
import { officialProviderSpecFor } from "../official-provider-specs.js";
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
const PROMPT_FILE_STYLE = "Prompt file path ({{promptFile}})";
const OUTPUT_FILE_STYLE = "Output file path ({{outputFile}})";
const WORKING_ARGS_PROMPT =
  "Working/print-mode args JSON array (blank for TrailStep defaults; placeholders: {{promptFile}}, {{outputFile}}, {{#model}}...{{/model}}, {{#thinking}}...{{/thinking}})";
const INTERACTIVE_ARGS_PROMPT =
  "Interactive args JSON array (blank for TrailStep defaults; placeholders: {{promptFile}}, {{prompt}}, {{#model}}...{{/model}}, {{#thinking}}...{{/thinking}})";
const SUPPORTED_THINKING_LEVELS_TEXT_PROMPT =
  "Supported thinking levels (comma-separated: low, medium, high, xhigh, max)";

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
  const model = await promptModelOverride(modelChoices, options.prompts);

  const thinkingChoices = thinkingOverrideChoicesForProvider(providerSelection, customProvider);
  const thinkingSelection = await promptThinkingOverride(thinkingChoices, options.prompts);

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
    return customProvider.config.model?.supported === true ? MODEL_OVERRIDE_CHOICES : [];
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
  const modelSupport = officialProviderSpecFor(providerSelection)?.model;
  return modelSupport?.supported === true ? modelSupport.discovery : undefined;
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

async function promptModelOverride(
  modelChoices: readonly string[],
  prompts: TrailStepCliPrompts,
): Promise<string> {
  if (modelChoices.length === 0) {
    return "";
  }

  const modelSelection = await prompts.select("Model override", modelChoices);
  if (!modelChoices.includes(modelSelection)) {
    throw new CliUsageError(`Invalid model override selection: ${modelSelection}`);
  }
  return await modelOverrideForSelection(modelSelection, prompts);
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
    const thinking = customProvider.config.thinking;
    return thinking?.supported === true ? [PROVIDER_DEFAULT_CHOICE, ...thinking.levels] : [];
  }
  const thinkingSupport = officialProviderSpecFor(providerSelection)?.thinking;
  if (thinkingSupport === undefined) {
    return GENERIC_THINKING_OVERRIDE_CHOICES;
  }
  if (!thinkingSupport.supported) {
    return [];
  }

  return [PROVIDER_DEFAULT_CHOICE, ...thinkingSupport.levels];
}

async function promptThinkingOverride(
  thinkingChoices: readonly string[],
  prompts: TrailStepCliPrompts,
): Promise<string> {
  if (thinkingChoices.length === 0) {
    return PROVIDER_DEFAULT_CHOICE;
  }

  const thinkingSelection = await prompts.select("Reasoning/thinking override", thinkingChoices);
  if (!thinkingChoices.includes(thinkingSelection)) {
    throw new CliUsageError(`Invalid thinking override selection: ${thinkingSelection}`);
  }
  return thinkingSelection;
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

  await promptSingleSupportedChoice({
    prompts,
    label: "Prompt input style",
    choice: PROMPT_FILE_STYLE,
    errorMessage: "Custom provider prompt input style is not supported.",
  });
  await promptSingleSupportedChoice({
    prompts,
    label: "Output style",
    choice: OUTPUT_FILE_STYLE,
    errorMessage: "Custom provider output style is not supported.",
  });

  const interactiveSupported = await promptYesNo(
    prompts,
    "Custom provider supports interactive steps?",
  );
  const model = await promptCustomProviderModelSupport(prompts);
  const thinking = await promptCustomProviderThinkingSupport(prompts);
  const workingArgs = await promptCustomProviderArgs({
    prompts,
    label: WORKING_ARGS_PROMPT,
    kind: "Working/print-mode args",
    defaults: defaultWorkingArgs({ model, thinking }),
  });
  const interactiveArgs = interactiveSupported
    ? await promptCustomProviderArgs({
        prompts,
        label: INTERACTIVE_ARGS_PROMPT,
        kind: "Interactive args",
        defaults: defaultInteractiveArgs({ model, thinking }),
      })
    : undefined;

  return {
    name,
    config: {
      binary,
      args: workingArgs,
      ...(interactiveArgs === undefined ? {} : { interactiveArgs }),
      model,
      thinking,
    },
  };
}

async function promptSingleSupportedChoice(options: {
  readonly prompts: TrailStepCliPrompts;
  readonly label: string;
  readonly choice: string;
  readonly errorMessage: string;
}): Promise<void> {
  const selection = await options.prompts.select(options.label, [options.choice]);
  if (selection !== options.choice) {
    throw new CliUsageError(options.errorMessage);
  }
}

async function promptYesNo(prompts: TrailStepCliPrompts, label: string): Promise<boolean> {
  if (prompts.confirm !== undefined) {
    return await prompts.confirm(label);
  }

  const selection = await prompts.select(label, ["no", "yes"]);
  if (selection !== "no" && selection !== "yes") {
    throw new CliUsageError(`Invalid yes/no selection for ${label}: ${selection}`);
  }
  return selection === "yes";
}

async function promptCustomProviderModelSupport(
  prompts: TrailStepCliPrompts,
): Promise<TrailStepCustomProviderModelOverrideSupport> {
  const supported = await promptYesNo(prompts, "Custom provider supports model overrides?");
  return supported ? { supported: true } : { supported: false };
}

async function promptCustomProviderThinkingSupport(
  prompts: TrailStepCliPrompts,
): Promise<TrailStepCustomProviderThinkingOverrideSupport> {
  const supported = await promptYesNo(prompts, "Custom provider supports thinking overrides?");
  if (!supported) {
    return { supported: false };
  }

  return { supported: true, levels: await promptSupportedThinkingLevels(prompts) };
}

async function promptSupportedThinkingLevels(
  prompts: TrailStepCliPrompts,
): Promise<readonly WorkflowAgentThinking[]> {
  const rawLevels =
    prompts.multiSelect === undefined
      ? parseThinkingLevelText(await prompts.text(SUPPORTED_THINKING_LEVELS_TEXT_PROMPT))
      : await prompts.multiSelect("Supported thinking levels", GENERIC_THINKING_LEVEL_CHOICES);
  const levels = normalizeThinkingLevels(rawLevels);
  if (levels.length === 0) {
    throw new CliUsageError("Custom provider thinking support requires at least one level.");
  }
  return levels;
}

function parseThinkingLevelText(value: string): readonly string[] {
  return value
    .split(",")
    .map((level) => level.trim())
    .filter((level) => level.length > 0);
}

function normalizeThinkingLevels(levels: readonly string[]): readonly WorkflowAgentThinking[] {
  const selected = new Set(levels);
  const invalid = [...selected].filter(
    (level) =>
      !GENERIC_THINKING_LEVEL_CHOICES.includes(
        level as (typeof GENERIC_THINKING_LEVEL_CHOICES)[number],
      ),
  );
  if (invalid.length > 0) {
    throw new CliUsageError(
      `Custom provider thinking levels must be one or more of low, medium, high, xhigh, or max: ${invalid.join(
        ", ",
      )}`,
    );
  }

  return GENERIC_THINKING_LEVEL_CHOICES.filter((level) => selected.has(level));
}

async function promptCustomProviderArgs(options: {
  readonly prompts: TrailStepCliPrompts;
  readonly label: string;
  readonly kind: string;
  readonly defaults: readonly string[];
}): Promise<readonly string[]> {
  const raw = (await options.prompts.text(options.label)).trim();
  if (raw.length === 0) {
    return options.defaults;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliUsageError(
      `${options.kind} must be a JSON array of strings: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(parsed) || parsed.some((arg) => typeof arg !== "string")) {
    throw new CliUsageError(`${options.kind} must be a JSON array of strings.`);
  }

  return [...parsed];
}

function defaultWorkingArgs(options: {
  readonly model: TrailStepCustomProviderModelOverrideSupport;
  readonly thinking: TrailStepCustomProviderThinkingOverrideSupport;
}): readonly string[] {
  return [
    "--prompt-file",
    "{{promptFile}}",
    "--output-file",
    "{{outputFile}}",
    ...optionalOverrideArgs({ supported: options.model.supported, flag: "--model", name: "model" }),
    ...optionalOverrideArgs({
      supported: options.thinking.supported,
      flag: "--thinking",
      name: "thinking",
    }),
  ];
}

function defaultInteractiveArgs(options: {
  readonly model: TrailStepCustomProviderModelOverrideSupport;
  readonly thinking: TrailStepCustomProviderThinkingOverrideSupport;
}): readonly string[] {
  return [
    "--prompt-file",
    "{{promptFile}}",
    ...optionalOverrideArgs({ supported: options.model.supported, flag: "--model", name: "model" }),
    ...optionalOverrideArgs({
      supported: options.thinking.supported,
      flag: "--thinking",
      name: "thinking",
    }),
  ];
}

function optionalOverrideArgs(options: {
  readonly supported: boolean;
  readonly flag: string;
  readonly name: "model" | "thinking";
}): readonly string[] {
  if (!options.supported) {
    return [];
  }

  return [`{{#${options.name}}}`, options.flag, `{{${options.name}}}`, `{{/${options.name}}}`];
}
