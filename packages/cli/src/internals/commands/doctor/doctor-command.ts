import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { type CliCommand, type CliCommandContext, CliUsageError } from "../../command.types.js";
import { formatDeprecationFinding } from "../../deprecation-scan/deprecation-formatter.js";
import {
  type DeprecationFinding,
  scanWorkflowSourceForDeprecations,
} from "../../deprecation-scan/deprecation-scanner.js";
import { resolveInstalledTrailStepVersions } from "../../deprecation-scan/resolve-installed-trailstep-versions.js";
import { resolveDeprecationScanTargets } from "../../deprecation-scan/scan-targets.js";
import { workflowPackageInstallRootForMetadata } from "../../workflow-packages/install-root.js";
import {
  configPathForScope,
  listRegisteredWorkflowEntries,
  readRawTrailStepConfigFile,
  type WorkflowPackageRegistryMetadata,
  type WorkflowRegistryScope,
} from "../../workflow-registry/workflow-registry.js";

interface DoctorCommandArgs {
  readonly includeDiscovered: boolean;
}

interface RecommendedConfigPlan {
  readonly packageName: string;
  readonly agents: Record<string, unknown>;
  readonly workflows: Record<string, unknown>;
}

export const doctorCommand: CliCommand<DoctorCommandArgs> = {
  name: "doctor",
  parseArgs(argv) {
    if (argv[0] !== "doctor") {
      throw new CliUsageError("Expected doctor command.");
    }
    if (argv.length > 1) {
      throw new CliUsageError(`Unknown option: ${argv[1] ?? ""}`);
    }
    return { includeDiscovered: true };
  },
  async run(args, context) {
    const versionsByPackageName = await resolveInstalledTrailStepVersions({ cwd: context.cwd });
    const targets = await resolveDeprecationScanTargets({
      cwd: context.cwd,
      homeDir: context.homeDir,
      includeDiscovered: args.includeDiscovered,
    });
    const findings: DeprecationFinding[] = [];

    for (const target of targets) {
      try {
        findings.push(
          ...(await scanWorkflowSourceForDeprecations({
            sourceFile: target.sourceFile,
            versionsByPackageName,
            manifest: context.deprecationManifest,
          })),
        );
      } catch {
        // Doctor is advisory: unreadable scan targets are skipped until scanner coverage expands.
      }
    }

    const recommendedConfigWarnings = await findRecommendedConfigWarnings(context);

    for (const finding of findings) {
      context.io.writeLine(formatDeprecationFinding(finding));
    }
    for (const warning of recommendedConfigWarnings) {
      context.io.writeLine(warning);
    }

    if (findings.length === 0 && recommendedConfigWarnings.length === 0) {
      context.io.writeLine("No TrailStep deprecation findings.");
      return 0;
    }

    if (findings.some((finding) => finding.severity === "blocking")) {
      context.io.writeError("Doctor found blocking deprecation findings.");
      return 2;
    }

    if (recommendedConfigWarnings.length > 0 && findings.length === 0) {
      context.io.writeError("Doctor found recommended config warnings.");
      return 1;
    }

    context.io.writeError("Doctor found deprecation warnings.");
    return 1;
  },
};

async function findRecommendedConfigWarnings(
  context: CliCommandContext,
): Promise<readonly string[]> {
  const warnings: string[] = [];
  const seenPackages = new Set<string>();

  for (const entry of await listRegisteredWorkflowEntries(context)) {
    const metadata = entry.packageMetadata;
    if (metadata === undefined) {
      continue;
    }

    const key = `${metadata.installScope}:${metadata.packageName}`;
    if (seenPackages.has(key)) {
      continue;
    }
    seenPackages.add(key);

    const plan = await readInstalledPackageRecommendedConfig(metadata, context);
    if (plan === undefined) {
      continue;
    }

    const config = await readRawTrailStepConfigFile(
      configPathForScope(metadata.installScope, context),
    );
    warnings.push(...diffRecommendedConfig(metadata.installScope, config, plan));
  }

  return warnings;
}

async function readInstalledPackageRecommendedConfig(
  metadata: WorkflowPackageRegistryMetadata,
  context: CliCommandContext,
): Promise<RecommendedConfigPlan | undefined> {
  const packageJsonPath = join(
    workflowPackageInstallRootForMetadata(metadata, context),
    "node_modules",
    ...metadata.packageName.split("/"),
    "package.json",
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  if (!isRecord(parsed) || !isRecord(parsed.trailstep)) {
    return undefined;
  }
  const recommendedConfig = parsed.trailstep.recommendedConfig;
  if (!isRecord(recommendedConfig)) {
    return undefined;
  }

  const agents = isRecord(recommendedConfig.agents) ? recommendedConfig.agents : {};
  const workflows = isRecord(recommendedConfig.workflows) ? recommendedConfig.workflows : {};
  if (Object.keys(agents).length === 0 && Object.keys(workflows).length === 0) {
    return undefined;
  }

  const packageName =
    typeof parsed.name === "string" && parsed.name.trim().length > 0
      ? parsed.name
      : metadata.packageName;
  return { packageName, agents, workflows };
}

function diffRecommendedConfig(
  scope: WorkflowRegistryScope,
  config: Record<string, unknown>,
  plan: RecommendedConfigPlan,
): readonly string[] {
  const warnings: string[] = [];
  const agents = toMutableRecord(config.agents);
  const workflows = toMutableRecord(config.workflows);

  for (const [agentName, recommendedAgent] of Object.entries(plan.agents)) {
    const actualAgent = agents[agentName];
    if (actualAgent === undefined) {
      warnings.push(
        `Recommended config warning: ${plan.packageName} agents.${agentName} is missing in ${scope} config.`,
      );
    } else if (!jsonEqual(actualAgent, recommendedAgent)) {
      warnings.push(
        `Recommended config warning: ${plan.packageName} agents.${agentName} differs from the package recommendation in ${scope} config.`,
      );
    }
  }

  for (const [workflowId, recommendedWorkflow] of Object.entries(plan.workflows)) {
    if (!isRecord(recommendedWorkflow)) {
      continue;
    }
    const recommendedAgents = isRecord(recommendedWorkflow.agents)
      ? recommendedWorkflow.agents
      : {};
    const workflowConfig = toMutableRecord(workflows[workflowId]);
    const workflowAgents = toMutableRecord(workflowConfig.agents);
    for (const [roleName, recommendedRoleTargets] of Object.entries(recommendedAgents)) {
      const actualRoleTargets = workflowAgents[roleName];
      if (actualRoleTargets === undefined) {
        warnings.push(
          `Recommended config warning: ${plan.packageName} workflows.${workflowId}.agents.${roleName} is missing in ${scope} config.`,
        );
      } else if (!jsonEqual(actualRoleTargets, recommendedRoleTargets)) {
        warnings.push(
          `Recommended config warning: ${plan.packageName} workflows.${workflowId}.agents.${roleName} differs from the package recommendation in ${scope} config.`,
        );
      }
    }
  }

  return warnings;
}

function toMutableRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isNodeError(error: unknown): error is { readonly code: string } {
  return isRecord(error) && typeof error.code === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
