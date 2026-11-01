import { readAgentEntryItems } from "../../agent-config/agent-entry-items-flow.js";
import {
  blockDeleteWhenAgentReferrersExist,
  renameAgentRefs,
} from "../../agent-config/agent-referrers.js";
import type { ConfiguredCustomProvider } from "../../agent-config/configure-target-flow.js";
import type { CliCommandContext } from "../../command-framework/command.types.js";
import { CliUsageError } from "../../command-framework/command.types.js";
import {
  configPathForScope,
  readRawTrailStepConfigFile,
  updateRawTrailStepConfigFile,
  type WorkflowRegistryScope,
} from "../../workflow-registry/workflow-registry.js";

import type {
  AgentCommandArgs,
  AgentEntryItems,
  InteractiveWorkflowRoleRow,
} from "./agents-command.types.js";
import { toMutableRecord } from "./record-utils.js";

export const RESERVED_AGENT_NAMES = ["default", "tiny", "small", "medium", "large", "xl"] as const;

export async function setAgent(
  args: Extract<AgentCommandArgs, { readonly action: "set" }>,
  context: CliCommandContext,
): Promise<number> {
  const configPath = configPathForScope(args.scope, context);
  await updateRawTrailStepConfigFile(configPath, (config) => {
    const agents = toMutableRecord(config.agents);
    agents[args.name] = [
      {
        provider: args.provider,
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.thinking === undefined || args.thinking === "none"
          ? {}
          : { thinking: args.thinking }),
      },
    ];
    return { ...config, agents };
  });
  context.io.writeLine(`Wrote agent ${args.name} to ${configPath}.`);
  return 0;
}

export async function deleteAgent(
  args: Extract<AgentCommandArgs, { readonly action: "delete" }>,
  context: CliCommandContext,
): Promise<number> {
  await blockDeleteWhenAgentReferrersExist(args.name, context);

  const configPath = configPathForScope(args.scope, context);
  await updateRawTrailStepConfigFile(configPath, (config) => {
    const agents = toMutableRecord(config.agents);
    delete agents[args.name];
    return { ...config, agents };
  });
  context.io.writeLine(`Deleted agent ${args.name} from ${configPath}.`);
  return 0;
}

export async function renameAgent(
  args: Extract<AgentCommandArgs, { readonly action: "rename" }>,
  context: CliCommandContext,
): Promise<number> {
  const configPath = configPathForScope(args.scope, context);
  const existing = await readRawTrailStepConfigFile(configPath);
  const existingAgents = toMutableRecord(existing.agents);
  if (!(args.oldName in existingAgents)) {
    throw new CliUsageError(`Agent ${args.oldName} does not exist in ${args.scope} config.`);
  }
  if (args.newName in existingAgents) {
    throw new CliUsageError(`Agent ${args.newName} already exists in ${args.scope} config.`);
  }

  // Rename references FIRST. If a reference cannot be updated, the agent is still addressable
  // under its old name because the config was never touched. Doing this after the config write
  // left the config pointing at a name that no longer resolved (and this order relies on
  // `renameAgentRefs` being idempotent, which it is: it only rewrites `ref` values equal to
  // oldName).
  await renameAgentRefs(args.oldName, args.newName, context);

  // Re-read inside the update: `renameAgentRefs` may have rewritten refs in THIS file, and
  // applying the pre-refs snapshot would revert them.
  await updateRawTrailStepConfigFile(configPath, (config) => {
    const agents = toMutableRecord(config.agents);
    if (!(args.oldName in agents)) {
      throw new CliUsageError(`Agent ${args.oldName} does not exist in ${args.scope} config.`);
    }
    if (args.newName in agents) {
      throw new CliUsageError(`Agent ${args.newName} already exists in ${args.scope} config.`);
    }
    const renamedAgents = { ...agents };
    const entry = renamedAgents[args.oldName];
    delete renamedAgents[args.oldName];
    renamedAgents[args.newName] = entry;
    return { ...config, agents: renamedAgents };
  });
  context.io.writeLine(`Renamed agent ${args.oldName} to ${args.newName}.`);
  return 0;
}

export async function writeNamedAgent(
  scope: WorkflowRegistryScope,
  name: string,
  entry: AgentEntryItems,
  context: CliCommandContext,
  customProviders?: ConfiguredCustomProvider | readonly ConfiguredCustomProvider[],
): Promise<void> {
  const configPath = configPathForScope(scope, context);
  await updateRawTrailStepConfigFile(configPath, (config) => {
    const agents = toMutableRecord(config.agents);
    agents[name] = entry;
    return withConfiguredCustomProviders({ ...config, agents }, customProviders);
  });
  context.io.writeLine(`Wrote agent ${name} to ${configPath}.`);
}

