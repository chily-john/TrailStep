import {
  addAgentEntryItem,
  editAgentEntryItem,
  readAgentEntryItems,
  removeAgentEntryItem,
  reorderAgentEntryItem,
} from "../../agent-config/agent-entry-items-flow.js";
import {
  blockDeleteWhenAgentReferrersExist,
  renameAgentRefs,
} from "../../agent-config/agent-referrers.js";
import { configureLiteralAgentTarget } from "../../agent-config/configure-target-flow.js";
import {
  type AgentConfigSaveContext,
  confirmAgentConfigSave,
} from "../../agent-config/save-confirm-flow.js";
import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import {
  configPathForScope,
  listRegisteredWorkflowEntries,
  readRawStepKitConfigFile,
  type WorkflowRegistryScope,
  writeRawStepKitConfigFile,
} from "../../workflow-registry/workflow-registry.js";
import { resolveWorkflowReference } from "../../workflow-resolution/workflow-resolution.js";

const THINKING_CHOICES = ["none", "low", "medium", "high", "xhigh", "max"] as const;

type AgentEntryItems = readonly Record<string, unknown>[];

type AgentCommandArgs =
  | {
      readonly action: "set";
      readonly name: string;
      readonly provider: string;
      readonly model: string;
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
    if (action === undefined) {
      return { action: "interactive" };
    }

    throw new CliUsageError(
      "stepkit agents requires set, delete, rename, or no subcommand for interactive mode.",
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
    return runInteractiveAgents(context);
  },
};

function parseSetArgs(argv: readonly string[]): AgentCommandArgs {
  const [name, ...flagsArgv] = argv;
  assertAgentName(name, "stepkit agents set requires <name>.");
  const flags = parseFlags(flagsArgv, ["--provider", "--model", "--thinking", "--scope"]);
  const scope = parseRequiredScope(
    flags.scope,
    "stepkit agents set requires --scope <local|project|global>.",
  );
  const provider = parseRequiredFlag(
    flags.provider,
    "stepkit agents set requires --provider <provider>.",
  );
  const model = parseRequiredFlag(flags.model, "stepkit agents set requires --model <model>.");
  const thinking = parseThinking(flags.thinking);

  return {
    action: "set",
    name,
    provider,
    model,
    ...(thinking === undefined ? {} : { thinking }),
    scope,
  };
}

function parseDeleteArgs(argv: readonly string[]): AgentCommandArgs {
  const [name, ...flagsArgv] = argv;
  assertAgentName(name, "stepkit agents delete requires <name>.");
  const flags = parseFlags(flagsArgv, ["--scope"]);
  return {
    action: "delete",
    name,
    scope: parseRequiredScope(
      flags.scope,
      "stepkit agents delete requires --scope <local|project|global>.",
    ),
  };
}

