import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import { discoverWorkflows } from "../../discovery/discovery.js";
import { promptSelect, promptText, promptYesNo } from "../../prompts/prompt-helpers.js";
import {
  assertNamespaceMatchesScope,
  assertValidRegistrationName,
  configPathForScope,
  deleteWorkflowRegistryEntry,
  findExistingRegistrationScope,
  listRegisteredWorkflowEntries,
  type RegisteredWorkflowEntry,
  readRawStepKitConfigFile,
  toMutableWorkflowRegistry,
  writeRawStepKitConfigFile,
} from "../../workflow-registry/workflow-registry.js";

interface ListCommandArgs {
  readonly edit: boolean;
}

const SCOPE_HEADINGS: readonly {
  readonly scope: RegisteredWorkflowEntry["scope"];
  readonly heading: string;
}[] = [
  { scope: "project-local", heading: "Project (local)" },
  { scope: "project", heading: "Project (shared)" },
  { scope: "user", heading: "User" },
];

export const listCommand: CliCommand<ListCommandArgs> = {
  name: "list",
  parseArgs(argv: readonly string[]): ListCommandArgs {
    const rest = argv[0] === "list" ? argv.slice(1) : argv;
    if (rest.length === 0) {
      return { edit: false };
    }
    if (rest.length === 1 && rest[0] === "--edit") {
      return { edit: true };
    }
    throw new CliUsageError(`Unknown option for stepkit list: ${rest.join(" ")}`);
  },
  async run(args: ListCommandArgs, context: CliCommandContext): Promise<number> {
    if (args.edit) {
      return runEditFlow(context);
    }

    const registered = await listRegisteredWorkflowEntries({
      cwd: context.cwd,
      homeDir: context.homeDir,
    });

    for (const { scope, heading } of SCOPE_HEADINGS) {
      printScopeGroup(
        context,
        heading,
        registered.filter((entry) => entry.scope === scope),
      );
    }

    const discovered = await discoverWorkflows({ cwd: context.cwd });
    if (discovered.length > 0) {
      if (registered.length === 0) {
        // No registered entries to disambiguate from — keep the plain, unheaded id list
        // that stepkit list has always printed for this case.
        for (const workflow of discovered) {
          context.io.writeLine(workflow.id);
        }
      } else {
        context.io.writeLine("");
        context.io.writeLine("Discoverable workflow packages:");
        for (const workflow of discovered) {
          context.io.writeLine(`  ${workflow.id}`);
        }
      }
    }

    return 0;
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

async function runEditFlow(context: CliCommandContext): Promise<number> {
  const registryContext = { cwd: context.cwd, homeDir: context.homeDir };
  const entries = await listRegisteredWorkflowEntries(registryContext);
  if (entries.length === 0) {
    context.io.writeLine("No registered workflows to edit.");
    return 0;
  }

  const usageHint = "stepkit list --edit requires an interactive session.";
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

  const newNamespace = await promptText(
    "New namespace",
    undefined,
    context.prompts,
    "New namespace is required.",
  );
  const newName = await promptText("New name", undefined, context.prompts, "New name is required.");

  assertValidRegistrationName(newName);
  assertNamespaceMatchesScope(newNamespace, selected.scope);

  const collisionScope = await findExistingRegistrationScope(
    newNamespace,
    newName,
    selected.scope,
    registryContext,
  );
  const isRenamingInPlace = newNamespace === selected.namespace && newName === selected.name;

  if (collisionScope !== undefined && !isRenamingInPlace) {
    const overwrite = await promptYesNo(
      `${newNamespace}/${newName} already exists in ${collisionScope} config. Overwrite?`,
      context.prompts,
      "Confirmation required.",
    );
    if (!overwrite) {
      context.io.writeLine("Cancelled.");
      return 0;
    }
  }

  const path = configPathForScope(selected.scope, context);
  const config = await readRawStepKitConfigFile(path);
  let workflows = toMutableWorkflowRegistry(config.workflows);
  workflows = deleteWorkflowRegistryEntry(workflows, selected.namespace, selected.name);
  workflows[newNamespace] = { ...workflows[newNamespace], [newName]: selected.targetRef };
  await writeRawStepKitConfigFile(path, { ...config, workflows });

  context.io.writeLine(
    `Renamed ${selected.scope}: ${selected.namespace}/${selected.name} -> ${newNamespace}/${newName}`,
  );
  return 0;
}
