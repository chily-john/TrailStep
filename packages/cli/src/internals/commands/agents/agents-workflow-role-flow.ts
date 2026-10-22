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
import type { InteractiveWorkflowRoleRow } from "./agents-command.types.js";
import {
  findNamedAgentScope,
  listNamedAgentChoices,
  readNamedAgentEntry,
  readWorkflowRoleEntry,
  writeNamedAgent,
  writeWorkflowRole,
} from "./agents-config.js";
import { editNamedAgentEntry } from "./agents-named-agent-flow.js";
import { PROVIDER_CHOICES } from "./agents-provider-choices.js";
import { toMutableRecord } from "./record-utils.js";

/** Runs the action menu of a workflow role row. */
export async function editWorkflowRole(
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
