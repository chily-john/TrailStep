#!/usr/bin/env node

import type { Event, InteractiveProcessRunner, WorkingAgentProcessRunner } from "@stepkit/core";
import {
  type CliCommandContext,
  CliUsageError,
  type PackageCommandRunner,
  type StepkitCliPrompts,
  usageText,
} from "./internals/command.types.js";
import { resolveCommand } from "./internals/command-registry.js";
import { CliInputError } from "./internals/commands/run/load-run-input.js";
import { CliConfigError } from "./internals/config/config.js";
import type { StepKitDeprecationEntry } from "./internals/deprecation-scan/deprecation-scanner.js";
import { parseWorkflowId } from "./internals/workflow-reference/workflow-reference.js";
import { WorkflowResolutionError } from "./internals/workflow-resolution/workflow-resolution-error.js";

export { CliInputError, loadJsonInput } from "./internals/commands/run/load-run-input.js";
export type { InputSource } from "./internals/commands/run/run-command.types.js";
export { CliConfigError, loadStepKitConfig } from "./internals/config/config.js";
export { type DiscoveredWorkflow, discoverWorkflows } from "./internals/discovery/discovery.js";
export type { WorkflowReference } from "./internals/workflow-reference/workflow-reference.types.js";
export { CliUsageError, parseWorkflowId, usageText, WorkflowResolutionError };

declare const process:
  | {
      argv: string[];
      exitCode?: number;
      cwd: () => string;
      env?: Record<string, string | undefined>;
    }
  | undefined;

export interface StepkitCliIo {
  writeLine: (line: string) => void;
  writeError: (line: string) => void;
}

export interface StepkitMainOptions {
  argv?: readonly string[];
  cwd?: string;
  homeDir?: string;
  io?: Partial<StepkitCliIo>;
  eventSink?: (event: Event) => void | Promise<void>;
  env?: Record<string, string | undefined>;
  processRunner?: InteractiveProcessRunner;
  workingAgentProcessRunner?: WorkingAgentProcessRunner;
  runNameClock?: () => Date;
  runNameRandomSuffix?: () => string;
  prompts?: StepkitCliPrompts;
  packageCommandRunner?: PackageCommandRunner;
  deprecationManifest?: readonly StepKitDeprecationEntry[];
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
    homeDir: options.homeDir,
    io,
    prompts: options.prompts ?? createTerminalPrompts(),
    eventSink: options.eventSink,
    env: options.env ?? process?.env ?? {},
    processRunner: options.processRunner,
    workingAgentProcessRunner: options.workingAgentProcessRunner,
    runNameClock: options.runNameClock,
    runNameRandomSuffix: options.runNameRandomSuffix,
    packageCommandRunner: options.packageCommandRunner,
    deprecationManifest: options.deprecationManifest,
  };

  try {
    const command = resolveCommand(argv);
    const args = command.parseArgs(argv);
    return await command.run(args, context);
  } catch (error) {
    if (
      error instanceof CliUsageError ||
      error instanceof CliInputError ||
      error instanceof CliConfigError ||
      error instanceof WorkflowResolutionError
    ) {
      io.writeError(error.message);
      let cause = error.cause;
      while (cause instanceof Error) {
        io.writeError(`Caused by: ${cause.message}`);
        cause = cause.cause;
      }
      return 1;
    }

    throw error;
  }
}

export function runStepkitCli(writeLine: (line: string) => void = console.log): Promise<number> {
  return main({ io: { writeLine } });
}

function createTerminalPrompts(): StepkitCliPrompts {
  return {
    async text(prompt) {
      const { isCancel, text } = await import("@clack/prompts");
      const answer = await text({ message: prompt });
      if (isCancel(answer)) {
        throw new CliUsageError(`Prompt cancelled: ${prompt}.`);
      }
      return String(answer);
    },
    async select(prompt, choices) {
      const { isCancel, select } = await import("@clack/prompts");
      const answer = await select({
        message: prompt,
        options: choices.map((choice) => ({ value: choice, label: choice })),
      });
      if (isCancel(answer)) {
        throw new CliUsageError(`Prompt cancelled: ${prompt}.`);
      }
      return String(answer);
    },
    async multiSelect(prompt, choices) {
      const { isCancel, multiselect } = await import("@clack/prompts");
      const answer = await multiselect({
        message: prompt,
        options: choices.map((choice) => ({ value: choice, label: choice })),
        required: true,
      });
      if (isCancel(answer)) {
        throw new CliUsageError(`Prompt cancelled: ${prompt}.`);
      }
      return answer.map(String);
    },
    async confirm(prompt) {
      const { confirm, isCancel } = await import("@clack/prompts");
      const answer = await confirm({ message: prompt });
      if (isCancel(answer)) {
        throw new CliUsageError(`Prompt cancelled: ${prompt}.`);
      }
      return answer;
    },
  };
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
