import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { type Event, readRunEventsSince } from "@trailstep/core";
import type { CliCommand, CliCommandContext } from "../../command-framework/command.types.js";
import { CliUsageError } from "../../command-framework/command.types.js";
import { createTerminalEventLogger } from "../run/terminal-event-logger.js";
import { findLatestPendingWait, resolveRunDirectory } from "../wait-run-helpers.js";

interface WatchCommandArgs {
  readonly runNameOrRunDir: string;
  readonly outputMode: "human" | "json" | "jsonl";
  readonly follow: boolean;
  readonly since: "beginning";
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
      const readState = await readRunEventsSince(eventsFile, offset, {
        report: (message) => context.io.writeError(message),
      });
      offset = readState.offset;
      const events = readState.entries.map((entry) => entry.event);
      observedEvents.push(...events);

      for (const event of events) {
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
