import { readFile } from "node:fs/promises";

/**
 * Shared `trailstep.recommendedConfig` handling: reading a package's recommendation
 * plan from its package.json and additively merging it into a raw TrailStep config.
 *
 * `add` and `update` both go through `mergeRecommendedConfig` so their merge semantics
 * stay identical: only missing agents and missing workflow role mappings are added,
 * existing values are never overwritten, and differing values are reported as
 * conflicts for the caller to surface as warnings.
 */
export interface RecommendedConfigPlan {
  readonly packageName: string;
  readonly agents: Record<string, unknown>;
  readonly workflows: Record<string, unknown>;
}

export interface RecommendedConfigMerge {
  readonly config: Record<string, unknown>;
  readonly addedAgents: readonly string[];
  readonly addedWorkflowRoles: readonly string[];
  readonly conflicts: readonly string[];
}

export async function readRecommendedConfigPlanFromPackageJsonFile(
  packageJsonPath: string,
  fallbackPackageName: string,
): Promise<RecommendedConfigPlan | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return undefined;
    }
    throw error;
  }
  return recommendedConfigPlanFromPackageJson(parsed, fallbackPackageName);
}

export function recommendedConfigPlanFromPackageJson(
  parsed: unknown,
  fallbackPackageName: string,
): RecommendedConfigPlan | undefined {
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
      : fallbackPackageName;
  return { packageName, agents, workflows };
}

export function mergeRecommendedConfig(
  config: Record<string, unknown>,
  plan: RecommendedConfigPlan,
): RecommendedConfigMerge {
  const agents = toMutableRecord(config.agents);
  const workflows = toMutableRecord(config.workflows);
  const addedAgents: string[] = [];
  const addedWorkflowRoles: string[] = [];
  const conflicts: string[] = [];

  for (const [agentName, recommendedAgent] of Object.entries(plan.agents)) {
    const existingAgent = agents[agentName];
    if (existingAgent === undefined) {
      agents[agentName] = recommendedAgent;
      addedAgents.push(agentName);
      continue;
    }
    if (!jsonEqual(existingAgent, recommendedAgent)) {
      conflicts.push(
        `${plan.packageName} agents.${agentName} already exists; leaving existing value unchanged.`,
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
    if (Object.keys(recommendedAgents).length === 0) {
      continue;
    }
    const workflowConfig = toMutableRecord(workflows[workflowId]);
    const workflowAgents = toMutableRecord(workflowConfig.agents);
    for (const [roleName, recommendedRoleTargets] of Object.entries(recommendedAgents)) {
      const existingRoleTargets = workflowAgents[roleName];
      if (existingRoleTargets === undefined) {
        workflowAgents[roleName] = recommendedRoleTargets;
        addedWorkflowRoles.push(`${workflowId}.${roleName}`);
        continue;
      }
      if (!jsonEqual(existingRoleTargets, recommendedRoleTargets)) {
        conflicts.push(
          `${plan.packageName} workflows.${workflowId}.agents.${roleName} already exists; leaving existing value unchanged.`,
        );
      }
    }
    workflows[workflowId] = { ...workflowConfig, agents: workflowAgents };
  }

  const nextConfig: Record<string, unknown> = { ...config };
  if (Object.keys(agents).length > 0) {
    nextConfig.agents = agents;
  }
  if (Object.keys(workflows).length > 0) {
    nextConfig.workflows = workflows;
  }

  return { config: nextConfig, addedAgents, addedWorkflowRoles, conflicts };
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
