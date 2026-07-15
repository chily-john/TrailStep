import type { CliCommand } from "./command.types.js";
import { listCommand } from "./commands/list/list-command.js";
import { runCommand } from "./commands/run/run-command.js";

/**
 * Resolves the CLI command implementation for a given argv.
 *
 * This is the only file that needs to change to register a new command.
 */
export function resolveCommand(argv: readonly string[]): CliCommand<unknown> {
  if (argv.length === 1 && argv[0] === "list") {
    return listCommand;
  }

  return runCommand;
}
