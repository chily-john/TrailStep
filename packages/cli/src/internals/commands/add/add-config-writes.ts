import { join, resolve } from "node:path";

import type { ConfiguredCustomProvider } from "../../agent-config/configure-target-flow.js";
import type { CliCommandContext } from "../../command-framework/command.types.js";
import {
  mergeRecommendedConfig,
  type RecommendedConfigPlan,
  readRecommendedConfigPlanFromPackageJsonFile,
} from "../../recommended-config/recommended-config.js";
import {
  configPathForScope,
  readRawTrailStepConfigFile,
  type WorkflowRegistryScope,
  writeRawTrailStepConfigFile,
} from "../../workflow-registry/workflow-registry.js";
import { isDirectWorkflowFileReference } from "../../workflow-resolution/workflow-resolution.js";

import type { PreparedAddSource } from "./add-command.types.js";
import { toMutableRecord } from "./record-utils.js";

export async function applyRecommendedConfigForPreparedSource(
  preparedSource: Extract<PreparedAddSource, { readonly status: "ready" }>,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<void> {
  const plan = await buildRecommendedConfigPlanForPreparedSource(preparedSource, scope, context);
  if (plan === undefined) {
    return;
  }

  const configPath = configPathForScope(scope, context);
  const config = await readRawTrailStepConfigFile(configPath);
  const merge = mergeRecommendedConfig(config, plan);
  if (merge.addedAgents.length === 0 && merge.addedWorkflowRoles.length === 0) {
    context.io.writeLine(`Recommended config from ${plan.packageName}: nothing to add.`);
  } else {
    await writeRawTrailStepConfigFile(configPath, merge.config);
    context.io.writeLine(
      `Applied recommended config from ${plan.packageName}: added ${merge.addedAgents.length} agent(s), ${merge.addedWorkflowRoles.length} workflow role mapping(s).`,
    );
  }
  for (const conflict of merge.conflicts) {
    context.io.writeError(`Recommended config conflict: ${conflict}`);
  }
}

export async function reportDryRunRecommendedConfigPlan(
  plan: RecommendedConfigPlan | undefined,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<void> {
  if (plan === undefined) {
    return;
  }

  const configPath = configPathForScope(scope, context);
  const config = await readRawTrailStepConfigFile(configPath);
  const merge = mergeRecommendedConfig(config, plan);
  context.io.writeLine(
    `Would apply recommended config from ${plan.packageName}: add ${merge.addedAgents.length} agent(s), ${merge.addedWorkflowRoles.length} workflow role mapping(s), ${merge.conflicts.length} conflict(s).`,
  );
  for (const conflict of merge.conflicts) {
    context.io.writeLine(`Would report recommended config conflict: ${conflict}`);
  }
}

export async function buildRecommendedConfigPlanForPreparedSource(
  preparedSource: Extract<PreparedAddSource, { readonly status: "ready" }>,
  _scope: WorkflowRegistryScope,
  _context: CliCommandContext,
): Promise<RecommendedConfigPlan | undefined> {
  const packageJsonPath = packageJsonPathForPreparedSource(preparedSource);
  if (packageJsonPath === undefined) {
    return undefined;
  }
  return readRecommendedConfigPlanFromPackageJsonFile(packageJsonPath, preparedSource.source);
}

function packageJsonPathForPreparedSource(
  preparedSource: Extract<PreparedAddSource, { readonly status: "ready" }>,
): string | undefined {
  if (preparedSource.installedPackage !== undefined) {
    return join(
      preparedSource.installedPackage.installRoot,
      "node_modules",
      ...preparedSource.installedPackage.packageName.split("/"),
      "package.json",
    );
  }
  if (isDirectWorkflowFileReference(preparedSource.source)) {
    // Local file and directory sources resolve relative to the source path.
    // Plain workflow files have no package.json there (ENOENT/ENOTDIR means no plan);
    // local directory packages resolve to their manifest.
    return resolve(preparedSource.cwd, preparedSource.source, "package.json");
  }
  return resolve(
    preparedSource.cwd,
    "node_modules",
    ...preparedSource.source.split("/"),
    "package.json",
  );
}

export async function writeNamedAgent(
  scope: WorkflowRegistryScope,
  name: string,
  entry: readonly Record<string, unknown>[],
  context: CliCommandContext,
  customProvider?: ConfiguredCustomProvider,
): Promise<void> {
  const configPath = configPathForScope(scope, context);
  const config = await readRawTrailStepConfigFile(configPath);
  const agents = toMutableRecord(config.agents);
  agents[name] = entry;
  if (customProvider === undefined) {
    await writeRawTrailStepConfigFile(configPath, { ...config, agents });
    return;
  }
  const customProviders = toMutableRecord(config.customProviders);
  customProviders[customProvider.name] = { ...customProvider.config };
  await writeRawTrailStepConfigFile(configPath, { ...config, customProviders, agents });
}

export async function writeWorkflowRoleMapping(
  scope: WorkflowRegistryScope,
  workflowId: string,
  roleName: string,
  entry: readonly Record<string, unknown>[],
  context: CliCommandContext,
): Promise<void> {
  const configPath = configPathForScope(scope, context);
  const config = await readRawTrailStepConfigFile(configPath);
  const workflows = toMutableRecord(config.workflows);
  const workflowConfig = toMutableRecord(workflows[workflowId]);
  const workflowAgents = toMutableRecord(workflowConfig.agents);
  workflowAgents[roleName] = entry;
  workflows[workflowId] = { ...workflowConfig, agents: workflowAgents };
  await writeRawTrailStepConfigFile(configPath, { ...config, workflows });
}
