import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import { discoverWorkflows } from "../../discovery/discovery.js";
import { promptSelect, promptText, promptYesNo } from "../../prompts/prompt-helpers.js";
import {
  assertNamespaceMatchesScope,
  assertValidRegistrationName,
  configPathForScope,
  deleteWorkflowRegistryEntryFromConfig,
  findExistingRegistrationScope,
  listRegisteredWorkflowEntries,
  moveWorkflowRegistryEntryInConfig,
  type RegisteredWorkflowEntry,
  readRawTrailStepConfigFile,
  type WorkflowRegistryContext,
  writeRawTrailStepConfigFile,
} from "../../workflow-registry/workflow-registry.js";
import { resolveWorkflowReference } from "../../workflow-resolution/workflow-resolution.js";
import { warnIfGeneratedSkillDirectoryExists } from "../../workflow-skills/generated-skill-warning.js";
import type { WorkflowSkillMetadata } from "../../workflow-skills/workflow-skill-content.js";

type WorkflowsCommandArgs = Record<string, never>;

const SCOPE_HEADINGS: readonly {
  readonly scope: RegisteredWorkflowEntry["scope"];
  readonly heading: string;
}[] = [
  { scope: "local", heading: "local" },
  { scope: "project", heading: "project (shared)" },
  { scope: "global", heading: "global" },
];

const NAMESPACE_PRESETS = ["local", "project", "global"] as const;
const CUSTOM_NAMESPACE_OPTION = "Type a new namespace...";
const REMOVE_OPTION = "Remove";
const BACK_OPTION = "Back to workflow list";
const EXIT_OPTION = "Exit";
const usageHint = "trailstep workflows requires an interactive session.";

type PageBOutcome = "back" | "exit";

export const workflowsCommand: CliCommand<WorkflowsCommandArgs> = {
  name: "workflows",
  parseArgs(argv: readonly string[]): WorkflowsCommandArgs {
    const rest = argv[0] === "workflows" ? argv.slice(1) : argv;
    if (rest.length > 0) {
      throw new CliUsageError(`Unknown option for trailstep workflows: ${rest.join(" ")}`);
    }
    return {};
  },
  async run(_args: WorkflowsCommandArgs, context: CliCommandContext): Promise<number> {
    const registryContext: WorkflowRegistryContext = { cwd: context.cwd, homeDir: context.homeDir };

    for (;;) {
      const entries = await listRegisteredWorkflowEntries(registryContext);
      const discovered = await discoverWorkflows({ cwd: context.cwd });

      if (entries.length === 0) {
        context.io.writeLine("No registered workflows to edit.");
        for (const workflow of discovered) {
          context.io.writeLine(workflow.id);
        }
        return 0;
      }

      for (const { scope, heading } of SCOPE_HEADINGS) {
        printScopeGroup(
          context,
          heading,
          entries.filter((entry) => entry.scope === scope),
        );
      }
      if (discovered.length > 0) {
        context.io.writeLine("");
        context.io.writeLine("Discoverable workflow packages:");
        for (const workflow of discovered) {
          context.io.writeLine(`  ${workflow.id}`);
        }
      }

      const labels = entries.map(
        (entry) => `${entry.scope}: ${entry.namespace}/${entry.name} -> ${entry.targetRef}`,
      );
      const selectedLabel = await promptSelect(
        "Select a workflow to edit",
        labels,
        context.prompts,
        usageHint,
      );
      const selected = entries[labels.indexOf(selectedLabel)];
      if (selected === undefined) {
        throw new CliUsageError(`Invalid selection: ${selectedLabel}`);
      }

      const outcome = await runEntryFlow(selected, context, registryContext);
      if (outcome === "exit") {
        return 0;
      }
    }
  },
};

function printScopeGroup(
  context: CliCommandContext,
  heading: string,
  entries: readonly RegisteredWorkflowEntry[],
): void {
  if (entries.length === 0) {
    return;
  }
  context.io.writeLine(`${heading}:`);
  for (const entry of entries) {
    context.io.writeLine(`  ${entry.namespace}/${entry.name} -> ${entry.targetRef}`);
  }
}

async function runEntryFlow(
  initialSelected: RegisteredWorkflowEntry,
  context: CliCommandContext,
  registryContext: WorkflowRegistryContext,
): Promise<PageBOutcome> {
  let selected = initialSelected;

  for (;;) {
    context.io.writeLine(selected.targetRef);
    context.io.writeLine(dim(await describeWorkflow(selected, context)));
    context.io.writeLine("");

    const namespaceLabel = `Namespace: ${selected.namespace}`;
    const nameLabel = `Name: ${selected.name}`;
    const choice = await promptSelect(
      "Select an action",
      [namespaceLabel, nameLabel, REMOVE_OPTION, BACK_OPTION, EXIT_OPTION],
      context.prompts,
      usageHint,
    );

    if (choice === BACK_OPTION) {
      return "back";
    }
    if (choice === EXIT_OPTION) {
      return "exit";
    }
    if (choice === REMOVE_OPTION) {
      const removed = await removeSelectedEntry(selected, context, registryContext);
      if (removed) {
        return "back";
      }
      continue;
    }

    const updated =
      choice === namespaceLabel
        ? await editNamespace(selected, context, registryContext)
        : await editName(selected, context, registryContext);
    if (updated !== undefined) {
      selected = updated;
    }
  }
}

