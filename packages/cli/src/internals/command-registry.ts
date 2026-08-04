import type { CliCommand } from "./command.types.js";
import { addCommand } from "./commands/add/add-command.js";
import { agentsCommand } from "./commands/agents/agents-command.js";
import { cancelCommand } from "./commands/cancel/cancel-command.js";
import { continueCommand } from "./commands/continue/continue-command.js";
import { doctorCommand } from "./commands/doctor/doctor-command.js";
import { initCommand } from "./commands/init/init-command.js";
import { removeCommand } from "./commands/remove/remove-command.js";
import { retryCommand } from "./commands/retry/retry-command.js";
import { runCommand } from "./commands/run/run-command.js";
import { runsCommand } from "./commands/runs/runs-command.js";
import { skillCheckCommand } from "./commands/skill-check/skill-check-command.js";
import { updateCommand } from "./commands/update/update-command.js";
import { workflowsCommand } from "./commands/workflows/workflows-command.js";

/**
 * Resolves the CLI command implementation for a given argv.
 *
 * This is the only file that needs to change to register a new command.
 */
export function resolveCommand(argv: readonly string[]): CliCommand<unknown> {
  if (argv[0] === "add") {
    return addCommand;
  }

  if (argv[0] === "remove") {
    return removeCommand;
  }

  if (argv[0] === "init") {
    return initCommand;
  }

  if (argv[0] === "agents") {
    return agentsCommand;
  }

  if (argv[0] === "workflows") {
    return workflowsCommand;
  }

  if (argv[0] === "retry") {
    return retryCommand;
  }

  if (argv[0] === "runs") {
    return runsCommand;
  }

  if (argv.length === 1 && argv[0] === "skill-check") {
    return skillCheckCommand;
  }

  if (argv[0] === "continue") {
    return continueCommand;
  }

  if (argv[0] === "cancel") {
    return cancelCommand;
  }

  if (argv[0] === "update") {
    return updateCommand;
  }

  if (argv[0] === "doctor") {
    return doctorCommand;
  }

  return runCommand;
}
