import { providerRegistry } from "@trailstep/core";

import { runAgentSetupWizard } from "../../agent-config/agent-setup-wizard.js";
import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import { promptSelect, promptText } from "../../prompts/prompt-helpers.js";
import { installPackagedTrailStepSkill } from "../../trailstep-skill/trailstep-skill.js";
import {
  configPathForScope,
  readRawTrailStepConfigFile,
  type WorkflowRegistryScope,
  writeRawTrailStepConfigFile,
} from "../../workflow-registry/workflow-registry.js";

type SkillInstallMode = "prompt" | "install" | "skip";

interface InitCommandArgs {
  readonly scope?: WorkflowRegistryScope;
  readonly skillInstallMode: SkillInstallMode;
}

const SCOPE_PROMPT_LABEL = "Where should agent config be written?";
const SKILL_INSTALL_PROMPT_LABEL = "Install the TrailStep usage/authoring skill?";
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
        "trailstep init requires --scope local, --scope project, or --scope global.",
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
        "trailstep init requires --scope <local|project|global> when prompts are unavailable.",
      ));

    if (context.prompts === undefined) {
      throw new CliUsageError("trailstep init requires prompts to configure an agent target.");
    }

    const configPath = configPathForScope(scope, context);
    const config = await readRawTrailStepConfigFile(configPath);
    let nextConfig = await runAgentSetupWizard({
      config,
      agentName: "default",
      prompts: context.prompts,
      providerChoices: PROVIDER_CHOICES,
    });

    while (await shouldConfigureAnotherAgent(context)) {
      const name = await promptText(
        "Agent name",
        undefined,
        context.prompts,
        "trailstep init requires an agent name.",
      );
      nextConfig = await runAgentSetupWizard({
        config: nextConfig,
        agentName: name,
        prompts: context.prompts,
        providerChoices: PROVIDER_CHOICES,
      });
    }

    await writeRawTrailStepConfigFile(configPath, nextConfig);
    context.io.writeLine(`Wrote TrailStep agent config to ${configPath}.`);

    if (await shouldInstallSkill(args.skillInstallMode, context)) {
      await installTrailStepSkillOrThrow(scope, context);
      context.io.writeLine("Installed TrailStep usage skill.");
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
      throw new CliUsageError(`Unknown option for trailstep init: ${option ?? ""}`);
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
      "trailstep init requires a yes/no answer.",
    )) === "yes"
  );
}

async function installTrailStepSkillOrThrow(
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<void> {
  try {
    await installPackagedTrailStepSkill(scope, context);
  } catch (error) {
    throw new CliUsageError(
      `Failed to install TrailStep usage skill after writing TrailStep agent config: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
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
      "trailstep init requires a yes/no answer.",
    )) === "yes"
  );
}
