import { providerRegistry } from "@stepkit/core";

import {
  addAgentEntryItem,
  readAgentEntryItems,
} from "../../agent-config/agent-entry-items-flow.js";
import { configureLiteralAgentTarget } from "../../agent-config/configure-target-flow.js";
import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import { promptSelect, promptText } from "../../prompts/prompt-helpers.js";
import { installPackagedStepKitSkill } from "../../stepkit-skill/stepkit-skill.js";
import {
  configPathForScope,
  readRawStepKitConfigFile,
  type WorkflowRegistryScope,
  writeRawStepKitConfigFile,
} from "../../workflow-registry/workflow-registry.js";

type SkillInstallMode = "prompt" | "install" | "skip";

interface InitCommandArgs {
  readonly scope?: WorkflowRegistryScope;
  readonly skillInstallMode: SkillInstallMode;
}

const SCOPE_PROMPT_LABEL = "Where should agent config be written?";
const SKILL_INSTALL_PROMPT_LABEL = "Install the StepKit usage/authoring skill?";
const PROVIDER_CHOICES = Object.keys(providerRegistry).sort();

export const initCommand: CliCommand<InitCommandArgs> = {
  name: "init",
  parseArgs(argv: readonly string[]): InitCommandArgs {
    if (argv[0] !== "init") {
      throw new CliUsageError("Expected init command.");
    }

    const flags = parseFlags(argv.slice(1));
    const scope = flags.scope;
    if (scope !== undefined && scope !== "local" && scope !== "project" && scope !== "global") {
      throw new CliUsageError(
        "stepkit init requires --scope local, --scope project, or --scope global.",
      );
    }

    return {
      ...(scope === undefined ? {} : { scope }),
      skillInstallMode: resolveSkillInstallMode(flags),
    };
  },
  async run(args: InitCommandArgs, context: CliCommandContext): Promise<number> {
    const scope =
      args.scope ??
      (await promptSelect(
        SCOPE_PROMPT_LABEL,
        ["local", "project", "global"] as const,
        context.prompts,
        "stepkit init requires --scope <local|project|global> when prompts are unavailable.",
      ));

    if (context.prompts === undefined) {
      throw new CliUsageError("stepkit init requires prompts to configure an agent target.");
    }

    const configPath = configPathForScope(scope, context);
    const config = await readRawStepKitConfigFile(configPath);
    let nextConfig = await addConfiguredAgentEntry(config, "default", context);

    while (await shouldConfigureAnotherAgent(context)) {
      const name = await promptText(
        "Agent name",
        undefined,
        context.prompts,
        "stepkit init requires an agent name.",
      );
      nextConfig = await addConfiguredAgentEntry(nextConfig, name, context);
    }

    await writeRawStepKitConfigFile(configPath, nextConfig);
    context.io.writeLine(`Wrote StepKit agent config to ${configPath}.`);

    if (await shouldInstallSkill(args.skillInstallMode, context)) {
      await installStepKitSkillOrThrow(scope, context);
      context.io.writeLine("Installed StepKit usage skill.");
    }

    return 0;
  },
};

function parseFlags(argv: readonly string[]): Record<string, string | undefined> {
  const flags: Record<string, string | undefined> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--install-skill") {
      flags.installSkill = "true";
      continue;
    }

    if (option === "--no-install-skill") {
      flags.noInstallSkill = "true";
      continue;
    }

    if (option !== "--scope") {
      throw new CliUsageError(`Unknown option for stepkit init: ${option ?? ""}`);
    }

    const value = argv[index + 1];
    if (!value) {
      throw new CliUsageError(`Missing value for ${option}.`);
    }

    flags.scope = value;
    index += 1;
  }

  return flags;
}

function resolveSkillInstallMode(flags: Record<string, string | undefined>): SkillInstallMode {
  if (flags.installSkill === "true" && flags.noInstallSkill === "true") {
    throw new CliUsageError("Use only one of --install-skill or --no-install-skill.");
  }
  if (flags.installSkill === "true") {
    return "install";
  }
  if (flags.noInstallSkill === "true") {
    return "skip";
  }
  return "prompt";
}

async function shouldInstallSkill(
  mode: SkillInstallMode,
  context: CliCommandContext,
): Promise<boolean> {
  if (mode === "install") {
    return true;
  }
  if (mode === "skip" || context.prompts === undefined) {
    return false;
  }
  if (context.prompts.confirm !== undefined) {
    return context.prompts.confirm(SKILL_INSTALL_PROMPT_LABEL);
  }
  return (
    (await promptSelect(
      SKILL_INSTALL_PROMPT_LABEL,
      ["no", "yes"] as const,
      context.prompts,
      "stepkit init requires a yes/no answer.",
    )) === "yes"
  );
}

async function installStepKitSkillOrThrow(
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<void> {
  try {
    await installPackagedStepKitSkill(scope, context);
  } catch (error) {
    throw new CliUsageError(
      `Failed to install StepKit usage skill after writing StepKit agent config: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

async function addConfiguredAgentEntry(
  config: Record<string, unknown>,
  name: string,
  context: CliCommandContext,
): Promise<Record<string, unknown>> {
  if (context.prompts === undefined) {
    throw new CliUsageError("stepkit init requires prompts to configure an agent target.");
  }

  const configured = await configureLiteralAgentTarget({
    prompts: context.prompts,
    providerChoices: PROVIDER_CHOICES,
  });

  const agents = toMutableRecord(config.agents);
  const existingItems = readAgentEntryItems(agents[name]);
  agents[name] = addAgentEntryItem(existingItems, { ...configured.target });

  if (configured.customProvider === undefined) {
    return { ...config, agents };
  }

  const customProviders = toMutableRecord(config.customProviders);
  customProviders[configured.customProvider.name] = { ...configured.customProvider.config };
  return { ...config, customProviders, agents };
}

async function shouldConfigureAnotherAgent(context: CliCommandContext): Promise<boolean> {
  if (context.prompts === undefined) {
    return false;
  }
  if (context.prompts.confirm !== undefined) {
    return context.prompts.confirm("Configure another agent?");
  }
  return (
    (await promptSelect(
      "Configure another agent?",
      ["no", "yes"] as const,
      context.prompts,
      "stepkit init requires a yes/no answer.",
    )) === "yes"
  );
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