async function describeWorkflow(
  entry: RegisteredWorkflowEntry,
  context: CliCommandContext,
): Promise<string> {
  try {
    const resolved = await resolveWorkflowReference(`${entry.namespace}/${entry.name}`, {
      cwd: context.cwd,
      homeDir: context.homeDir,
    });
    const description = (resolved?.workflow as WorkflowSkillMetadata | undefined)?.description;
    return description ?? "(no description)";
  } catch {
    return "(no description)";
  }
}

function dim(text: string): string {
  return `\x1b[2m${text}\x1b[22m`;
}

async function removeSelectedEntry(
  selected: RegisteredWorkflowEntry,
  context: CliCommandContext,
  registryContext: WorkflowRegistryContext,
): Promise<boolean> {
  const confirmed = await promptYesNo(
    `Remove ${selected.scope}: ${selected.namespace}/${selected.name}? This cannot be undone.`,
    context.prompts,
    "Confirmation required.",
  );
  if (!confirmed) {
    context.io.writeLine("Cancelled.");
    return false;
  }

  const path = configPathForScope(selected.scope, registryContext);
  const config = await readRawTrailStepConfigFile(path);
  await writeRawTrailStepConfigFile(
    path,
    deleteWorkflowRegistryEntryFromConfig(config, selected.namespace, selected.name),
  );

  context.io.writeLine(
    `Removed ${selected.namespace}/${selected.name} from ${selected.scope} config.`,
  );
  await warnIfGeneratedSkillDirectoryExists(context, selected.namespace, selected.name);
  return true;
}

async function editNamespace(
  selected: RegisteredWorkflowEntry,
  context: CliCommandContext,
  registryContext: WorkflowRegistryContext,
): Promise<RegisteredWorkflowEntry | undefined> {
  const namespaceChoice = await promptSelect(
    "New namespace",
    [...NAMESPACE_PRESETS, CUSTOM_NAMESPACE_OPTION],
    context.prompts,
    usageHint,
  );
  const newNamespace =
    namespaceChoice === CUSTOM_NAMESPACE_OPTION
      ? await promptText("New namespace", undefined, context.prompts, "New namespace is required.")
      : namespaceChoice;

  return applyRename(selected, newNamespace, selected.name, context, registryContext);
}

async function editName(
  selected: RegisteredWorkflowEntry,
  context: CliCommandContext,
  registryContext: WorkflowRegistryContext,
): Promise<RegisteredWorkflowEntry | undefined> {
  const newName = await promptText("New name", undefined, context.prompts, "New name is required.");
  return applyRename(selected, selected.namespace, newName, context, registryContext);
}

async function applyRename(
  selected: RegisteredWorkflowEntry,
  newNamespace: string,
  newName: string,
  context: CliCommandContext,
  registryContext: WorkflowRegistryContext,
): Promise<RegisteredWorkflowEntry | undefined> {
  assertValidRegistrationName(newName);
  assertNamespaceMatchesScope(newNamespace, selected.scope);

  const isRenamingInPlace = newNamespace === selected.namespace && newName === selected.name;
  if (isRenamingInPlace) {
    return selected;
  }

  const collisionScope = await findExistingRegistrationScope(
    newNamespace,
    newName,
    selected.scope,
    registryContext,
  );

  if (collisionScope !== undefined) {
    const overwrite = await promptYesNo(
      `${newNamespace}/${newName} already exists in ${collisionScope} config. Overwrite?`,
      context.prompts,
      "Confirmation required.",
    );
    if (!overwrite) {
      context.io.writeLine("Cancelled.");
      return undefined;
    }
  }

  const path = configPathForScope(selected.scope, context);
  const config = await readRawTrailStepConfigFile(path);
  await writeRawTrailStepConfigFile(
    path,
    moveWorkflowRegistryEntryInConfig(
      config,
      selected.namespace,
      selected.name,
      newNamespace,
      newName,
      selected.targetRef,
    ),
  );

  context.io.writeLine(
    `Renamed ${selected.scope}: ${selected.namespace}/${selected.name} -> ${newNamespace}/${newName}`,
  );

  return {
    scope: selected.scope,
    namespace: newNamespace,
    name: newName,
    targetRef: selected.targetRef,
  };
}
