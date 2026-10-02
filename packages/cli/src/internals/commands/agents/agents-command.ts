import { resolveAgentTargets, type TrailStepConfig } from "@trailstep/core";

import {
  addAgentEntryItem,
  editAgentEntryItem,
  readAgentEntryItems,
  removeAgentEntryItem,
  reorderAgentEntryItem,
} from "../../agent-config/agent-entry-items-flow.js";
import {
  blockDeleteWhenAgentReferrersExist,
  findAgentReferrers,
  renameAgentRefs,
} from "../../agent-config/agent-referrers.js";
import {
  hasConfiguredAgentEntries,
  runAgentSetupWizard,
} from "../../agent-config/agent-setup-wizard.js";
import {
  type ConfiguredCustomProvider,
  configureLiteralAgentTarget,
} from "../../agent-config/configure-target-flow.js";
import {
  type AgentConfigSaveContext,
  confirmAgentConfigSave,
} from "../../agent-config/save-confirm-flow.js";
import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import { loadTrailStepProjectConfig } from "../../config/config.js";
import {
  configPathForScope,
  listRegisteredWorkflowEntries,
  readRawTrailStepConfigFile,
  type WorkflowRegistryScope,
  writeRawTrailStepConfigFile,
} from "../../workflow-registry/workflow-registry.js";
import {
  type ResolvedWorkflowReference,
  resolveWorkflowReference,
} from "../../workflow-resolution/workflow-resolution.js";
import { WorkflowResolutionError } from "../../workflow-resolution/workflow-resolution-error.js";

const THINKING_CHOICES = ["none", "low", "medium", "high", "xhigh", "max"] as const;

type AgentEntryItems = readonly Record<string, unknown>[];

interface AgentEntryEditResult {
  readonly entry: AgentEntryItems;
  readonly customProviders: readonly ConfiguredCustomProvider[];
}

type AgentCommandArgs =
  | {
      readonly action: "set";
      readonly name: string;
      readonly provider: string;
      readonly model?: string;
      readonly thinking?: (typeof THINKING_CHOICES)[number];
      readonly scope: WorkflowRegistryScope;
    }
  | {
      readonly action: "delete";
      readonly name: string;
      readonly scope: WorkflowRegistryScope;
    }
  | {
      readonly action: "rename";
      readonly oldName: string;
      readonly newName: string;
      readonly scope: WorkflowRegistryScope;
    }
  | {
      readonly action: "explain";
      readonly name: string;
      readonly scope: WorkflowRegistryScope;
    }
  | {
      readonly action: "explain-workflow";
      readonly workflowRef: string;
    }
  | {
      readonly action: "interactive";
    };

export const agentsCommand: CliCommand<AgentCommandArgs> = {
  name: "agents",
  parseArgs(argv: readonly string[]): AgentCommandArgs {
    if (argv[0] !== "agents") {
      throw new CliUsageError("Expected agents command.");
    }

    const action = argv[1];
    if (action === "set") {
      return parseSetArgs(argv.slice(2));
    }
    if (action === "delete") {
      return parseDeleteArgs(argv.slice(2));
    }
    if (action === "rename") {
      return parseRenameArgs(argv.slice(2));
    }
    if (action === "explain") {
      return parseExplainArgs(argv.slice(2));
    }
    if (action === undefined) {
      return { action: "interactive" };
    }

    throw new CliUsageError(
      "trailstep agents requires set, delete, rename, explain, or no subcommand for interactive mode.",
    );
  },
  async run(args: AgentCommandArgs, context: CliCommandContext): Promise<number> {
    if (args.action === "set") {
      return setAgent(args, context);
    }
    if (args.action === "delete") {
      return deleteAgent(args, context);
    }
    if (args.action === "rename") {
      return renameAgent(args, context);
    }
    if (args.action === "explain") {
      return explainAgent(args, context);
    }
    if (args.action === "explain-workflow") {
      return explainWorkflow(args, context);
    }
    return runInteractiveAgents(context);
  },
};

function parseSetArgs(argv: readonly string[]): AgentCommandArgs {
  const [name, ...flagsArgv] = argv;
  assertAgentName(name, "trailstep agents set requires <name>.");
  const flags = parseFlags(flagsArgv, ["--provider", "--model", "--thinking", "--scope"]);
  const scope = parseRequiredScope(
    flags.scope,
    "trailstep agents set requires --scope <local|project|global>.",
  );
  const provider = parseRequiredFlag(
    flags.provider,
    "trailstep agents set requires --provider <provider>.",
  );
  const model = parseOptionalTrimmedFlag(flags.model);
  const thinking = parseThinking(flags.thinking);

  return {
    action: "set",
    name,
    provider,
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
    scope,
  };
}

function parseDeleteArgs(argv: readonly string[]): AgentCommandArgs {
  const [name, ...flagsArgv] = argv;
  assertAgentName(name, "trailstep agents delete requires <name>.");
  const flags = parseFlags(flagsArgv, ["--scope"]);
  return {
    action: "delete",
    name,
    scope: parseRequiredScope(
      flags.scope,
      "trailstep agents delete requires --scope <local|project|global>.",
    ),
  };
}

