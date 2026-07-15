import type { Event, InteractiveProcessRunner, WorkingAgentProcessRunner } from "@stepkit/core";

export const usageText = [
  "Usage:",
  "  stepkit list",
  "  stepkit <package:workflowExport> <workflowRunName> [--input '<json>' | --input-file <path>]",
].join("\n");

export class CliUsageError extends Error {
  constructor(message: string) {
    super(`${message}\n\n${usageText}`);
    this.name = "CliUsageError";
  }
}

export interface StepkitCliIo {
  writeLine: (line: string) => void;
  writeError: (line: string) => void;
}

export interface CliCommandContext {
  cwd: string;
  io: StepkitCliIo;
  eventSink?: (event: Event) => void | Promise<void>;
  processRunner?: InteractiveProcessRunner;
  workingAgentProcessRunner?: WorkingAgentProcessRunner;
}

export interface CliCommand<TArgs> {
  name: string;
  parseArgs(argv: readonly string[]): TArgs;
  run(args: TArgs, context: CliCommandContext): Promise<number>;
}
