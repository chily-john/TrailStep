import { resolveAgentTargets, type TrailStepConfig, type WorkflowAgentRole } from "@trailstep/core";
import { isAgentTargetsUnavailableError } from "../../agent-config/agent-targets-error.js";
import { configureLiteralAgentTarget } from "../../agent-config/configure-target-flow.js";
import type { CliCommandContext } from "../../command-framework/command.types.js";
import { CliUsageError } from "../../command-framework/command.types.js";
import { loadTrailStepProjectConfig } from "../../config/config.js";
import { OFFICIAL_PROVIDER_IDS } from "../../providers/official-providers.js";
import {
  configPathForScope,
  readRawTrailStepConfigFile,
  type WorkflowRegistryScope,
} from "../../workflow-registry/workflow-registry.js";

import type { AddRegistration } from "./add-command.types.js";
import { writeNamedAgent, writeWorkflowRoleMapping } from "./add-config-writes.js";
import { isRecord, toMutableRecord } from "./record-utils.js";

const PROVIDER_CHOICES = [...OFFICIAL_PROVIDER_IDS].sort();

interface PromptForUncoveredWorkflowRolesForRegistrationsOptions {
  readonly scope: WorkflowRegistryScope;
  readonly registrations: readonly AddRegistration[];
}

interface UncoveredWorkflowRoleGroup {
  readonly roleName: string;
  readonly role: WorkflowAgentRole;
  readonly workflowIds: Set<string>;
}

export async function promptForUncoveredWorkflowRolesForRegistrations(
  options: PromptForUncoveredWorkflowRolesForRegistrationsOptions,
  context: CliCommandContext,
): Promise<void> {
  if (options.registrations.length === 0) {
    return;
  }

  const loadedConfig = await loadTrailStepProjectConfig(context.cwd, { homeDir: context.homeDir });
  const effectiveConfig = loadedConfig.trailstepConfig;
  if (effectiveConfig === undefined) {
    return;
  }

  const roleGroups = collectUncoveredWorkflowRoleGroups(options.registrations, effectiveConfig);
  for (const roleName of Object.keys(roleGroups).sort()) {
    const group = roleGroups[roleName];
    if (group === undefined) {
      continue;
    }
    const workflowIds = [...group.workflowIds];
    const entry = await promptForWorkflowRoleMapping(
      {
        scope: options.scope,
        workflowId: workflowIds[0] ?? "",
        roleName: group.roleName,
        role: group.role,
      },
      context,
    );
    if (entry === undefined) {
      continue;
    }
    for (const workflowId of workflowIds) {
      await writeWorkflowRoleMapping(options.scope, workflowId, group.roleName, entry, context);
    }
  }
}

function collectUncoveredWorkflowRoleGroups(
  registrations: readonly AddRegistration[],
  effectiveConfig: TrailStepConfig,
): Record<string, UncoveredWorkflowRoleGroup> {
  const groups: Record<string, UncoveredWorkflowRoleGroup> = {};

  for (const registration of registrations) {
    const workflow = registration.registryTarget.workflow;
    const workflowAgents = workflow?.agents;
    if (
      workflow === undefined ||
      workflowAgents === undefined ||
      Object.keys(workflowAgents).length === 0
    ) {
      continue;
    }

    for (const roleName of Object.keys(workflowAgents).sort()) {
      const role = workflowAgents[roleName];
      if (role === undefined || !isWorkflowAgentRole(role)) {
        continue;
      }
      if (isRoleCoveredByEffectiveConfig(effectiveConfig, workflow.id, roleName, role)) {
        continue;
      }

      groups[roleName] = groups[roleName] ?? {
        roleName,
        role,
        workflowIds: new Set<string>(),
      };
      groups[roleName].workflowIds.add(workflow.id);
    }
  }

  return groups;
}

function isRoleCoveredByEffectiveConfig(
  config: TrailStepConfig,
  workflowId: string,
  roleName: string,
  role: WorkflowAgentRole,
): boolean {
  try {
    resolveAgentTargets({ config, workflowId, roleName, roleSize: role.size });
    return true;
  } catch (error) {
    if (isAgentTargetsUnavailableError(error)) {
      return false;
    }
    throw error;
  }
}

function isWorkflowAgentRole(value: unknown): value is WorkflowAgentRole {
  return isRecord(value) && typeof value.size === "string";
}

interface PromptForWorkflowRoleMappingOptions {
  readonly scope: WorkflowRegistryScope;
  readonly workflowId: string;
  readonly roleName: string;
  readonly role: WorkflowAgentRole;
}

async function promptForWorkflowRoleMapping(
  options: PromptForWorkflowRoleMappingOptions,
  context: CliCommandContext,
): Promise<readonly Record<string, unknown>[] | undefined> {
  if (context.prompts === undefined) {
    throw new CliUsageError(
      `Workflow ${options.workflowId} role ${options.roleName} has no configured agent targets; run interactively or configure agents first.`,
    );
  }

  const action = await context.prompts.select(workflowRolePrompt(options), [
    "Use named agent",
    "Create new agent",
    "Skip",
  ]);
  if (action === "Skip") {
    return undefined;
  }
  if (action === "Use named agent") {
    const namedAgent = await context.prompts.select(
      `Named agent for workflow role ${options.roleName}`,
      await listNamedAgentChoices(context),
    );
    return [{ ref: namedAgent }];
  }

  const name = (
    await context.prompts.text(`New agent name for workflow role ${options.roleName}`)
  ).trim();
  if (name.length === 0) {
    throw new CliUsageError("New agent name is required.");
  }
  const configured = await configureLiteralAgentTarget({
    prompts: context.prompts,
    providerChoices: PROVIDER_CHOICES,
    cwd: context.cwd,
    io: context.io,
    packageCommandRunner: context.packageCommandRunner,
  });
  await writeNamedAgent(
    options.scope,
    name,
    [{ ...configured.target }],
    context,
    configured.customProvider,
  );
  return [{ ref: name }];
}

function workflowRolePrompt(options: PromptForWorkflowRoleMappingOptions): string {
  return [
    `Configure workflow role ${options.roleName} (${options.role.size})`,
    options.role.description === undefined ? undefined : `— ${options.role.description}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
}

async function listNamedAgentChoices(context: CliCommandContext): Promise<readonly string[]> {
  const names = new Set<string>();
  for (const scope of ["local", "project", "global"] as const) {
    const config = await readRawTrailStepConfigFile(configPathForScope(scope, context));
    for (const name of Object.keys(toMutableRecord(config.agents))) {
      names.add(name);
    }
  }
  return [...names].sort();
}
