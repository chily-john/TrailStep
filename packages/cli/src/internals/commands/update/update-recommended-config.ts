import { join } from "node:path";

import type { CliCommandContext } from "../../command-framework/command.types.js";
import {
  mergeRecommendedConfig,
  readRecommendedConfigPlanFromPackageJsonFile,
} from "../../recommended-config/recommended-config.js";
import { workflowPackageInstallRootForMetadata } from "../../workflow-packages/install-root.js";
import {
  configPathForScope,
  listRegisteredWorkflowEntries,
  readRawTrailStepConfigFile,
  writeRawTrailStepConfigFile,
} from "../../workflow-registry/workflow-registry.js";

export interface RecommendedConfigApplication {
  readonly packageName: string;
  readonly configPath: string;
  readonly addedAgents: readonly string[];
  readonly addedWorkflowRoles: readonly string[];
  readonly conflicts: readonly string[];
  readonly nextConfig: Record<string, unknown>;
}

/**
 * Additively re-applies each registered workflow package's `trailstep.recommendedConfig`
 * (same merge semantics as `add`: missing agents and missing workflow role mappings only,
 * never overwriting existing values). Conflicts are surfaced as warnings; `doctor` remains
 * the drift detector for anything left behind.
 */
export async function planRecommendedConfigApplications(
  context: CliCommandContext,
): Promise<readonly RecommendedConfigApplication[]> {
  const applications: RecommendedConfigApplication[] = [];
  const seenPackages = new Set<string>();
  const configByPath = new Map<string, Record<string, unknown>>();

  for (const entry of await listRegisteredWorkflowEntries(context)) {
    const metadata = entry.packageMetadata;
    if (metadata === undefined) {
      continue;
    }
    const packageKey = `${metadata.installScope}:${metadata.packageName}`;
    if (seenPackages.has(packageKey)) {
      continue;
    }
    seenPackages.add(packageKey);

    const packageJsonPath = join(
      workflowPackageInstallRootForMetadata(metadata, context),
      "node_modules",
      ...metadata.packageName.split("/"),
      "package.json",
    );
    const plan = await readRecommendedConfigPlanFromPackageJsonFile(
      packageJsonPath,
      metadata.packageName,
    );
    if (plan === undefined) {
      continue;
    }

    const configPath = configPathForScope(metadata.installScope, context);
    let config = configByPath.get(configPath);
    if (config === undefined) {
      config = await readRawTrailStepConfigFile(configPath);
      configByPath.set(configPath, config);
    }
    const merge = mergeRecommendedConfig(config, plan);
    configByPath.set(configPath, merge.config);
    applications.push({
      packageName: plan.packageName,
      configPath,
      addedAgents: merge.addedAgents,
      addedWorkflowRoles: merge.addedWorkflowRoles,
      conflicts: merge.conflicts,
      nextConfig: merge.config,
    });
  }

  return applications;
}

/**
 * Second, split consent for recommended config additions riding along with other
 * update changes. The blanket confirmUpdate() covers the rest of the update.
 */
export async function confirmRecommendedConfigAdditions(
  confirm: (prompt: string) => Promise<boolean>,
  applications: readonly RecommendedConfigApplication[],
): Promise<boolean> {
  const withAdditions = applications.filter(
    (application) =>
      application.addedAgents.length > 0 || application.addedWorkflowRoles.length > 0,
  );
  const agentCount = withAdditions.reduce(
    (total, application) => total + application.addedAgents.length,
    0,
  );
  const workflowRoleCount = withAdditions.reduce(
    (total, application) => total + application.addedWorkflowRoles.length,
    0,
  );
  return confirm(
    `Apply recommended config additions from ${recommendedConfigPackagesWithAdditions(
      applications,
    ).join(", ")} (${agentCount} agent(s), ${workflowRoleCount} workflow role mapping(s))?`,
  );
}

export function recommendedConfigPackagesWithAdditions(
  applications: readonly RecommendedConfigApplication[],
): readonly string[] {
  return applications
    .filter(
      (application) =>
        application.addedAgents.length > 0 || application.addedWorkflowRoles.length > 0,
    )
    .map((application) => application.packageName);
}

/** Writes the planned recommended config additions to their config files. */
export async function applyRecommendedConfigApplications(
  applications: readonly RecommendedConfigApplication[],
  context: CliCommandContext,
): Promise<void> {
  for (const application of applications) {
    if (application.addedAgents.length === 0 && application.addedWorkflowRoles.length === 0) {
      continue;
    }
    await writeRawTrailStepConfigFile(application.configPath, application.nextConfig);
    context.io.writeLine(
      `Applied recommended config from ${application.packageName}: added ${application.addedAgents.length} agent(s), ${application.addedWorkflowRoles.length} workflow role mapping(s).`,
    );
  }
}
