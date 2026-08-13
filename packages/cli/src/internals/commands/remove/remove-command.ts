import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import {
  configPathForScope,
  deleteWorkflowRegistryEntryFromConfig,
  listRegisteredWorkflowEntries,
  type RegisteredWorkflowEntry,
  readRawTrailStepConfigFile,
  toMutableWorkflowRegistry,
  type WorkflowRegistryScope,
  writeRawTrailStepConfigFile,
} from "../../workflow-registry/workflow-registry.js";
import {
  cleanupRemovedWorkflowPackageInstall,
  reportRemovedWorkflowPackageInstallCleanup,
} from "../../workflow-packages/package-uninstall.js";
import { warnIfGeneratedSkillDirectoryExists } from "../../workflow-skills/generated-skill-warning.js";

interface RemoveCommandArgs {
  readonly ref: string;
  readonly scope?: WorkflowRegistryScope;
}

const ALL_SCOPES: readonly WorkflowRegistryScope[] = ["local", "project", "global"];

export const removeCommand: CliCommand<RemoveCommandArgs> = {
  name: "remove",
  parseArgs(argv: readonly string[]): RemoveCommandArgs {
    if (argv[0] !== "remove") {
      throw new CliUsageError("Expected remove command.");
    }

    const ref = argv[1];
    if (!ref) {
      throw new CliUsageError("trailstep remove requires <namespace>/<name>.");
    }

    const flags = parseFlags(argv.slice(2));
    const scope = flags.scope;
    if (scope !== undefined && scope !== "local" && scope !== "project" && scope !== "global") {
      throw new CliUsageError(
        "trailstep remove requires --scope local, --scope project, or --scope global.",
      );
    }

    return { ref, ...(scope === undefined ? {} : { scope }) };
  },
  async run(args: RemoveCommandArgs, context: CliCommandContext): Promise<number> {
    const parsed = parseNamespaceNameRef(args.ref);
    if (parsed === undefined) {
      throw new CliUsageError(
        `Invalid workflow ref for trailstep remove: ${args.ref}. Expected <namespace>/<name>.`,
      );
    }

    const candidateScopes: readonly WorkflowRegistryScope[] =
      args.scope !== undefined ? [args.scope] : ALL_SCOPES;

    const matches: WorkflowRegistryScope[] = [];
    for (const scope of candidateScopes) {
      const path = configPathForScope(scope, context);
      const config = await readRawTrailStepConfigFile(path);
      const bucket = toMutableWorkflowRegistry(config.workflows)[parsed.namespace];
      if (bucket?.[parsed.name] !== undefined) {
        matches.push(scope);
      }
    }

    if (matches.length === 0) {
      throw new CliUsageError(
        `Workflow registration not found: ${args.ref}. Checked: ${candidateScopes.join(", ")}.`,
      );
    }
    if (matches.length > 1) {
      throw new CliUsageError(
        `Workflow registration ${args.ref} exists in more than one scope (${matches.join(", ")}). ` +
          "Pass --scope to choose which one to remove.",
      );
    }

    const [scope] = matches as [WorkflowRegistryScope];
    const selectedEntry = await findRegisteredEntry(scope, parsed.namespace, parsed.name, context);
    const path = configPathForScope(scope, context);
    const config = await readRawTrailStepConfigFile(path);
    await writeRawTrailStepConfigFile(
      path,
      deleteWorkflowRegistryEntryFromConfig(config, parsed.namespace, parsed.name),
    );

    context.io.writeLine(`Removed ${args.ref} from ${scope} config.`);
    const cleanupResult =
      selectedEntry === undefined
        ? ({ status: "none" } as const)
        : await cleanupRemovedWorkflowPackageInstall({
            removedEntry: selectedEntry,
            cwd: context.cwd,
            homeDir: context.homeDir,
            packageCommandRunner: context.packageCommandRunner,
          });
    reportRemovedWorkflowPackageInstallCleanup(cleanupResult, context.io);

    await warnIfGeneratedSkillDirectoryExists(context, parsed.namespace, parsed.name);

    return cleanupResult.status === "failed" ? 1 : 0;
  },
};

async function findRegisteredEntry(
  scope: WorkflowRegistryScope,
  namespace: string,
  name: string,
  context: CliCommandContext,
): Promise<RegisteredWorkflowEntry | undefined> {
  const entries = await listRegisteredWorkflowEntries(context);
  return entries.find(
    (entry) => entry.scope === scope && entry.namespace === namespace && entry.name === name,
  );
}

function parseFlags(argv: readonly string[]): Record<string, string | undefined> {
  const flags: Record<string, string | undefined> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== "--scope") {
      throw new CliUsageError(`Unknown option for trailstep remove: ${option ?? ""}`);
    }

    const value = argv[index + 1];
    if (!value) {
      throw new CliUsageError(`Missing value for ${option}.`);
    }

    flags.scope = value;
    index += 1;
  }

  return flags;
}

function parseNamespaceNameRef(
  ref: string,
): { readonly namespace: string; readonly name: string } | undefined {
  const separatorIndex = ref.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === ref.length - 1) {
    return undefined;
  }
  return { namespace: ref.slice(0, separatorIndex), name: ref.slice(separatorIndex + 1) };
}
