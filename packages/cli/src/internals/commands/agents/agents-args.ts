import { CliUsageError } from "../../command-framework/command.types.js";
import type { WorkflowRegistryScope } from "../../workflow-registry/workflow-registry.js";

import { type AgentCommandArgs, THINKING_CHOICES } from "./agents-command.types.js";

export function parseAgentsCommandArgs(argv: readonly string[]): AgentCommandArgs {
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
  if (action === "explain") {
    return parseExplainArgs(argv.slice(2));
  }
  if (action === undefined) {
    return { action: "interactive" };
  }

  throw new CliUsageError(
    "trailstep agents requires set, delete, rename, explain, or no subcommand for interactive mode.",
  );
}

function parseSetArgs(argv: readonly string[]): AgentCommandArgs {
  const [name, ...flagsArgv] = argv;
  assertAgentName(name, "trailstep agents set requires <name>.");
  const flags = parseFlags(flagsArgv, ["--provider", "--model", "--thinking", "--scope"]);
  const scope = parseRequiredScope(
    flags.scope,
    "trailstep agents set requires --scope <local|project|global>.",
  );
  const provider = parseRequiredFlag(
    flags.provider,
    "trailstep agents set requires --provider <provider>.",
  );
  const model = parseOptionalTrimmedFlag(flags.model);
  const thinking = parseThinking(flags.thinking);

  return {
    action: "set",
    name,
    provider,
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
    scope,
  };
}

function parseDeleteArgs(argv: readonly string[]): AgentCommandArgs {
  const [name, ...flagsArgv] = argv;
  assertAgentName(name, "trailstep agents delete requires <name>.");
  const flags = parseFlags(flagsArgv, ["--scope"]);
  return {
    action: "delete",
    name,
    scope: parseRequiredScope(
      flags.scope,
      "trailstep agents delete requires --scope <local|project|global>.",
    ),
  };
}

function parseRenameArgs(argv: readonly string[]): AgentCommandArgs {
  const [oldName, newName, ...flagsArgv] = argv;
  assertAgentName(oldName, "trailstep agents rename requires <old>.");
  assertAgentName(newName, "trailstep agents rename requires <new>.");
  if (oldName === newName) {
    throw new CliUsageError("trailstep agents rename requires different old and new names.");
  }
  const flags = parseFlags(flagsArgv, ["--scope"]);
  return {
    action: "rename",
    oldName,
    newName,
    scope: parseRequiredScope(
      flags.scope,
      "trailstep agents rename requires --scope <local|project|global>.",
    ),
  };
}

function parseExplainArgs(argv: readonly string[]): AgentCommandArgs {
  const [name, ...flagsArgv] = argv;
  assertAgentName(name, "trailstep agents explain requires <name>.");
  const flags = parseFlags(flagsArgv, ["--scope"]);
  if (name.includes("/")) {
    return { action: "explain-workflow", workflowRef: name };
  }
  return {
    action: "explain",
    name,
    scope: parseRequiredScope(
      flags.scope,
      "trailstep agents explain requires --scope <local|project|global>.",
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
      throw new CliUsageError(`Unknown option for trailstep agents: ${option ?? ""}`);
    }

    const value = argv[index + 1];
    if (value === undefined) {
      throw new CliUsageError(`Missing value for ${option}.`);
    }

    flags[option.slice(2)] = value;
    index += 1;
  }

  return flags;
}

export function parseRequiredScope(
  value: string | undefined,
  missingMessage: string,
): WorkflowRegistryScope {
  const scope = parseRequiredFlag(value, missingMessage);
  if (scope !== "local" && scope !== "project" && scope !== "global") {
    throw new CliUsageError(
      "trailstep agents requires --scope local, --scope project, or --scope global.",
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

function parseOptionalTrimmedFlag(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
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

export function assertAgentName(
  value: string | undefined,
  message: string,
): asserts value is string {
  if (value === undefined || value.trim().length === 0 || value.startsWith("--")) {
    throw new CliUsageError(message);
  }
}
