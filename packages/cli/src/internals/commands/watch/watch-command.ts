import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  classifyRunState,
  DEFAULT_EVIDENCE_QUERY_LIMITS,
  type Event,
  type RunStateClassification,
  readRunEventsSince,
  readTrackStateSignal,
  toPublicWatchRunState,
} from "@trailstep/core";
import type { CliCommand, CliCommandContext } from "../../command-framework/command.types.js";
import { CliUsageError } from "../../command-framework/command.types.js";
import { CliInputError } from "../run/load-run-input.js";
import { createTerminalEventLogger } from "../run/terminal-event-logger.js";
import { resolveRunDirectory } from "../wait-run-helpers.js";

interface WatchCommandArgs {
  readonly runNameOrRunDir: string;
  readonly outputMode: "human" | "json" | "jsonl";
  readonly follow: boolean;
  readonly since: "beginning";
}

const watchPollIntervalMs = 50;
const watchCrashedExitCode = 2;
const watchUnknownExitCode = 3;

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
    const resolved = await resolveRunDirectory(args.runNameOrRunDir, context, {
      access: "inspect",
    });
    const eventsFile = join(resolved.runDir, "events.jsonl");

    try {
      // A published run has a track before it has an events file; only a
      // missing run directory is a lookup failure.
      await access(resolved.runDir, constants.F_OK);
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
    // Read the durable track signal once per watch invocation, matching the MCP
    // watch entry snapshot. The classifier re-reads the run lock on every poll,
    // so liveness changes are still observed without re-reading track.json.
    const trackSignal = await readTrackStateSignal(resolved.runDir, {
      maxBytes: DEFAULT_EVIDENCE_QUERY_LIMITS.maxTrackBytes,
    });
    const observedEvents: Event[] = [];
    let offset = 0;

    while (true) {
      const readState = await readRunEventsSinceOrEmpty(
        resolved.runDir,
        eventsFile,
        offset,
        args.runNameOrRunDir,
        (message) => context.io.writeError(message),
      );
      offset = readState.offset;
      const events = readState.entries.map((entry) => entry.event);
      observedEvents.push(...events);

      for (const event of events) {
        writeEvent(event);
      }

      const classification = await classifyRunState({
        runDir: resolved.runDir,
        events: observedEvents,
        trackSignal,
      });
      const stop = describeWatchStop(classification);
      if (stop !== undefined) {
        if (stop.message !== undefined) {
          // Stop reasons go to stderr so --json/--jsonl stdout stays events-only.
          context.io.writeError(stop.message);
        }
        return stop.exitCode;
      }

      if (!args.follow) {
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

/**
 * Stop where MCP watch stops, and tell the operator why.
 *
 * A plain terminal event and a pending wait are normal stops and stay silent:
 * the event stream and the existing waiting line already said what happened.
 * A waiting track with no pending wait is not a crash, but it is not
 * self-explanatory either, so it gets a line and exit 0. Canonical `stale` and
 * `unknown` are the abnormal cases: they stop with distinct non-zero codes so
 * an operator can tell a crashed run from a finished one. A cancellation
 * request without a terminal event is not terminal; with no live owner it
 * classifies as unknown, so it exits 3 with the joined reason that names both
 * the unknown state and the pending cancellation.
 */
function describeWatchStop(
  classification: RunStateClassification,
): { readonly exitCode: number; readonly message?: string } | undefined {
  const state = toPublicWatchRunState(classification);
  if (state === "started" || state === "in-progress") {
    return undefined;
  }

  if (state === "terminal") {
    return { exitCode: 0 };
  }

  if (state === "waiting") {
    if (classification.pendingWaits.length > 0) {
      return { exitCode: 0 };
    }
    return {
      exitCode: 0,
      message: "Watch stopped: the track reports waiting, but no pending wait exists.",
    };
  }

  const reason = joinedDiagnosticReason(classification);
  if (classification.state === "stale") {
    return {
      exitCode: watchCrashedExitCode,
      message: `Watch stopped: run crashed. ${reason ?? "The run owner is no longer alive."}`,
    };
  }
  return {
    exitCode: watchUnknownExitCode,
    message: `Watch stopped: run state is unknown. ${reason ?? "No live lock or usable track evidence exists."}`,
  };
}

/** Join every diagnostic message so the state reason and a pending cancellation stay visible. */
function joinedDiagnosticReason(classification: RunStateClassification): string | undefined {
  const messages = classification.diagnostics
    .map((diagnostic) => diagnostic.message)
    .filter((message): message is string => message !== undefined && message.length > 0);
  return messages.length === 0 ? undefined : [...new Set(messages)].join(" ");
}

/**
 * Read events since the cursor, treating a not-yet-created trail as empty. A
 * run is published before its first event is appended, so a watch that starts
 * in that window must keep polling instead of failing the invocation. The same
 * `ENOENT` also happens when the run directory is deleted mid-watch; stat the
 * directory so a vanished run fails the invocation instead of polling forever.
 */
async function readRunEventsSinceOrEmpty(
  runDir: string,
  eventsFile: string,
  offset: number,
  displayName: string,
  report: (message: string) => void,
): Promise<Awaited<ReturnType<typeof readRunEventsSince>>> {
  try {
    return await readRunEventsSince(eventsFile, offset, { report });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }

    try {
      await stat(runDir);
    } catch (statError) {
      if (isNodeError(statError) && statError.code === "ENOENT") {
        throw new CliInputError(`Run not found or unreadable: ${displayName} (${eventsFile})`);
      }
      throw statError;
    }

    return { text: "", offset, entries: [] };
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