function parseRenameArgs(argv: readonly string[]): AgentCommandArgs {
  const [oldName, newName, ...flagsArgv] = argv;
  assertAgentName(oldName, "trailstep agents rename requires <old>.");
  assertAgentName(newName, "trailstep agents rename requires <new>.");
  if (oldName === newName) {
    throw new CliUsageError("trailstep agents rename requires different old and new names.");
  }
  const flags = parseFlags(flagsArgv, ["--scope"]);
  return {
    action: "rename",
    oldName,
    newName,
    scope: parseRequiredScope(
      flags.scope,
      "trailstep agents rename requires --scope <local|project|global>.",
    ),
  };
}

function parseExplainArgs(argv: readonly string[]): AgentCommandArgs {
  const [name, ...flagsArgv] = argv;
  assertAgentName(name, "trailstep agents explain requires <name>.");
  const flags = parseFlags(flagsArgv, ["--scope"]);
  if (name.includes("/")) {
    return { action: "explain-workflow", workflowRef: name };
  }
  return {
    action: "explain",
    name,
    scope: parseRequiredScope(
      flags.scope,
      "trailstep agents explain requires --scope <local|project|global>.",
    ),
  };
}

function parseFlags(
  argv: readonly string[],
  allowedFlags: readonly string[],
): Record<string, string | undefined> {
  const flags: Record<string, string | undefined> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === undefined || !allowedFlags.includes(option)) {
      throw new CliUsageError(`Unknown option for trailstep agents: ${option ?? ""}`);
    }

    const value = argv[index + 1];
    if (value === undefined) {
      throw new CliUsageError(`Missing value for ${option}.`);
    }

    flags[option.slice(2)] = value;
    index += 1;
  }

  return flags;
}

