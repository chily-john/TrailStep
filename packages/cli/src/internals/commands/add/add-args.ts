import { CliUsageError } from "../../command-framework/command.types.js";

import type { AddCommandArgs } from "./add-command.types.js";

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

  const flags = parseFlags(parsedInvocation.flagArgs);
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
    projectSkill: flags["project-skill"] === "true",
    userSkill: flags["user-skill"] === "true",
    projectSkillExplicit: flags["project-skill"] === "true",
    userSkillExplicit: flags["user-skill"] === "true",
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
  return (
    option === "--scope" ||
    option === "--namespace" ||
    option === "--name" ||
    option === "--workflow"
  );
}

function parseFlags(argv: readonly string[]): Record<string, string | undefined> {
  const flags: Record<string, string | undefined> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--force") {
      flags.force = "true";
      continue;
    }

    if (option === "--yes") {
      flags.yes = "true";
      continue;
    }

    if (option === "--dry-run") {
      flags["dry-run"] = "true";
      continue;
    }

    if (option === "--project-skill" || option === "--user-skill") {
      flags[option.slice(2)] = "true";
      continue;
    }

    if (
      option !== "--scope" &&
      option !== "--namespace" &&
      option !== "--name" &&
      option !== "--workflow"
    ) {
      throw new CliUsageError(`Unknown option for trailstep add: ${option ?? ""}`);
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
