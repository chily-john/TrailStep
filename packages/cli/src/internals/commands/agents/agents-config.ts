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
  type WorkflowRegistryScope,
  writeRawTrailStepConfigFile,
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
  const config = await readRawTrailStepConfigFile(configPath);
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
  await writeRawTrailStepConfigFile(configPath, { ...config, agents });
  context.io.writeLine(`Wrote agent ${args.name} to ${configPath}.`);
  return 0;
}

export async function deleteAgent(
  args: Extract<AgentCommandArgs, { readonly action: "delete" }>,
  context: CliCommandContext,
): Promise<number> {
  await blockDeleteWhenAgentReferrersExist(args.name, context);

  const configPath = configPathForScope(args.scope, context);
  const config = await readRawTrailStepConfigFile(configPath);
  const agents = toMutableRecord(config.agents);
  delete agents[args.name];
  await writeRawTrailStepConfigFile(configPath, { ...config, agents });
  context.io.writeLine(`Deleted agent ${args.name} from ${configPath}.`);
  return 0;
}

export async function renameAgent(
  args: Extract<AgentCommandArgs, { readonly action: "rename" }>,
  context: CliCommandContext,
): Promise<number> {
  const configPath = configPathForScope(args.scope, context);
  const config = await readRawTrailStepConfigFile(configPath);
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
  await writeRawTrailStepConfigFile(configPath, { ...config, agents: renamedAgents });
  await renameAgentRefs(args.oldName, args.newName, context);
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
  const config = await readRawTrailStepConfigFile(configPath);
  const agents = toMutableRecord(config.agents);
  agents[name] = entry;
  await writeRawTrailStepConfigFile(
    configPath,
    withConfiguredCustomProviders({ ...config, agents }, customProviders),
  );
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
  const config = await readRawTrailStepConfigFile(configPath);
  const workflows = toMutableRecord(config.workflows);
  const workflowConfig = toMutableRecord(workflows[row.workflowId]);
  const workflowAgents = toMutableRecord(workflowConfig.agents);
  workflowAgents[row.roleName] = entry;
  workflows[row.workflowId] = { ...workflowConfig, agents: workflowAgents };
  await writeRawTrailStepConfigFile(
    configPath,
    withConfiguredCustomProviders({ ...config, workflows }, customProviders),
  );
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

export async function listNamedAgentChoices(
  context: CliCommandContext,
): Promise<readonly string[]> {
  const names = new Set<string>(RESERVED_AGENT_NAMES);
  for (const scope of ["local", "project", "global"] as const) {
    const config = await readRawTrailStepConfigFile(configPathForScope(scope, context));
    for (const name of Object.keys(toMutableRecord(config.agents))) {
      names.add(name);
    }
  }
  return [...names].sort((left, right) => {
    const leftReserved = RESERVED_AGENT_NAMES.includes(
      left as (typeof RESERVED_AGENT_NAMES)[number],
    );
    const rightReserved = RESERVED_AGENT_NAMES.includes(
      right as (typeof RESERVED_AGENT_NAMES)[number],
    );
    if (leftReserved && rightReserved) {
      return (
        RESERVED_AGENT_NAMES.indexOf(left as (typeof RESERVED_AGENT_NAMES)[number]) -
        RESERVED_AGENT_NAMES.indexOf(right as (typeof RESERVED_AGENT_NAMES)[number])
      );
    }
    if (leftReserved) return 1;
    if (rightReserved) return -1;
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