async function setAgent(
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

async function deleteAgent(
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

async function renameAgent(
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

async function explainAgent(
  args: Extract<AgentCommandArgs, { readonly action: "explain" }>,
  context: CliCommandContext,
): Promise<number> {
  const configPath = configPathForScope(args.scope, context);
  const config = await readRawTrailStepConfigFile(configPath);
  const agents = toMutableRecord(config.agents);
  if (!(args.name in agents)) {
    throw new CliUsageError(`Agent ${args.name} does not exist in ${args.scope} config.`);
  }

  context.io.writeLine(`Agent ${args.name} (${args.scope})`);
  context.io.writeLine(`Config path: ${configPath}`);
  context.io.writeLine(`Entry: ${JSON.stringify(agents[args.name])}`);
  context.io.writeLine("Resolved targets:");
  const resolvedLines = explainAgentEntry(agents[args.name], agents, new Set([args.name]));
  if (resolvedLines.length === 0) {
    context.io.writeLine("  none");
  } else {
    resolvedLines.forEach((line, index) => {
      context.io.writeLine(`  ${index + 1}. ${line}`);
    });
  }

  const referrers = await findAgentReferrers(args.name, context);
  context.io.writeLine("Used by:");
  if (referrers.length === 0) {
    context.io.writeLine("  none");
  } else {
    for (const referrer of referrers) {
      context.io.writeLine(`  ${referrer.scope}: ${referrer.path}`);
    }
  }
  return 0;
}

interface MergedRawRoleConfig {
  readonly agents: Record<string, unknown>;
  workflowRoleEntry(workflowId: string, roleName: string): unknown;
}

async function explainWorkflow(
  args: Extract<AgentCommandArgs, { readonly action: "explain-workflow" }>,
  context: CliCommandContext,
): Promise<number> {
  let resolved: ResolvedWorkflowReference | undefined;
  try {
    resolved = await resolveWorkflowReference(args.workflowRef, context);
  } catch (error) {
    if (error instanceof WorkflowResolutionError) {
      throw new CliUsageError(error.message);
    }
    throw error;
  }
  if (resolved === undefined) {
    throw new CliUsageError(`Workflow ${args.workflowRef} could not be resolved.`);
  }

  const workflowId = resolved.workflow.id;
  context.io.writeLine(`Workflow ${args.workflowRef}`);
  context.io.writeLine(`Workflow id: ${workflowId}`);

  const roles = resolved.workflow.agents;
  const roleNames = roles === undefined ? [] : Object.keys(roles).sort();
  if (roleNames.length === 0) {
    context.io.writeLine("Agent roles: none declared by the workflow.");
    return 0;
  }

  const rawConfig = await readMergedRawRoleConfig(context);
  const loadedConfig = await loadTrailStepProjectConfig(context.cwd, { homeDir: context.homeDir });

  context.io.writeLine("Agent roles:");
  for (const roleName of roleNames) {
    const role = roles?.[roleName];
    if (role === undefined) {
      continue;
    }
    context.io.writeLine(`  ${roleName} (size ${role.size})`);

    context.io.writeLine("    Configured targets/refs:");
    const configuredLines = explainWorkflowRoleConfigured(
      rawConfig,
      workflowId,
      roleName,
      role.size,
    );
    if (configuredLines.length === 0) {
      context.io.writeLine("      none");
    } else {
      configuredLines.forEach((line, index) => {
        context.io.writeLine(`      ${index + 1}. ${line}`);
      });
    }

    context.io.writeLine("    Final targets:");
    const finalLines = explainWorkflowRoleFinalTargets(
      loadedConfig.trailstepConfig,
      workflowId,
      roleName,
      role.size,
    );
    if (finalLines.length === 0) {
      context.io.writeLine("      unavailable (no agent targets resolve for this role)");
    } else {
      finalLines.forEach((line, index) => {
        context.io.writeLine(`      ${index + 1}. ${line}`);
      });
    }
  }
  return 0;
}

/**
 * Reads raw scope configs with local > project > global precedence so configured
 * entries can be shown with refs intact before core expands them.
 */
async function readMergedRawRoleConfig(context: CliCommandContext): Promise<MergedRawRoleConfig> {
  const scopeConfigs = await Promise.all(
    (["global", "project", "local"] as const).map((scope) =>
      readRawTrailStepConfigFile(configPathForScope(scope, context)),
    ),
  );

  let agents: Record<string, unknown> = {};
  const workflowBuckets: Record<string, Record<string, unknown>> = {};
  for (const config of scopeConfigs) {
    agents = { ...agents, ...toMutableRecord(config.agents) };
    for (const [workflowKey, workflowValue] of Object.entries(toMutableRecord(config.workflows))) {
      if (!isRecord(workflowValue)) {
        continue;
      }
      const existingBucket = toMutableRecord(workflowBuckets[workflowKey]);
      workflowBuckets[workflowKey] = {
        ...existingBucket,
        ...workflowValue,
        agents: {
          ...toMutableRecord(existingBucket.agents),
          ...toMutableRecord(workflowValue.agents),
        },
      };
    }
  }

  return {
    agents,
    workflowRoleEntry(workflowId: string, roleName: string): unknown {
      return toMutableRecord(toMutableRecord(workflowBuckets[workflowId]).agents)[roleName];
    },
  };
}

function explainWorkflowRoleConfigured(
  rawConfig: MergedRawRoleConfig,
  workflowId: string,
  roleName: string,
  roleSize: string,
): readonly string[] {
  const lines: string[] = [];
  const appendSource = (label: string, entry: unknown): void => {
    const rendered = explainAgentEntry(entry, rawConfig.agents, new Set());
    if (rendered.length > 0) {
      lines.push(`${label}: ${rendered.join("; ")}`);
    }
  };

  appendSource(
    `workflows.${workflowId}.agents.${roleName}`,
    rawConfig.workflowRoleEntry(workflowId, roleName),
  );
  for (const key of new Set([roleName, roleSize, "default"])) {
    appendSource(`agents.${key}`, rawConfig.agents[key]);
  }
  return lines;
}

function explainWorkflowRoleFinalTargets(
  effectiveConfig: TrailStepConfig | undefined,
  workflowId: string,
  roleName: string,
  roleSize: string,
): readonly string[] {
  if (effectiveConfig === undefined) {
    return [];
  }

  try {
    return resolveAgentTargets({ config: effectiveConfig, workflowId, roleName, roleSize }).map(
      (target) => {
        const parts = [`provider ${target.provider}`];
        if (typeof target.model === "string" && target.model.trim().length > 0) {
          parts.push(`model ${target.model}`);
        }
        if (target.thinking !== undefined) {
          parts.push(`thinking ${target.thinking}`);
        }
        return parts.join(", ");
      },
    );
  } catch (error) {
    if (isAgentTargetsUnavailableError(error)) {
      return [];
    }
    throw error;
  }
}

function isAgentTargetsUnavailableError(error: unknown): boolean {
  return (
    isRecord(error) && isRecord(error.failure) && error.failure.code === "agent_targets_unavailable"
  );
}

const INTERACTIVE_SCOPES = ["local", "project", "global"] as const;
const RESERVED_AGENT_NAMES = ["default", "tiny", "small", "medium", "large", "xl"] as const;
const PROVIDER_CHOICES = ["claude", "codex", "gemini", "pi"] as const;

async function runInteractiveAgents(context: CliCommandContext): Promise<number> {
  if (context.prompts === undefined) {
    throw new CliUsageError("trailstep agents requires prompts for interactive mode.");
  }

  const scopeLabel = await context.prompts.select("Scope", INTERACTIVE_SCOPES);
  const scope = scopeForInteractiveLabel(scopeLabel);
  const configPath = configPathForScope(scope, context);
  const config = await readRawTrailStepConfigFile(configPath);
  if (!hasConfiguredAgentEntries(config)) {
    const nextConfig = await runAgentSetupWizard({
      config,
      agentName: "default",
      prompts: context.prompts,
      providerChoices: PROVIDER_CHOICES,
      cwd: context.cwd,
      io: context.io,
      packageCommandRunner: context.packageCommandRunner,
    });
    await writeRawTrailStepConfigFile(configPath, nextConfig);
    context.io.writeLine(`Wrote agent default to ${configPath}.`);
    return 0;
  }

  const rows = await buildInteractiveRows(scope, context);
  const selected = await context.prompts.select(`${scopeLabel} agents`, [
    ...rows.map((row) => row.label),
    "+ Create new agent",
    "Done",
  ]);
  if (selected === "Done") {
    return 0;
  }

  if (selected === "+ Create new agent") {
    await createNamedAgent(scope, context);
    return 0;
  }

  const row = rows.find((candidate) => candidate.label === selected);
  if (row?.kind === "named-agent") {
    await editNamedAgent(row, scope, context);
  } else if (row?.kind === "workflow-role") {
    await editWorkflowRole(row, scope, context);
  }
  return 0;
}

interface InteractiveNamedAgentRow {
  readonly kind: "named-agent";
  readonly name: string;
  readonly label: string;
}

interface InteractiveWorkflowRoleRow {
  readonly kind: "workflow-role";
  readonly workflowId: string;
  readonly roleName: string;
  readonly label: string;
  readonly state: "dash" | "ref" | "inline";
  readonly ref?: string;
}

type InteractiveRow = InteractiveNamedAgentRow | InteractiveWorkflowRoleRow;

async function buildInteractiveRows(
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<readonly InteractiveRow[]> {
  const config = await readRawTrailStepConfigFile(configPathForScope(scope, context));
  const agents = toMutableRecord(config.agents);
  const customNames = Object.keys(agents)
    .filter((name) => !RESERVED_AGENT_NAMES.includes(name as (typeof RESERVED_AGENT_NAMES)[number]))
    .sort();
  const namedRows = [...customNames, ...RESERVED_AGENT_NAMES].map((name) => ({
    kind: "named-agent" as const,
    name,
    label: `${name} — ${agentEntrySummary(agents[name])}`,
  }));
  const workflowRows = await buildWorkflowRows(config, context);
  return [...namedRows, ...workflowRows];
}

async function buildWorkflowRows(
  rawConfig: Record<string, unknown>,
  context: CliCommandContext,
): Promise<readonly InteractiveWorkflowRoleRow[]> {
  const rows: InteractiveWorkflowRoleRow[] = [];
  for (const entry of await listRegisteredWorkflowEntries(context)) {
    const ref = `${entry.namespace}/${entry.name}`;
    const resolved = await resolveWorkflowReference(ref, context);
    if (resolved?.workflow.agents === undefined) {
      continue;
    }
    for (const roleName of Object.keys(resolved.workflow.agents).sort()) {
      const workflowId = resolved.workflow.id;
      const workflowOverride = toMutableRecord(toMutableRecord(rawConfig.workflows)[workflowId]);
      const workflowAgents = toMutableRecord(workflowOverride.agents);
      const roleEntry = workflowAgents[roleName];
      const state = agentEntryState(roleEntry);
      rows.push({
        kind: "workflow-role",
        workflowId,
        roleName,
        label: `workflow ${workflowId} ${roleName} — ${agentEntrySummary(roleEntry)}`,
        state: state.kind,
        ...(state.kind === "ref" ? { ref: state.ref } : {}),
      });
    }
  }
  return rows;
}

async function createNamedAgent(
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<void> {
  if (context.prompts === undefined) {
    throw new CliUsageError("trailstep agents requires prompts for interactive mode.");
  }
  const name = (await context.prompts.text("Agent name")).trim();
  assertAgentName(name, "Agent name is required.");
  const configured = await configureLiteralAgentTarget({
    prompts: context.prompts,
    providerChoices: PROVIDER_CHOICES,
    cwd: context.cwd,
    io: context.io,
    packageCommandRunner: context.packageCommandRunner,
  });
  const outcome = await confirmAgentConfigSave({
    context: { kind: "named-agent-create", name },
    prompts: context.prompts,
  });
  if (outcome !== "save-as-new-permanent-agent") {
    return;
  }
  await writeNamedAgent(
    scope,
    name,
    [{ ...configured.target }],
    context,
    configured.customProvider,
  );
}

async function editNamedAgent(
  row: InteractiveNamedAgentRow,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<void> {
  if (context.prompts === undefined) {
    throw new CliUsageError("trailstep agents requires prompts for interactive mode.");
  }
  const action = await context.prompts.select(`Agent ${row.name}`, [
    "Edit",
    "Rename",
    "Delete",
    "Done",
  ]);
  if (action === "Done") {
    return;
  }
  if (action === "Edit") {
    const existingEntry = await readNamedAgentEntry(scope, row.name, context);
    const nextConfigured = await editNamedAgentEntry(existingEntry, scope, context);
    const outcome = await confirmAgentConfigSave({
      context: { kind: "named-agent-edit", name: row.name },
      prompts: context.prompts,
    });
    if (outcome === "save-original") {
      await writeNamedAgent(
        scope,
        row.name,
        nextConfigured.entry,
        context,
        nextConfigured.customProviders,
      );
    } else if (outcome === "create-new-agent") {
      const newName = (await context.prompts.text("New agent name")).trim();
      assertAgentName(newName, "New agent name is required.");
      await writeNamedAgent(
        scope,
        newName,
        nextConfigured.entry,
        context,
        nextConfigured.customProviders,
      );
    }
    return;
  }
  if (action === "Rename") {
    const newName = (await context.prompts.text("New agent name")).trim();
    assertAgentName(newName, "New agent name is required.");
    if (newName === row.name) {
      throw new CliUsageError("New agent name must differ from the current name.");
    }
    const outcome = await confirmAgentConfigSave({
      context: { kind: "named-agent-edit", name: row.name },
      prompts: context.prompts,
    });
    if (outcome === "save-original") {
      await renameAgent({ action: "rename", oldName: row.name, newName, scope }, context);
    }
    return;
  }
  if (action === "Delete") {
    await blockDeleteWhenAgentReferrersExist(row.name, context);
    const outcome = await confirmAgentConfigSave({
      context: { kind: "named-agent-edit", name: row.name },
      prompts: context.prompts,
    });
    if (outcome === "save-original") {
      await deleteAgent({ action: "delete", name: row.name, scope }, context);
    }
  }
}

async function editWorkflowRole(
  row: InteractiveWorkflowRoleRow,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<void> {
  if (context.prompts === undefined) {
    throw new CliUsageError("trailstep agents requires prompts for interactive mode.");
  }
  const actions = workflowRoleActions(row.state);
  const action = await context.prompts.select(
    `Workflow ${row.workflowId} role ${row.roleName}`,
    actions,
  );
  if (action === "Done") {
    return;
  }
  if (action === "Use named agent") {
    await setWorkflowRoleToNamedAgent(row, scope, context);
    return;
  }
  if (action === "Create inline one-off") {
    await setWorkflowRoleToInline(row, scope, context);
    return;
  }
  if (action === "Edit inline one-off") {
    await editWorkflowRoleInline(row, scope, context);
    return;
  }
  if (action === "Edit referenced shared agent") {
    if (row.ref === undefined) {
      throw new CliUsageError(`Workflow ${row.workflowId} role ${row.roleName} is not a ref row.`);
    }
    await editReferencedNamedAgent(row, scope, context);
    return;
  }
  if (action === "Remove override") {
    await removeWorkflowRoleOverride(row, scope, context);
    return;
  }
  if (action === "Replace override") {
    const replacement = await context.prompts.select("Replacement", [
      "Use named agent",
      "Create inline one-off",
    ]);
    if (replacement === "Use named agent") {
      await setWorkflowRoleToNamedAgent(row, scope, context);
    } else {
      await setWorkflowRoleToInline(row, scope, context);
    }
  }
}

function workflowRoleActions(state: InteractiveWorkflowRoleRow["state"]): readonly string[] {
  if (state === "dash") {
    return ["Use named agent", "Create inline one-off", "Done"];
  }
  if (state === "ref") {
    return ["Edit referenced shared agent", "Remove override", "Replace override", "Done"];
  }
  return ["Edit inline one-off", "Remove override", "Replace override", "Done"];
}

function saveConfirmContextForWorkflowRole(
  row: InteractiveWorkflowRoleRow,
): AgentConfigSaveContext {
  if (row.state === "inline") {
    return { kind: "workflow-role-inline", roleName: row.roleName, workflowId: row.workflowId };
  }
  if (row.state === "ref" && row.ref !== undefined) {
    return {
      kind: "workflow-role-ref",
      roleName: row.roleName,
      workflowId: row.workflowId,
      ref: row.ref,
    };
  }
  return { kind: "workflow-role-dash", roleName: row.roleName, workflowId: row.workflowId };
}

async function setWorkflowRoleToNamedAgent(
  row: InteractiveWorkflowRoleRow,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<void> {
  if (context.prompts === undefined) {
    throw new CliUsageError("trailstep agents requires prompts for interactive mode.");
  }
  const names = await listNamedAgentChoices(context);
  const selection = await context.prompts.select("Named agent", ["+ Create new agent", ...names]);

  if (selection === "+ Create new agent") {
    const name = (await context.prompts.text("New agent name")).trim();
    assertAgentName(name, "New agent name is required.");
    const configured = await configureLiteralAgentTarget({
      prompts: context.prompts,
      providerChoices: PROVIDER_CHOICES,
      cwd: context.cwd,
      io: context.io,
      packageCommandRunner: context.packageCommandRunner,
    });
    const outcome = await confirmAgentConfigSave({
      context: saveConfirmContextForWorkflowRole(row),
      prompts: context.prompts,
    });
    if (outcome === "discard") {
      return;
    }
    await writeNamedAgent(
      scope,
      name,
      [{ ...configured.target }],
      context,
      configured.customProvider,
    );
    await writeWorkflowRole(scope, row, [{ ref: name }], context);
    return;
  }

  const outcome = await confirmAgentConfigSave({
    context: saveConfirmContextForWorkflowRole(row),
    prompts: context.prompts,
  });
  if (outcome === "discard") {
    return;
  }
  await writeWorkflowRole(scope, row, [{ ref: selection }], context);
}

async function setWorkflowRoleToInline(
  row: InteractiveWorkflowRoleRow,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<void> {
  if (context.prompts === undefined) {
    throw new CliUsageError("trailstep agents requires prompts for interactive mode.");
  }
  const configured = await configureLiteralAgentTarget({
    prompts: context.prompts,
    providerChoices: PROVIDER_CHOICES,
    cwd: context.cwd,
    io: context.io,
    packageCommandRunner: context.packageCommandRunner,
  });
  const outcome = await confirmAgentConfigSave({
    context: saveConfirmContextForWorkflowRole(row),
    prompts: context.prompts,
  });
  if (
    outcome === "save-original" ||
    outcome === "save-as-one-off" ||
    outcome === "detach-one-off"
  ) {
    await writeWorkflowRole(
      scope,
      row,
      [{ ...configured.target }],
      context,
      configured.customProvider,
    );
  } else if (outcome === "create-new-agent" || outcome === "save-as-new-permanent-agent") {
    const name = (await context.prompts.text("New agent name")).trim();
    assertAgentName(name, "New agent name is required.");
    await writeNamedAgent(
      scope,
      name,
      [{ ...configured.target }],
      context,
      configured.customProvider,
    );
    await writeWorkflowRole(scope, row, [{ ref: name }], context);
  }
}

async function editWorkflowRoleInline(
  row: InteractiveWorkflowRoleRow,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<void> {
  if (context.prompts === undefined) {
    throw new CliUsageError("trailstep agents requires prompts for interactive mode.");
  }
  const existingEntry = await readWorkflowRoleEntry(scope, row, context);
  const nextConfigured = await editNamedAgentEntry(existingEntry, scope, context);
  const outcome = await confirmAgentConfigSave({
    context: saveConfirmContextForWorkflowRole(row),
    prompts: context.prompts,
  });
  if (
    outcome === "save-original" ||
    outcome === "save-as-one-off" ||
    outcome === "detach-one-off"
  ) {
    await writeWorkflowRole(
      scope,
      row,
      nextConfigured.entry,
      context,
      nextConfigured.customProviders,
    );
  } else if (outcome === "create-new-agent" || outcome === "save-as-new-permanent-agent") {
    const name = (await context.prompts.text("New agent name")).trim();
    assertAgentName(name, "New agent name is required.");
    await writeNamedAgent(
      scope,
      name,
      nextConfigured.entry,
      context,
      nextConfigured.customProviders,
    );
    await writeWorkflowRole(scope, row, [{ ref: name }], context);
  }
}

async function readWorkflowRoleEntry(
  scope: WorkflowRegistryScope,
  row: InteractiveWorkflowRoleRow,
  context: CliCommandContext,
): Promise<AgentEntryItems> {
  const config = await readRawTrailStepConfigFile(configPathForScope(scope, context));
  const workflowConfig = toMutableRecord(toMutableRecord(config.workflows)[row.workflowId]);
  const workflowAgents = toMutableRecord(workflowConfig.agents);
  return readAgentEntryItems(workflowAgents[row.roleName]);
}

async function removeWorkflowRoleOverride(
  row: InteractiveWorkflowRoleRow,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<void> {
  if (context.prompts === undefined) {
    throw new CliUsageError("trailstep agents requires prompts for interactive mode.");
  }
  const outcome = await confirmAgentConfigSave({
    context: saveConfirmContextForWorkflowRole(row),
    prompts: context.prompts,
  });
  if (outcome !== "save-original") {
    return;
  }
  const configPath = configPathForScope(scope, context);
  const config = await readRawTrailStepConfigFile(configPath);
  const workflows = toMutableRecord(config.workflows);
  const workflowConfig = toMutableRecord(workflows[row.workflowId]);
  const workflowAgents = toMutableRecord(workflowConfig.agents);
  delete workflowAgents[row.roleName];
  workflows[row.workflowId] = { ...workflowConfig, agents: workflowAgents };
  await writeRawTrailStepConfigFile(configPath, { ...config, workflows });
}

async function editReferencedNamedAgent(
  row: InteractiveWorkflowRoleRow,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<void> {
  if (context.prompts === undefined || row.ref === undefined) {
    throw new CliUsageError("trailstep agents requires prompts for interactive mode.");
  }
  const targetScope = await findNamedAgentScope(row.ref, context);
  const existingEntry = await readNamedAgentEntry(targetScope, row.ref, context);
  const configured = await editNamedAgentEntry(existingEntry, targetScope, context);
  const outcome = await confirmAgentConfigSave({
    context: {
      kind: "workflow-role-ref",
      roleName: row.roleName,
      workflowId: row.workflowId,
      ref: row.ref,
    },
    prompts: context.prompts,
  });
  if (outcome === "save-original") {
    await writeNamedAgent(
      targetScope,
      row.ref,
      configured.entry,
      context,
      configured.customProviders,
    );
  } else if (outcome === "create-new-agent") {
    const name = (await context.prompts.text("New agent name")).trim();
    assertAgentName(name, "New agent name is required.");
    await writeNamedAgent(scope, name, configured.entry, context, configured.customProviders);
    await writeWorkflowRole(scope, row, [{ ref: name }], context);
  } else if (outcome === "detach-one-off") {
    await writeWorkflowRole(scope, row, configured.entry, context, configured.customProviders);
  }
}

async function readNamedAgentEntry(
  scope: WorkflowRegistryScope,
  name: string,
  context: CliCommandContext,
): Promise<AgentEntryItems> {
  const config = await readRawTrailStepConfigFile(configPathForScope(scope, context));
  return readAgentEntryItems(toMutableRecord(config.agents)[name]);
}

async function editNamedAgentEntry(
  entry: AgentEntryItems,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<AgentEntryEditResult> {
  if (context.prompts === undefined) {
    throw new CliUsageError("trailstep agents requires prompts for interactive mode.");
  }

  let current = entry;
  const customProviders: ConfiguredCustomProvider[] = [];
  for (;;) {
    const items = current;
    if (items.length === 0) {
      const configured = await configureLiteralAgentTarget({
        prompts: context.prompts,
        providerChoices: PROVIDER_CHOICES,
        cwd: context.cwd,
        io: context.io,
        packageCommandRunner: context.packageCommandRunner,
      });
      return {
        entry: [{ ...configured.target }],
        customProviders: customProviderList(configured.customProvider),
      };
    }

    const choices = [
      ...items.map((item, index) => `Edit item ${index + 1} — ${agentItemSummary(item)}`),
      ...items.map((item, index) => `Remove item ${index + 1} — ${agentItemSummary(item)}`),
      ...items.flatMap((_item, index) => [
        ...(index > 0 ? [`Move item ${index + 1} up`] : []),
        ...(index < items.length - 1 ? [`Move item ${index + 1} down`] : []),
      ]),
      "Add item",
      "Done",
    ];
    const action = await context.prompts.select("Manage agent entry items", choices);
    if (action === "Done") {
      return { entry: current, customProviders };
    }
    if (action === "Add item") {
      const next = await addItemToEntry(current, context);
      current = next.entry;
      customProviders.push(...next.customProviders);
      continue;
    }

    const moveMatch = /^Move item (\d+) (up|down)$/u.exec(action);
    if (moveMatch !== null) {
      const fromIndex = Number(moveMatch[1]) - 1;
      const toIndex = moveMatch[2] === "up" ? fromIndex - 1 : fromIndex + 1;
      current = reorderAgentEntryItem(current, fromIndex, toIndex);
      continue;
    }

    const match = /^(Edit|Remove) item (\d+)/u.exec(action);
    if (match === null) {
      throw new CliUsageError(`Unknown agent item action: ${action}`);
    }
    const itemIndex = Number(match[2]) - 1;
    if (match[1] === "Remove") {
      current = removeAgentEntryItem(current, itemIndex);
      continue;
    }

    const targetItem = items[itemIndex];
    if (targetItem !== undefined && typeof targetItem.ref === "string") {
      current = await editRefItemInPlace(current, itemIndex, targetItem.ref, scope, context);
      continue;
    }
    const configured = await configureLiteralAgentTarget({
      prompts: context.prompts,
      providerChoices: PROVIDER_CHOICES,
      cwd: context.cwd,
      io: context.io,
      packageCommandRunner: context.packageCommandRunner,
    });
    current = editAgentEntryItem(current, itemIndex, { ...configured.target });
    customProviders.push(...customProviderList(configured.customProvider));
  }
}

async function addItemToEntry(
  entry: AgentEntryItems,
  context: CliCommandContext,
): Promise<AgentEntryEditResult> {
  if (context.prompts === undefined) {
    throw new CliUsageError("trailstep agents requires prompts for interactive mode.");
  }
  const choice = await context.prompts.select("Add item", ["Pick existing agent", "Create new"]);
  if (choice === "Pick existing agent") {
    const names = await listNamedAgentChoices(context);
    const ref = await context.prompts.select("Named agent", names);
    return { entry: addAgentEntryItem(entry, { ref }), customProviders: [] };
  }
  const configured = await configureLiteralAgentTarget({
    prompts: context.prompts,
    providerChoices: PROVIDER_CHOICES,
    cwd: context.cwd,
    io: context.io,
    packageCommandRunner: context.packageCommandRunner,
  });
  return {
    entry: addAgentEntryItem(entry, { ...configured.target }),
    customProviders: customProviderList(configured.customProvider),
  };
}

async function editRefItemInPlace(
  entry: AgentEntryItems,
  itemIndex: number,
  ref: string,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<AgentEntryItems> {
  if (context.prompts === undefined) {
    throw new CliUsageError("trailstep agents requires prompts for interactive mode.");
  }
  const targetScope = await findNamedAgentScope(ref, context);
  const existingEntry = await readNamedAgentEntry(targetScope, ref, context);
  const nextRefEntry = await editNamedAgentEntry(existingEntry, targetScope, context);
  const outcome = await confirmAgentConfigSave({
    context: { kind: "named-agent-edit", name: ref },
    prompts: context.prompts,
  });
  if (outcome === "save-original") {
    await writeNamedAgent(
      targetScope,
      ref,
      nextRefEntry.entry,
      context,
      nextRefEntry.customProviders,
    );
    return entry;
  }
  if (outcome === "create-new-agent") {
    const newName = (await context.prompts.text("New agent name")).trim();
    assertAgentName(newName, "New agent name is required.");
    await writeNamedAgent(
      scope,
      newName,
      nextRefEntry.entry,
      context,
      nextRefEntry.customProviders,
    );
    return editAgentEntryItem(entry, itemIndex, { ref: newName });
  }
  return entry;
}

async function findNamedAgentScope(
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

async function listNamedAgentChoices(context: CliCommandContext): Promise<readonly string[]> {
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

async function writeNamedAgent(
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

async function writeWorkflowRole(
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

function customProviderList(
  customProvider: ConfiguredCustomProvider | undefined,
): readonly ConfiguredCustomProvider[] {
  return customProvider === undefined ? [] : [customProvider];
}

function explainAgentEntry(
  value: unknown,
  agents: Record<string, unknown>,
  seenRefs: ReadonlySet<string>,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }

  return value.map((item) => explainAgentItem(item, agents, seenRefs));
}

function explainAgentItem(
  item: unknown,
  agents: Record<string, unknown>,
  seenRefs: ReadonlySet<string>,
): string {
  if (!isRecord(item)) {
    return "invalid agent item";
  }
  if (typeof item.ref === "string") {
    if (seenRefs.has(item.ref)) {
      return `ref ${item.ref} (cycle)`;
    }
    if (!(item.ref in agents)) {
      return `ref ${item.ref} (missing)`;
    }
    const nested = explainAgentEntry(agents[item.ref], agents, new Set([...seenRefs, item.ref]));
    if (nested.length === 0) {
      return `ref ${item.ref} (empty)`;
    }
    return `ref ${item.ref} -> ${nested.join("; ")}`;
  }
  if (typeof item.provider !== "string") {
    return `inline ${JSON.stringify(item)}`;
  }

  const parts = [`provider ${item.provider}`];
  if (typeof item.model === "string" && item.model.trim().length > 0) {
    parts.push(`model ${item.model}`);
  }
  if (typeof item.thinking === "string" && item.thinking.trim().length > 0) {
    parts.push(`thinking ${item.thinking}`);
  }
  return parts.join(", ");
}

function withConfiguredCustomProviders(
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

function agentItemSummary(item: Record<string, unknown>): string {
  if (typeof item.ref === "string") {
    return `ref ${item.ref}`;
  }
  if (typeof item.provider === "string") {
    return `one-off ${item.provider}${typeof item.model === "string" ? `/${item.model}` : ""}`;
  }
  return "inline one-off";
}

function agentEntrySummary(value: unknown): string {
  const state = agentEntryState(value);
  if (state.kind === "dash") {
    return "----";
  }
  if (state.kind === "ref") {
    return `ref ${state.ref}`;
  }
  const first = state.item;
  if (typeof first.provider === "string") {
    return `one-off ${first.provider}${typeof first.model === "string" ? `/${first.model}` : ""}`;
  }
  return "inline one-off";
}

function agentEntryState(
  value: unknown,
):
  | { readonly kind: "dash" }
  | { readonly kind: "ref"; readonly ref: string }
  | { readonly kind: "inline"; readonly item: Record<string, unknown> } {
  const items = Array.isArray(value) ? value : [];
  if (items.length === 0) {
    return { kind: "dash" };
  }
  const first = items[0];
  if (!isRecord(first)) {
    return { kind: "inline", item: {} };
  }
  if (typeof first.ref === "string") {
    return { kind: "ref", ref: first.ref };
  }
  return { kind: "inline", item: first };
}

function scopeForInteractiveLabel(label: string): WorkflowRegistryScope {
  if (label === "local") {
    return "local";
  }
  if (label === "project") {
    return "project";
  }
  if (label === "global") {
    return "global";
  }
  throw new CliUsageError(`Invalid agents scope selection: ${label}`);
}

function parseRequiredScope(
  value: string | undefined,
  missingMessage: string,
): WorkflowRegistryScope {
  const scope = parseRequiredFlag(value, missingMessage);
  if (scope !== "local" && scope !== "project" && scope !== "global") {
    throw new CliUsageError(
      "trailstep agents requires --scope local, --scope project, or --scope global.",
    );
  }
  return scope;
}

function parseRequiredFlag(value: string | undefined, message: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new CliUsageError(message);
  }
  return value;
}

function parseOptionalTrimmedFlag(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseThinking(value: string | undefined): (typeof THINKING_CHOICES)[number] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!THINKING_CHOICES.includes(value as (typeof THINKING_CHOICES)[number])) {
    throw new CliUsageError(`Invalid thinking value: ${value}`);
  }
  return value as (typeof THINKING_CHOICES)[number];
}

function assertAgentName(value: string | undefined, message: string): asserts value is string {
  if (value === undefined || value.trim().length === 0 || value.startsWith("--")) {
    throw new CliUsageError(message);
  }
}

function toMutableRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  return { ...value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
