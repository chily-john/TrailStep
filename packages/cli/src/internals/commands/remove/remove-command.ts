import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import {
  configPathForScope,
  deleteWorkflowRegistryEntry,
  readRawStepKitConfigFile,
  toMutableWorkflowRegistry,
  type WorkflowRegistryScope,
  writeRawStepKitConfigFile,
} from "../../workflow-registry/workflow-registry.js";
import { workflowSkillName } from "../../workflow-skills/workflow-skill-content.js";

interface RemoveCommandArgs {
  readonly ref: string;
  readonly scope?: WorkflowRegistryScope;
}

const ALL_SCOPES: readonly WorkflowRegistryScope[] = ["project-local", "project", "user"];

export const removeCommand: CliCommand<RemoveCommandArgs> = {
  name: "remove",
  parseArgs(argv: readonly string[]): RemoveCommandArgs {
    if (argv[0] !== "remove") {
      throw new CliUsageError("Expected remove command.");
    }

    const ref = argv[1];
    if (!ref) {
      throw new CliUsageError("stepkit remove requires <namespace>/<name>.");
    }

    const flags = parseFlags(argv.slice(2));
    const scope = flags.scope;
    if (
      scope !== undefined &&
      scope !== "project" &&
      scope !== "project-local" &&
      scope !== "user"
    ) {
      throw new CliUsageError(
        "stepkit remove requires --scope project, --scope project-local, or --scope user.",
      );
    }

    return { ref, ...(scope === undefined ? {} : { scope }) };
  },
  async run(args: RemoveCommandArgs, context: CliCommandContext): Promise<number> {
    const parsed = parseNamespaceNameRef(args.ref);
    if (parsed === undefined) {
      throw new CliUsageError(
        `Invalid workflow ref for stepkit remove: ${args.ref}. Expected <namespace>/<name>.`,
      );
    }

    const candidateScopes: readonly WorkflowRegistryScope[] =
      args.scope !== undefined ? [args.scope] : ALL_SCOPES;

    const matches: WorkflowRegistryScope[] = [];
    for (const scope of candidateScopes) {
      const path = configPathForScope(scope, context);
      const config = await readRawStepKitConfigFile(path);
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
    const path = configPathForScope(scope, context);
    const config = await readRawStepKitConfigFile(path);
    const workflows = deleteWorkflowRegistryEntry(
      toMutableWorkflowRegistry(config.workflows),
      parsed.namespace,
      parsed.name,
    );
    await writeRawStepKitConfigFile(path, { ...config, workflows });

    context.io.writeLine(`Removed ${args.ref} from ${scope} config.`);

    const skillDirectory = join(
      context.cwd,
      ".stepkit",
      "skills",
      workflowSkillName(parsed.namespace, parsed.name),
    );
    if (await pathExists(skillDirectory)) {
      context.io.writeError(
        `Note: skill directory ${skillDirectory} was not removed; delete it manually if desired.`,
      );
    }

    return 0;
  },
};

function parseFlags(argv: readonly string[]): Record<string, string | undefined> {
  const flags: Record<string, string | undefined> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== "--scope") {
      throw new CliUsageError(`Unknown option for stepkit remove: ${option ?? ""}`);
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
