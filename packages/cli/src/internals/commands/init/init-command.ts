import { join } from "node:path";

import { runAgentSetupWizard } from "../../agent-config/agent-setup-wizard.js";
import type { CliCommand, CliCommandContext, TrailStepCliPrompts } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import { OFFICIAL_PROVIDER_IDS } from "../../official-provider-specs.js";
import {
  createPackageAddCommand,
  defaultPackageCommandRunner,
  detectPackageManager,
  isPnpmWorkspaceRoot,
} from "../../package-manager/package-manager.js";
import { promptSelect, promptText } from "../../prompts/prompt-helpers.js";
import {
  isOfficialProviderPackageName,
  OFFICIAL_PROVIDER_PACKAGES,
} from "../../providers/official-providers.js";
import { loadProviderPackage } from "../../providers/provider-package-loader.js";
import {
  createPackagedTrailStepSkillInstallationMarker,
  hasCurrentTrailStepSkillInstallationMarker,
  installPackagedTrailStepSkill,
  setTrailStepSkillInstallationMarker,
  type TrailStepSkillInstallationMarker,
  trailStepSkillInstallTargetForScope,
} from "../../trailstep-skill/trailstep-skill.js";
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
const OFFICIAL_PROVIDER_ADD_GUIDANCE =
  "Don't see your provider? Add any TrailStep-compatible provider manifest/package with trailstep providers add <path-or-package>.";
const PROVIDER_CHOICES = [
  ...OFFICIAL_PROVIDER_PACKAGES.map((provider) => provider.packageName),
  ...OFFICIAL_PROVIDER_IDS.filter((id) => id !== "pi"),
].sort();

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
    context.io.writeLine(OFFICIAL_PROVIDER_ADD_GUIDANCE);
    let nextConfig = await runAgentSetupWithOfficialProviderRegistration({
      config,
      agentName: "default",
      context,
    });

    while (await shouldConfigureAnotherAgent(context)) {
      const name = await promptText(
        "Agent name",
        undefined,
        context.prompts,
        "trailstep init requires an agent name.",
      );
      nextConfig = await runAgentSetupWithOfficialProviderRegistration({
        config: nextConfig,
        agentName: name,
        context,
      });
    }

    await writeRawTrailStepConfigFile(configPath, nextConfig);
    context.io.writeLine(`Wrote TrailStep agent config to ${configPath}.`);

    if (args.skillInstallMode !== "skip") {
      const skillMarker = await createPackagedTrailStepSkillInstallationMarker(
        trailStepSkillInstallTargetForScope(scope),
      );
      if (await hasTrackedTrailStepSkillInstallation(scope, context, skillMarker)) {
        context.io.writeLine("TrailStep usage skill is already installed.");
      } else if (await shouldInstallSkill(args.skillInstallMode, context)) {
        await installTrailStepSkillOrThrow(scope, context);
        await markTrailStepSkillInstalled(scope, context, skillMarker);
        context.io.writeLine("Installed TrailStep usage skill.");
      }
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

async function hasTrackedTrailStepSkillInstallation(
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
  expectedMarker: TrailStepSkillInstallationMarker,
): Promise<boolean> {
  for (const configScope of skillInstallationMarkerScopesForScope(scope)) {
    const config = await readRawTrailStepConfigFile(configPathForScope(configScope, context));
    const markerForConfigScope = {
      ...expectedMarker,
      target: trailStepSkillInstallTargetForScope(configScope),
    };
    if (hasCurrentTrailStepSkillInstallationMarker(config, markerForConfigScope)) {
      return true;
    }
  }

  return false;
}

function skillInstallationMarkerScopesForScope(
  scope: WorkflowRegistryScope,
): readonly WorkflowRegistryScope[] {
  return scope === "global" ? ["global"] : ["local", "project", "global"];
}

async function markTrailStepSkillInstalled(
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
  marker: TrailStepSkillInstallationMarker,
): Promise<void> {
  const configPath = configPathForScope(scope, context);
  const config = await readRawTrailStepConfigFile(configPath);
  await writeRawTrailStepConfigFile(
    configPath,
    setTrailStepSkillInstallationMarker(config, marker),
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

async function runAgentSetupWithOfficialProviderRegistration(options: {
  readonly config: Record<string, unknown>;
  readonly agentName: string;
  readonly context: CliCommandContext;
}): Promise<Record<string, unknown>> {
  const basePrompts = options.context.prompts;
  if (basePrompts === undefined) {
    throw new CliUsageError("trailstep init requires prompts to configure an agent target.");
  }

  let selectedProvider: string | undefined;
  const prompts = wrapPromptsWithProviderCapture(basePrompts, (selection) => {
    selectedProvider = selection;
  });
  const nextConfig = await runAgentSetupWizard({
    config: options.config,
    agentName: options.agentName,
    prompts,
    providerChoices: PROVIDER_CHOICES,
    cwd: options.context.cwd,
    io: options.context.io,
    packageCommandRunner: options.context.packageCommandRunner,
  });
  return selectedProvider !== undefined && isOfficialProviderPackageName(selectedProvider)
    ? await registerOfficialProviderPackage(nextConfig, selectedProvider, options.context)
    : nextConfig;
}

function wrapPromptsWithProviderCapture(
  prompts: TrailStepCliPrompts,
  onProviderSelected: (selection: string) => void,
): TrailStepCliPrompts {
  return {
    ...prompts,
    async select(label, choices) {
      const selection = await prompts.select(label, choices);
      if (label === "Provider") {
        onProviderSelected(selection);
      }
      return selection;
    },
  };
}

async function registerOfficialProviderPackage(
  config: Record<string, unknown>,
  packageName: string,
  context: CliCommandContext,
): Promise<Record<string, unknown>> {
  const packageManager = await detectPackageManager({ cwd: context.cwd });
  const command = createPackageAddCommand({
    packageManager: packageManager.name,
    saveType: "dependencies",
    packageSpec: packageName,
    workspaceRoot:
      packageManager.name === "pnpm" ? await isPnpmWorkspaceRoot({ cwd: context.cwd }) : false,
  });
  const runner = context.packageCommandRunner ?? defaultPackageCommandRunner;
  const result = await runner({ command: command.command, args: command.args, cwd: context.cwd });
  if (result.exitCode !== 0) {
    throw new CliUsageError(
      `Package install failed for ${packageName} with exit code ${result.exitCode}.${result.stderr ? `\n${result.stderr}` : ""}`,
    );
  }

  const provider = await loadProviderPackage(
    join(context.cwd, "node_modules", ...packageName.split("/")),
  );
  const providers = toMutableRecord(config.providers);
  providers[provider.manifest.id] = {
    source: {
      type: "npm",
      packageName,
      spec: packageName,
      ...(provider.version === undefined ? {} : { resolvedVersion: provider.version }),
    },
    manifest: provider.manifest,
  };
  return { ...config, providers };
}

function toMutableRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
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
