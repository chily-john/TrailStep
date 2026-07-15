#!/usr/bin/env node

import type { Event, InteractiveProcessRunner, WorkingAgentProcessRunner } from "@stepkit/core";
import { type CliCommandContext, CliUsageError, usageText } from "./internals/command.types.js";
import { resolveCommand } from "./internals/command-registry.js";
import { CliInputError } from "./internals/commands/run/load-run-input.js";
import { runCommand } from "./internals/commands/run/run-command.js";
import type { InputSource } from "./internals/commands/run/run-command.types.js";
import { CliConfigError } from "./internals/config/config.js";
import { parseWorkflowId } from "./internals/workflow-reference/workflow-reference.js";
import type { WorkflowReference } from "./internals/workflow-reference/workflow-reference.types.js";

export { CliInputError, loadJsonInput } from "./internals/commands/run/load-run-input.js";
export type { InputSource } from "./internals/commands/run/run-command.types.js";
export { CliConfigError, loadStepKitConfig } from "./internals/config/config.js";
export { type DiscoveredWorkflow, discoverWorkflows } from "./internals/discovery/discovery.js";
export type { WorkflowReference } from "./internals/workflow-reference/workflow-reference.types.js";
export { CliUsageError, parseWorkflowId, usageText };

export type ParsedStepkitCommand =
  | { kind: "list" }
  | {
      kind: "run";
      workflowId: string;
      workflowRunName: string;
      workflow: WorkflowReference;
      input?: InputSource;
    };

/**
 * Parses raw CLI argv into a discriminated command description.
 *
 * @deprecated Kept for backward compatibility. New CLI behavior should be added via
 * `internals/command-registry.ts` and its `CliCommand` implementations.
 */
export function parseStepkitArgs(args: readonly string[]): ParsedStepkitCommand {
  if (args.length === 1 && args[0] === "list") {
    return { kind: "list" };
  }
  const runArgs = runCommand.parseArgs(args);
  return { kind: "run", ...runArgs };
}

declare const process:
  | {
      argv: string[];
      exitCode?: number;
      cwd: () => string;
    }
  | undefined;

export interface StepkitCliIo {
  writeLine: (line: string) => void;
  writeError: (line: string) => void;
}

export interface StepkitMainOptions {
  argv?: readonly string[];
  cwd?: string;
  io?: Partial<StepkitCliIo>;
  eventSink?: (event: Event) => void | Promise<void>;
  processRunner?: InteractiveProcessRunner;
  workingAgentProcessRunner?: WorkingAgentProcessRunner;
}

export async function main(options: StepkitMainOptions = {}): Promise<number> {
  const argv = options.argv ?? process?.argv.slice(2) ?? [];
  const io: StepkitCliIo = {
    writeLine: options.io?.writeLine ?? console.log,
    writeError: options.io?.writeError ?? console.error,
  };
  const cwd = options.cwd ?? process?.cwd() ?? ".";

  const context: CliCommandContext = {
    cwd,
    io,
    eventSink: options.eventSink,
    processRunner: options.processRunner,
    workingAgentProcessRunner: options.workingAgentProcessRunner,
  };

  try {
    const command = resolveCommand(argv);
    const args = command.parseArgs(argv);
    return await command.run(args, context);
  } catch (error) {
    if (
      error instanceof CliUsageError ||
      error instanceof CliInputError ||
      error instanceof CliConfigError
    ) {
      io.writeError(error.message);
      return 1;
    }

    throw error;
  }
}

export function runStepkitCli(writeLine: (line: string) => void = console.log): Promise<number> {
  return main({ io: { writeLine } });
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/?([A-Za-z]:)/u, "/$1");
}

const invokedScriptPath = process?.argv[1];

if (
  invokedScriptPath &&
  normalizePath(import.meta.url).endsWith(normalizePath(invokedScriptPath))
) {
  void main().then((exitCode) => {
    if (process) {
      process.exitCode = exitCode;
    }
  });
}
