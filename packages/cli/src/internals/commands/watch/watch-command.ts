import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { Event } from "@trailstep/core";

import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import { createTerminalEventLogger } from "../run/terminal-event-logger.js";
import { findLatestPendingWait, resolveRunDirectory } from "../wait-run-helpers.js";

interface WatchCommandArgs {
  readonly runNameOrRunDir: string;
  readonly outputMode: "human" | "json" | "jsonl";
  readonly follow: boolean;
  readonly since: "beginning";
}

interface EventReadState {
  readonly offset: number;
  readonly events: readonly Event[];
}

const watchPollIntervalMs = 50;

export const watchCommand: CliCommand<WatchCommandArgs> = {
  name: "watch",
  parseArgs(argv) {
    if (argv.length < 2 || argv[0] !== "watch") {
      throw new CliUsageError(
        "Usage: trailstep watch <runNameOrRunDir> [--json | --jsonl] [--since beginning] [--follow | --no-follow]",
      );
    }

    const runNameOrRunDir = argv[1];
    let outputMode: WatchCommandArgs["outputMode"] = "human";
    let follow = true;
    let since: WatchCommandArgs["since"] = "beginning";

    for (let index = 2; index < argv.length; index += 1) {
      const option = argv[index];
      if (option === "--json" || option === "--jsonl") {
        const requestedMode = option === "--json" ? "json" : "jsonl";
        if (outputMode !== "human" && outputMode !== requestedMode) {
          throw new CliUsageError("Use only one of --json or --jsonl.");
        }
        outputMode = requestedMode;
        continue;
      }

      if (option === "--since") {
        const value = argv[index + 1];
        if (!value) {
          throw new CliUsageError("Missing value for --since.");
        }
        if (value !== "beginning") {
          throw new CliUsageError("Unsupported --since value. Supported values: beginning.");
        }
        since = value;
        index += 1;
        continue;
      }

      if (option === "--follow") {
        follow = true;
        continue;
      }

      if (option === "--no-follow") {
        follow = false;
        continue;
      }

      throw new CliUsageError(`Unknown option: ${option ?? ""}`);
    }

    return { runNameOrRunDir: runNameOrRunDir as string, outputMode, follow, since };
  },
  async run(args, context) {
    const resolved = await resolveRunDirectory(args.runNameOrRunDir, context);
    const eventsFile = join(resolved.runDir, "events.jsonl");

    try {
      await access(eventsFile, constants.F_OK);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        context.io.writeError(
          `Run not found or unreadable: ${args.runNameOrRunDir} (${eventsFile})`,
        );
        return 1;
      }
      throw error;
    }

    const writeEvent = createWatchEventWriter(args.outputMode, context);
    const observedEvents: Event[] = [];
    let offset = 0;

    while (true) {
      const readState = await readEventsSince(eventsFile, offset);
      offset = readState.offset;
      observedEvents.push(...readState.events);

      for (const event of readState.events) {
        writeEvent(event);
      }

      if (shouldStopWatching(observedEvents) || !args.follow) {
        return 0;
      }

      await sleep(watchPollIntervalMs);
    }
  },
};

function createWatchEventWriter(
  outputMode: WatchCommandArgs["outputMode"],
  context: CliCommandContext,
): (event: Event) => void {
  if (outputMode === "json" || outputMode === "jsonl") {
    return (event) => context.io.writeLine(JSON.stringify(event));
  }

  return createTerminalEventLogger(context.io);
}

async function readEventsSince(eventsFile: string, offset: number): Promise<EventReadState> {
  const buffer = await readFile(eventsFile);
  if (buffer.length < offset) {
    return readEventsSince(eventsFile, 0);
  }

  const text = buffer.subarray(offset).toString("utf8");
  const lastLineBreakIndex = text.lastIndexOf("\n");
  if (lastLineBreakIndex === -1) {
    return { offset, events: [] };
  }

  const completeText = text.slice(0, lastLineBreakIndex + 1);
  const events = parseCompleteEventLines(completeText, eventsFile);
  return {
    offset: offset + Buffer.byteLength(completeText, "utf8"),
    events,
  };
}

function parseCompleteEventLines(completeText: string, eventsFile: string): readonly Event[] {
  const events: Event[] = [];
  const lines = completeText.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }

    try {
      events.push(JSON.parse(line) as Event);
    } catch {
      throw new CliUsageError(`Unable to parse event JSONL in ${eventsFile}: line ${index + 1}.`);
    }
  }

  return events;
}

function shouldStopWatching(events: readonly Event[]): boolean {
  return events.some(isTerminalEvent) || findLatestPendingWait(events) !== undefined;
}

function isTerminalEvent(event: Event): boolean {
  const eventType = readEventType(event);
  return (
    eventType === "workflow.completed" ||
    eventType === "workflow.failed" ||
    eventType === "workflow.cancelled"
  );
}

function readEventType(event: Event): string {
  return event.type;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
