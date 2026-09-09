import type { Event } from "@trailstep/core";
import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import {
  findLatestPendingWait,
  readEventsForRun,
  resolveRunDirectory,
} from "../wait-run-helpers.js";

interface OutputCommandArgs {
  readonly runNameOrRunDir: string;
  readonly json: boolean;
  readonly field?: string;
}

export const outputCommand: CliCommand<OutputCommandArgs> = {
  name: "output",
  parseArgs(argv) {
    if (argv.length < 2 || argv[0] !== "output") {
      throw new CliUsageError(
        "Usage: trailstep output <runNameOrRunDir> [--json] [--field <path>]",
      );
    }

    const runNameOrRunDir = argv[1];
    let json = false;
    let field: string | undefined;

    for (let index = 2; index < argv.length; index += 1) {
      const option = argv[index];
      if (option === "--json") {
        json = true;
        continue;
      }

      if (option === "--field") {
        const value = argv[index + 1];
        if (!value) {
          throw new CliUsageError("Missing value for --field.");
        }
        field = value;
        index += 1;
        continue;
      }

      throw new CliUsageError(`Unknown option: ${option ?? ""}`);
    }

    return { runNameOrRunDir: runNameOrRunDir as string, json, ...(field ? { field } : {}) };
  },
  async run(args: OutputCommandArgs, context: CliCommandContext): Promise<number> {
    const resolved = await resolveRunDirectory(args.runNameOrRunDir, context);
    const events = await readEventsForRun(resolved.runDir);
    const completed = findFinalOutputEvent(events);

    if (!completed) {
      context.io.writeError(
        `No final workflow output found for ${resolved.displayName}; run status is ${describeRunStatus(events)}.`,
      );
      return 1;
    }

    let value: unknown = completed.payload.output;
    if (args.field !== undefined) {
      const fieldValue = readField(value, args.field);
      if (!fieldValue.found) {
        context.io.writeError(`Final workflow output has no field: ${args.field}.`);
        return 1;
      }
      value = fieldValue.value;
    }

    context.io.writeLine(formatOutputValue(value, args.json || args.field === undefined));
    return 0;
  },
};

function findFinalOutputEvent(events: readonly Event[]): Event | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "workflow.completed" && "output" in event.payload) {
      return event;
    }
  }
  return undefined;
}

function describeRunStatus(events: readonly Event[]): string {
  const latestTerminal = [...events]
    .reverse()
    .find((event) => event.type === "workflow.failed" || event.type === "workflow.completed");
  if (latestTerminal?.type === "workflow.failed") {
    return "failed";
  }
  if (findLatestPendingWait(events)) {
    return "waiting";
  }
  return "not completed";
}

function readField(
  value: unknown,
  path: string,
): { readonly found: true; readonly value: unknown } | { readonly found: false } {
  let current = value;
  for (const segment of path.split(".")) {
    if (!isPlainObject(current) || !(segment in current)) {
      return { found: false };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

function formatOutputValue(value: unknown, json: boolean): string {
  if (json) {
    return JSON.stringify(value, null, 2);
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