function parseRenameArgs(argv: readonly string[]): AgentCommandArgs {
  const [oldName, newName, ...flagsArgv] = argv;
  assertAgentName(oldName, "stepkit agents rename requires <old>.");
  assertAgentName(newName, "stepkit agents rename requires <new>.");
  if (oldName === newName) {
    throw new CliUsageError("stepkit agents rename requires different old and new names.");
  }
  const flags = parseFlags(flagsArgv, ["--scope"]);
  return {
    action: "rename",
    oldName,
    newName,
    scope: parseRequiredScope(
      flags.scope,
      "stepkit agents rename requires --scope <local|project|global>.",
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
      throw new CliUsageError(`Unknown option for stepkit agents: ${option ?? ""}`);
    }

    const value = argv[index + 1];
    if (!value) {
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
  const config = await readRawStepKitConfigFile(configPath);
  const agents = toMutableRecord(config.agents);
  agents[args.name] = [
    {
      provider: args.provider,
      model: args.model,
      ...(args.thinking === undefined || args.thinking === "none"
        ? {}
        : { thinking: args.thinking }),
    },
  ];
  await writeRawStepKitConfigFile(configPath, { ...config, agents });
  context.io.writeLine(`Wrote agent ${args.name} to ${configPath}.`);
  return 0;
}

async function deleteAgent(
  args: Extract<AgentCommandArgs, { readonly action: "delete" }>,
  context: CliCommandContext,
): Promise<number> {
  await blockDeleteWhenAgentReferrersExist(args.name, context);

  const configPath = configPathForScope(args.scope, context);
  const config = await readRawStepKitConfigFile(configPath);
  const agents = toMutableRecord(config.agents);
  delete agents[args.name];
  await writeRawStepKitConfigFile(configPath, { ...config, agents });
  context.io.writeLine(`Deleted agent ${args.name} from ${configPath}.`);
  return 0;
}

async function renameAgent(
  args: Extract<AgentCommandArgs, { readonly action: "rename" }>,
  context: CliCommandContext,
): Promise<number> {
  const configPath = configPathForScope(args.scope, context);
  const config = await readRawStepKitConfigFile(configPath);
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
  await writeRawStepKitConfigFile(configPath, { ...config, agents: renamedAgents });
  await renameAgentRefs(args.oldName, args.newName, context);
  context.io.writeLine(`Renamed agent ${args.oldName} to ${args.newName}.`);
  return 0;
}

const INTERACTIVE_SCOPES = ["Local", "Project", "Global"] as const;
const RESERVED_AGENT_NAMES = ["default", "tiny", "small", "medium", "large", "xl"] as const;
const PROVIDER_CHOICES = ["claude", "codex", "gemini", "pi"] as const;

async function runInteractiveAgents(context: CliCommandContext): Promise<number> {
  if (context.prompts === undefined) {
    throw new CliUsageError("stepkit agents requires prompts for interactive mode.");
  }

  const scopeLabel = await context.prompts.select("Scope", INTERACTIVE_SCOPES);
  const scope = scopeForInteractiveLabel(scopeLabel);
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
  const config = await readRawStepKitConfigFile(configPathForScope(scope, context));
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
    throw new CliUsageError("stepkit agents requires prompts for interactive mode.");
  }
  const name = (await context.prompts.text("Agent name")).trim();
  assertAgentName(name, "Agent name is required.");
  const configured = await configureLiteralAgentTarget({
    prompts: context.prompts,
    providerChoices: PROVIDER_CHOICES,
  });
  const outcome = await confirmAgentConfigSave({
    context: { kind: "named-agent-create", name },
    prompts: context.prompts,
  });
  if (outcome !== "save-as-new-permanent-agent") {
    return;
  }
  await writeNamedAgent(scope, name, [{ ...configured.target }], context);
}

async function editNamedAgent(
  row: InteractiveNamedAgentRow,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<void> {
  if (context.prompts === undefined) {
    throw new CliUsageError("stepkit agents requires prompts for interactive mode.");
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
    const nextEntry = await editNamedAgentEntry(existingEntry, scope, context);
    const outcome = await confirmAgentConfigSave({
      context: { kind: "named-agent-edit", name: row.name },
      prompts: context.prompts,
    });
    if (outcome === "save-original") {
      await writeNamedAgent(scope, row.name, nextEntry, context);
    } else if (outcome === "create-new-agent") {
      const newName = (await context.prompts.text("New agent name")).trim();
      assertAgentName(newName, "New agent name is required.");
      await writeNamedAgent(scope, newName, nextEntry, context);
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
    throw new CliUsageError("stepkit agents requires prompts for interactive mode.");
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
    throw new CliUsageError("stepkit agents requires prompts for interactive mode.");
  }
  const names = await listNamedAgentChoices(context);
  const selection = await context.prompts.select("Named agent", ["+ Create new agent", ...names]);

  if (selection === "+ Create new agent") {
    const name = (await context.prompts.text("New agent name")).trim();
    assertAgentName(name, "New agent name is required.");
    const configured = await configureLiteralAgentTarget({
      prompts: context.prompts,
      providerChoices: PROVIDER_CHOICES,
    });
    const outcome = await confirmAgentConfigSave({
      context: saveConfirmContextForWorkflowRole(row),
      prompts: context.prompts,
    });
    if (outcome === "discard") {
      return;
    }
    await writeNamedAgent(scope, name, [{ ...configured.target }], context);
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
    throw new CliUsageError("stepkit agents requires prompts for interactive mode.");
  }
  const configured = await configureLiteralAgentTarget({
    prompts: context.prompts,
    providerChoices: PROVIDER_CHOICES,
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
    await writeWorkflowRole(scope, row, [{ ...configured.target }], context);
  } else if (outcome === "create-new-agent" || outcome === "save-as-new-permanent-agent") {
    const name = (await context.prompts.text("New agent name")).trim();
    assertAgentName(name, "New agent name is required.");
    await writeNamedAgent(scope, name, [{ ...configured.target }], context);
    await writeWorkflowRole(scope, row, [{ ref: name }], context);
  }
}

async function editWorkflowRoleInline(
  row: InteractiveWorkflowRoleRow,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<void> {
  if (context.prompts === undefined) {
    throw new CliUsageError("stepkit agents requires prompts for interactive mode.");
  }
  const existingEntry = await readWorkflowRoleEntry(scope, row, context);
  const nextEntry = await editNamedAgentEntry(existingEntry, scope, context);
  const outcome = await confirmAgentConfigSave({
    context: saveConfirmContextForWorkflowRole(row),
    prompts: context.prompts,
  });
  if (
    outcome === "save-original" ||
    outcome === "save-as-one-off" ||
    outcome === "detach-one-off"
  ) {
    await writeWorkflowRole(scope, row, nextEntry, context);
  } else if (outcome === "create-new-agent" || outcome === "save-as-new-permanent-agent") {
    const name = (await context.prompts.text("New agent name")).trim();
    assertAgentName(name, "New agent name is required.");
    await writeNamedAgent(scope, name, nextEntry, context);
    await writeWorkflowRole(scope, row, [{ ref: name }], context);
  }
}

async function readWorkflowRoleEntry(
  scope: WorkflowRegistryScope,
  row: InteractiveWorkflowRoleRow,
  context: CliCommandContext,
): Promise<AgentEntryItems> {
  const config = await readRawStepKitConfigFile(configPathForScope(scope, context));
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
    throw new CliUsageError("stepkit agents requires prompts for interactive mode.");
  }
  const outcome = await confirmAgentConfigSave({
    context: saveConfirmContextForWorkflowRole(row),
    prompts: context.prompts,
  });
  if (outcome !== "save-original") {
    return;
  }
  const configPath = configPathForScope(scope, context);
  const config = await readRawStepKitConfigFile(configPath);
  const workflows = toMutableRecord(config.workflows);
  const workflowConfig = toMutableRecord(workflows[row.workflowId]);
  const workflowAgents = toMutableRecord(workflowConfig.agents);
  delete workflowAgents[row.roleName];
  workflows[row.workflowId] = { ...workflowConfig, agents: workflowAgents };
  await writeRawStepKitConfigFile(configPath, { ...config, workflows });
}

async function editReferencedNamedAgent(
  row: InteractiveWorkflowRoleRow,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<void> {
  if (context.prompts === undefined || row.ref === undefined) {
    throw new CliUsageError("stepkit agents requires prompts for interactive mode.");
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
    await writeNamedAgent(targetScope, row.ref, configured, context);
  } else if (outcome === "create-new-agent") {
    const name = (await context.prompts.text("New agent name")).trim();
    assertAgentName(name, "New agent name is required.");
    await writeNamedAgent(scope, name, configured, context);
    await writeWorkflowRole(scope, row, [{ ref: name }], context);
  } else if (outcome === "detach-one-off") {
    await writeWorkflowRole(scope, row, configured, context);
  }
}

async function readNamedAgentEntry(
  scope: WorkflowRegistryScope,
  name: string,
  context: CliCommandContext,
): Promise<AgentEntryItems> {
  const config = await readRawStepKitConfigFile(configPathForScope(scope, context));
  return readAgentEntryItems(toMutableRecord(config.agents)[name]);
}

async function editNamedAgentEntry(
  entry: AgentEntryItems,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<AgentEntryItems> {
  if (context.prompts === undefined) {
    throw new CliUsageError("stepkit agents requires prompts for interactive mode.");
  }

  let current = entry;
  for (;;) {
    const items = current;
    if (items.length === 0) {
      const configured = await configureLiteralAgentTarget({
        prompts: context.prompts,
        providerChoices: PROVIDER_CHOICES,
      });
      return [{ ...configured.target }];
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
      return current;
    }
    if (action === "Add item") {
      current = await addItemToEntry(current, context);
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
    });
    current = editAgentEntryItem(current, itemIndex, { ...configured.target });
  }
}

async function addItemToEntry(
  entry: AgentEntryItems,
  context: CliCommandContext,
): Promise<AgentEntryItems> {
  if (context.prompts === undefined) {
    throw new CliUsageError("stepkit agents requires prompts for interactive mode.");
  }
  const choice = await context.prompts.select("Add item", ["Pick existing agent", "Create new"]);
  if (choice === "Pick existing agent") {
    const names = await listNamedAgentChoices(context);
    const ref = await context.prompts.select("Named agent", names);
    return addAgentEntryItem(entry, { ref });
  }
  const configured = await configureLiteralAgentTarget({
    prompts: context.prompts,
    providerChoices: PROVIDER_CHOICES,
  });
  return addAgentEntryItem(entry, { ...configured.target });
}

async function editRefItemInPlace(
  entry: AgentEntryItems,
  itemIndex: number,
  ref: string,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<AgentEntryItems> {
  if (context.prompts === undefined) {
    throw new CliUsageError("stepkit agents requires prompts for interactive mode.");
  }
  const targetScope = await findNamedAgentScope(ref, context);
  const existingEntry = await readNamedAgentEntry(targetScope, ref, context);
  const nextRefEntry = await editNamedAgentEntry(existingEntry, targetScope, context);
  const outcome = await confirmAgentConfigSave({
    context: { kind: "named-agent-edit", name: ref },
    prompts: context.prompts,
  });
  if (outcome === "save-original") {
    await writeNamedAgent(targetScope, ref, nextRefEntry, context);
    return entry;
  }
  if (outcome === "create-new-agent") {
    const newName = (await context.prompts.text("New agent name")).trim();
    assertAgentName(newName, "New agent name is required.");
    await writeNamedAgent(scope, newName, nextRefEntry, context);
    return editAgentEntryItem(entry, itemIndex, { ref: newName });
  }
  return entry;
}

async function findNamedAgentScope(
  name: string,
  context: CliCommandContext,
): Promise<WorkflowRegistryScope> {
  for (const scope of ["local", "project", "global"] as const) {
    const config = await readRawStepKitConfigFile(configPathForScope(scope, context));
    if (name in toMutableRecord(config.agents)) {
      return scope;
    }
  }
  throw new CliUsageError(`Agent ${name} does not exist in any config scope.`);
}

async function listNamedAgentChoices(context: CliCommandContext): Promise<readonly string[]> {
  const names = new Set<string>(RESERVED_AGENT_NAMES);
  for (const scope of ["local", "project", "global"] as const) {
    const config = await readRawStepKitConfigFile(configPathForScope(scope, context));
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
): Promise<void> {
  const configPath = configPathForScope(scope, context);
  const config = await readRawStepKitConfigFile(configPath);
  const agents = toMutableRecord(config.agents);
  agents[name] = entry;
  await writeRawStepKitConfigFile(configPath, { ...config, agents });
  context.io.writeLine(`Wrote agent ${name} to ${configPath}.`);
}

async function writeWorkflowRole(
  scope: WorkflowRegistryScope,
  row: InteractiveWorkflowRoleRow,
  entry: AgentEntryItems,
  context: CliCommandContext,
): Promise<void> {
  const configPath = configPathForScope(scope, context);
  const config = await readRawStepKitConfigFile(configPath);
  const workflows = toMutableRecord(config.workflows);
  const workflowConfig = toMutableRecord(workflows[row.workflowId]);
  const workflowAgents = toMutableRecord(workflowConfig.agents);
  workflowAgents[row.roleName] = entry;
  workflows[row.workflowId] = { ...workflowConfig, agents: workflowAgents };
  await writeRawStepKitConfigFile(configPath, { ...config, workflows });
  context.io.writeLine(`Wrote workflow ${row.workflowId} role ${row.roleName} to ${configPath}.`);
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
  if (label === "Local") {
    return "local";
  }
  if (label === "Project") {
    return "project";
  }
  if (label === "Global") {
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
      "stepkit agents requires --scope local, --scope project, or --scope global.",
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
