import { CliUsageError } from "../../command-framework/command.types.js";
import { parseCommandFlags } from "../../command-framework/flags.js";

import type { AddCommandArgs } from "./add-command.types.js";

const ADD_BOOLEAN_FLAGS: readonly string[] = ["--force", "--yes", "--dry-run"];

const ADD_VALUE_FLAGS: readonly string[] = ["--scope", "--namespace", "--name", "--workflow"];

interface SplitAddSourceAndFlagArgsResult {
  readonly source?: string;
  readonly flagArgs: readonly string[];
}

export function parseAddCommandArgs(argv: readonly string[]): AddCommandArgs {
  if (argv[0] !== "add") {
    throw new CliUsageError("Expected add command.");
  }

  const parsedInvocation = splitAddSourceAndFlagArgs(argv.slice(1));
  if (parsedInvocation.source === undefined) {
    throw new CliUsageError(
      "trailstep add requires a workflow file, bundle path, bundle package, npm package spec, or GitHub package spec.",
    );
  }

  const flags = parseCommandFlags(parsedInvocation.flagArgs, {
    commandLabel: "trailstep add",
    booleanFlags: ADD_BOOLEAN_FLAGS,
    valueFlags: ADD_VALUE_FLAGS,
  });
  const scope = flags.scope;
  if (scope !== undefined && scope !== "local" && scope !== "project" && scope !== "global") {
    throw new CliUsageError(
      "trailstep add requires --scope local, --scope project, or --scope global.",
    );
  }

  return {
    source: parsedInvocation.source,
    ...(scope === undefined ? {} : { scope }),
    ...(flags.namespace === undefined ? {} : { namespace: flags.namespace }),
    ...(flags.name === undefined ? {} : { name: flags.name }),
    workflow: flags.workflow,
    force: flags.force === "true",
    yes: flags.yes === "true",
    dryRun: flags["dry-run"] === "true",
  };
}

function splitAddSourceAndFlagArgs(argv: readonly string[]): SplitAddSourceAndFlagArgsResult {
  let source: string | undefined;
  const flagArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (source === undefined && token.startsWith("--")) {
      flagArgs.push(token);
      if (isAddOptionWithValue(token)) {
        const value = argv[index + 1];
        if (value !== undefined) {
          flagArgs.push(value);
          index += 1;
        }
      }
      continue;
    }

    if (source === undefined) {
      source = token;
      continue;
    }

    flagArgs.push(token);
  }

  return source === undefined ? { flagArgs } : { source, flagArgs };
}

function isAddOptionWithValue(option: string): boolean {
  return ADD_VALUE_FLAGS.includes(option);
}
