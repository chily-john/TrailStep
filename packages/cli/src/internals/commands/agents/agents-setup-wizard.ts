import {
  addAgentEntryItem,
  editAgentEntryItem,
  removeAgentEntryItem,
  reorderAgentEntryItem,
} from "../../agent-config/agent-entry-items-flow.js";
import { blockDeleteWhenAgentReferrersExist } from "../../agent-config/agent-referrers.js";
import {
  hasConfiguredAgentEntries,
  runAgentSetupWizard,
} from "../../agent-config/agent-setup-wizard.js";
import type { ConfiguredCustomProvider } from "../../agent-config/configure-target-flow.js";
import { configureLiteralAgentTarget } from "../../agent-config/configure-target-flow.js";
import {
  type AgentConfigSaveContext,
  confirmAgentConfigSave,
} from "../../agent-config/save-confirm-flow.js";
import type { CliCommandContext } from "../../command-framework/command.types.js";
import { CliUsageError } from "../../command-framework/command.types.js";
import {
  configPathForScope,
  readRawTrailStepConfigFile,
  type WorkflowRegistryScope,
  writeRawTrailStepConfigFile,
} from "../../workflow-registry/workflow-registry.js";

import { assertAgentName } from "./agents-args.js";
import type {
  AgentEntryEditResult,
  AgentEntryItems,
  InteractiveNamedAgentRow,
  InteractiveWorkflowRoleRow,
} from "./agents-command.types.js";
import {
  customProviderList,
  deleteAgent,
  findNamedAgentScope,
  listNamedAgentChoices,
  readNamedAgentEntry,
  readWorkflowRoleEntry,
  renameAgent,
  writeNamedAgent,
  writeWorkflowRole,
} from "./agents-config.js";
import {
  agentItemSummary,
  buildInteractiveRows,
  scopeForInteractiveLabel,
} from "./agents-listing.js";
import { toMutableRecord } from "./record-utils.js";

const INTERACTIVE_SCOPES = ["local", "project", "global"] as const;
const PROVIDER_CHOICES = ["claude", "codex", "gemini", "pi"] as const;

export async function runInteractiveAgents(context: CliCommandContext): Promise<number> {
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
