import { CliUsageError } from "../command.types.js";
import {
  configPathForScope,
  readRawTrailStepConfigFile,
  type WorkflowRegistryContext,
  type WorkflowRegistryScope,
  writeRawTrailStepConfigFile,
} from "../workflow-registry/workflow-registry.js";

const SCOPES: readonly WorkflowRegistryScope[] = ["local", "project", "global"];

export interface AgentReferrer {
  readonly scope: WorkflowRegistryScope;
  readonly path: string;
}

export async function findAgentReferrers(
  ref: string,
  context: WorkflowRegistryContext,
): Promise<readonly AgentReferrer[]> {
  const referrers: AgentReferrer[] = [];

  for (const scope of SCOPES) {
    const config = await readRawTrailStepConfigFile(configPathForScope(scope, context));
    collectAgentReferrers(config.agents, `agents`, ref, scope, referrers);
    collectWorkflowRoleReferrers(config.workflows, `workflows`, ref, scope, referrers);
  }

  return referrers;
}

export async function blockDeleteWhenAgentReferrersExist(
  ref: string,
  context: WorkflowRegistryContext,
): Promise<void> {
  const referrers = await findAgentReferrers(ref, context);
  if (referrers.length === 0) {
    return;
  }

  throw new CliUsageError(
    `Cannot delete agent ${ref} because it is referenced by ${referrers
      .map((referrer) => `${referrer.scope}: ${referrer.path}`)
      .join(", ")}.`,
  );
}

export async function renameAgentRefs(
  oldRef: string,
  newRef: string,
  context: WorkflowRegistryContext,
): Promise<void> {
  for (const scope of SCOPES) {
    const configPath = configPathForScope(scope, context);
    const config = await readRawTrailStepConfigFile(configPath);
    const renamed = renameRefsInValue(config, oldRef, newRef);
    if (renamed.changed) {
      await writeRawTrailStepConfigFile(configPath, renamed.value as Record<string, unknown>);
    }
  }
}

function collectAgentReferrers(
  value: unknown,
  path: string,
  ref: string,
  scope: WorkflowRegistryScope,
  referrers: AgentReferrer[],
): void {
  if (!isRecord(value)) {
    return;
  }

  for (const [agentName, entry] of Object.entries(value)) {
    collectAgentEntryReferrers(entry, `${path}.${agentName}`, ref, scope, referrers);
  }
}

function collectWorkflowRoleReferrers(
  value: unknown,
  path: string,
  ref: string,
  scope: WorkflowRegistryScope,
  referrers: AgentReferrer[],
): void {
  if (!isRecord(value)) {
    return;
  }

  for (const [workflowName, workflowConfig] of Object.entries(value)) {
    if (!isRecord(workflowConfig)) {
      continue;
    }
    for (const [roleName, roleConfig] of Object.entries(workflowConfig)) {
      collectAgentEntryReferrers(
        roleConfig,
        `${path}.${workflowName}.${roleName}`,
        ref,
        scope,
        referrers,
      );
    }
    collectAgentReferrers(
      workflowConfig.agents,
      `${path}.${workflowName}.agents`,
      ref,
      scope,
      referrers,
    );
  }
}

function collectAgentEntryReferrers(
  value: unknown,
  path: string,
  ref: string,
  scope: WorkflowRegistryScope,
  referrers: AgentReferrer[],
): void {
  if (!Array.isArray(value)) {
    return;
  }

  value.forEach((item, index) => {
    if (isRecord(item) && item.ref === ref) {
      referrers.push({ scope, path: `${path}[${index}]` });
    }
  });
}

function renameRefsInValue(
  value: unknown,
  oldRef: string,
  newRef: string,
): { readonly value: unknown; readonly changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const renamed = renameRefsInValue(item, oldRef, newRef);
      changed ||= renamed.changed;
      return renamed.value;
    });
    return { value: changed ? items : value, changed };
  }

  if (!isRecord(value)) {
    return { value, changed: false };
  }

  let changed = false;
  const renamed: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "ref" && child === oldRef) {
      renamed[key] = newRef;
      changed = true;
      continue;
    }
    const result = renameRefsInValue(child, oldRef, newRef);
    renamed[key] = result.value;
    changed ||= result.changed;
  }

  return { value: changed ? renamed : value, changed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
