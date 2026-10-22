import {
  addAgentEntryItem,
  editAgentEntryItem,
  removeAgentEntryItem,
  reorderAgentEntryItem,
} from "../../agent-config/agent-entry-items-flow.js";
import { blockDeleteWhenAgentReferrersExist } from "../../agent-config/agent-referrers.js";
import type { ConfiguredCustomProvider } from "../../agent-config/configure-target-flow.js";
import { configureLiteralAgentTarget } from "../../agent-config/configure-target-flow.js";
import { confirmAgentConfigSave } from "../../agent-config/save-confirm-flow.js";
import type { CliCommandContext } from "../../command-framework/command.types.js";
import { CliUsageError } from "../../command-framework/command.types.js";
import type { WorkflowRegistryScope } from "../../workflow-registry/workflow-registry.js";

import { assertAgentName } from "./agents-args.js";
import type {
  AgentEntryEditResult,
  AgentEntryItems,
  InteractiveNamedAgentRow,
} from "./agents-command.types.js";
import {
  customProviderList,
  deleteAgent,
  findNamedAgentScope,
  listNamedAgentChoices,
  readNamedAgentEntry,
  renameAgent,
  writeNamedAgent,
} from "./agents-config.js";
import { agentItemSummary } from "./agents-listing.js";
import { PROVIDER_CHOICES } from "./agents-provider-choices.js";

/** Creates a new named agent and stores it in the given scope. */
export async function createNamedAgent(
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

/** Runs the edit/rename/delete menu of an existing named agent. */
export async function editNamedAgent(
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

/**
 * Interactive editor for the items of one agent entry: add, edit, remove and
 * reorder the provider targets of a single named agent.
 */
export async function editNamedAgentEntry(
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
