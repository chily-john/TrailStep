import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  type CancellationMarker,
  type Event,
  readCancellationMarker,
  writeCancellationMarker,
} from "@trailstep/core";

import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliInputError } from "../run/load-run-input.js";
import {
  findLatestPendingWait,
  readEventsForRun,
  resolveRunDirectory,
} from "../wait-run-helpers.js";
import type { CancelCommandArgs } from "./cancel-command.types.js";
import { parseCancelInvocation } from "./parse-cancel-invocation.js";

export const cancelCommand: CliCommand<CancelCommandArgs> = {
  name: "cancel",
  parseArgs: parseCancelInvocation,
  async run(args, context) {
    if (args.runNameOrRunDir !== undefined) {
      return await cancelWorkflowRun(args.runNameOrRunDir, args.reason, context);
    }

    return await cancelInteractiveSession(args, context);
  },
};

async function cancelWorkflowRun(
  runNameOrRunDir: string,
  reason: string | undefined,
  context: CliCommandContext,
): Promise<number> {
  const resolvedRun = await resolveRunDirectory(runNameOrRunDir, context);
  const events = await readEventsForRun(resolvedRun.runDir);
  const displayName = basename(resolvedRun.runDir);
  const terminalStatus = selectTerminalStatus(events);

  if (terminalStatus === "completed" || terminalStatus === "failed") {
    context.io.writeLine(`Run already completed: ${displayName}`);
    return 0;
  }

  if (terminalStatus === "cancelled" || (await readCancellationMarker(resolvedRun.runDir))) {
    context.io.writeLine(`Run already cancelled: ${displayName}`);
    return 0;
  }

  const { marker } = await writeCancellationMarker({
    runDir: resolvedRun.runDir,
    ...(reason === undefined ? {} : { reason }),
    source: "cli",
  });
  await appendCancellationEvent({
    runDir: resolvedRun.runDir,
    events,
    marker,
    type: "workflow.cancelRequested",
  });

  const pendingWait = findLatestPendingWait(events);
  if (pendingWait?.stepId !== undefined) {
    await appendCancellationEvent({
      runDir: resolvedRun.runDir,
      events,
      marker,
      type: "step.cancelled",
      stepId: pendingWait.stepId,
    });
    await appendCancellationEvent({
      runDir: resolvedRun.runDir,
      events,
      marker,
      type: "workflow.cancelled",
    });
  }

  context.io.writeLine(`Cancellation requested: ${displayName}`);
  return 0;
}

async function cancelInteractiveSession(
  args: CancelCommandArgs,
  context: CliCommandContext,
): Promise<number> {
  const interactiveFile = context.env?.TRAILSTEP_INTERACTIVE_FILE;
  if (!interactiveFile) {
    throw new CliInputError(
      "TRAILSTEP_INTERACTIVE_FILE is required to cancel an active interactive TrailStep session.",
    );
  }

  const protocol = await loadActiveInteractiveSession(interactiveFile);
  await safeWriteJson(interactiveFile, {
    ...protocol,
    status: "cancelled",
    ...(args.reason === undefined ? {} : { reason: args.reason }),
  });
  context.io.writeLine("Interactive session cancelled.");
  return 0;
}

async function appendCancellationEvent(options: {
  readonly runDir: string;
  readonly events: readonly Event[];
  readonly marker: CancellationMarker;
  readonly type: "workflow.cancelRequested" | "workflow.cancelled" | "step.cancelled";
  readonly stepId?: string;
}): Promise<void> {
  const anchor = options.events.at(-1);
  const workflowId =
    anchor?.workflowId ?? options.events.find((event) => event.workflowId)?.workflowId ?? "";
  const runId =
    anchor?.runId ?? options.events.find((event) => event.runId)?.runId ?? basename(options.runDir);

  const event: Event = {
    id: `event-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    runId,
    workflowId,
    ...(options.stepId === undefined ? {} : { stepId: options.stepId }),
    type: options.type,
    timestamp: new Date().toISOString(),
    schemaVersion: "v0",
    payload: {
      ...(options.marker.requestedAt === undefined
        ? {}
        : { requestedAt: options.marker.requestedAt }),
      ...(options.marker.reason === undefined ? {} : { reason: options.marker.reason }),
      ...(options.marker.source === undefined ? {} : { source: options.marker.source }),
    },
  };

  await appendFile(join(options.runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

function selectTerminalStatus(
  events: readonly Event[],
): "completed" | "failed" | "cancelled" | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "workflow.completed") {
      return "completed";
    }
    if (event?.type === "workflow.failed") {
      return "failed";
    }
    if (event?.type === "workflow.cancelled") {
      return "cancelled";
    }
  }

  return undefined;
}

async function loadActiveInteractiveSession(
  interactiveFile: string,
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(interactiveFile, "utf8"));
  } catch (error) {
    throw new CliInputError(`Unable to read active interactive session: ${interactiveFile}`, {
      cause: error,
    });
  }

  if (!isPlainObject(parsed)) {
    throw new CliInputError("Active interactive session file must contain a JSON object.");
  }

  if (parsed.status !== "active") {
    throw new CliInputError("Active interactive session is not active.");
  }

  return parsed;
}

async function safeWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