export async function writeWorkflowRole(
  scope: WorkflowRegistryScope,
  row: InteractiveWorkflowRoleRow,
  entry: AgentEntryItems,
  context: CliCommandContext,
  customProviders?: ConfiguredCustomProvider | readonly ConfiguredCustomProvider[],
): Promise<void> {
  const configPath = configPathForScope(scope, context);
  await updateRawTrailStepConfigFile(configPath, (config) => {
    const workflows = toMutableRecord(config.workflows);
    const workflowConfig = toMutableRecord(workflows[row.workflowId]);
    const workflowAgents = toMutableRecord(workflowConfig.agents);
    workflowAgents[row.roleName] = entry;
    workflows[row.workflowId] = { ...workflowConfig, agents: workflowAgents };
    return withConfiguredCustomProviders({ ...config, workflows }, customProviders);
  });
  context.io.writeLine(`Wrote workflow ${row.workflowId} role ${row.roleName} to ${configPath}.`);
}

export function customProviderList(
  customProvider: ConfiguredCustomProvider | undefined,
): readonly ConfiguredCustomProvider[] {
  return customProvider === undefined ? [] : [customProvider];
}

export function withConfiguredCustomProviders(
  config: Record<string, unknown>,
  customProvidersInput: ConfiguredCustomProvider | readonly ConfiguredCustomProvider[] | undefined,
): Record<string, unknown> {
  const providers: readonly ConfiguredCustomProvider[] =
    customProvidersInput === undefined
      ? []
      : Array.isArray(customProvidersInput)
        ? customProvidersInput
        : [customProvidersInput];
  if (providers.length === 0) {
    return config;
  }

  const customProviders = toMutableRecord(config.customProviders);
  for (const customProvider of providers) {
    customProviders[customProvider.name] = { ...customProvider.config };
  }
  return { ...config, customProviders };
}

export async function findNamedAgentScope(
  name: string,
  context: CliCommandContext,
): Promise<WorkflowRegistryScope> {
  for (const scope of ["local", "project", "global"] as const) {
    const config = await readRawTrailStepConfigFile(configPathForScope(scope, context));
    if (name in toMutableRecord(config.agents)) {
      return scope;
    }
  }
  throw new CliUsageError(`Agent ${name} does not exist in any config scope.`);
}

type ReservedAgentName = (typeof RESERVED_AGENT_NAMES)[number];

export async function listNamedAgentChoices(
  context: CliCommandContext,
): Promise<readonly string[]> {
  const configured = new Set<string>();
  for (const scope of ["local", "project", "global"] as const) {
    const config = await readRawTrailStepConfigFile(configPathForScope(scope, context));
    for (const name of Object.keys(toMutableRecord(config.agents))) {
      configured.add(name);
    }
  }

  // A reserved size name is only a real choice when some scope actually configures it;
  // offering `tiny`/`xl` unconditionally led the picker into "does not exist in any config
  // scope". Reserved names that ARE configured still sort first so the built-ins stay familiar.
  const names = [...configured];
  return names.sort((left, right) => {
    const leftReserved = RESERVED_AGENT_NAMES.includes(left as ReservedAgentName);
    const rightReserved = RESERVED_AGENT_NAMES.includes(right as ReservedAgentName);
    if (leftReserved && rightReserved) {
      return (
        RESERVED_AGENT_NAMES.indexOf(left as ReservedAgentName) -
        RESERVED_AGENT_NAMES.indexOf(right as ReservedAgentName)
      );
    }
    if (leftReserved) return -1;
    if (rightReserved) return 1;
    return left.localeCompare(right);
  });
}

export async function readNamedAgentEntry(
  scope: WorkflowRegistryScope,
  name: string,
  context: CliCommandContext,
): Promise<AgentEntryItems> {
  const config = await readRawTrailStepConfigFile(configPathForScope(scope, context));
  return readAgentEntryItems(toMutableRecord(config.agents)[name]);
}

export async function readWorkflowRoleEntry(
  scope: WorkflowRegistryScope,
  row: InteractiveWorkflowRoleRow,
  context: CliCommandContext,
): Promise<AgentEntryItems> {
  const config = await readRawTrailStepConfigFile(configPathForScope(scope, context));
  const workflowConfig = toMutableRecord(toMutableRecord(config.workflows)[row.workflowId]);
  const workflowAgents = toMutableRecord(workflowConfig.agents);
  return readAgentEntryItems(workflowAgents[row.roleName]);
}
