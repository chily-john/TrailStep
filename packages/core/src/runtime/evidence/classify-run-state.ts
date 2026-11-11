import { join } from "node:path";

import type { Event } from "../../contracts/events/event.types.js";
import type {
  EvidenceDiagnostic,
  EvidenceExecutionState,
} from "../../contracts/evidence/evidence.types.js";
import { isPlainObject } from "../../json/guards.js";
import { listPendingWaits } from "../../runs/wait-events.js";
import { isPidAlive, isRunLockLive, type RunLock, readRunLock } from "../run-lock/run-lock.js";
import { readBoundedTextFile } from "./bounded-readers.js";

/**
 * The single shared run-state classifier.
 *
 * It is deliberately provider-neutral and side-effect free. MCP watch and CLI
 * observe format the result; they must not re-derive terminal/wait/orphan
 * semantics from their own event scans. The projection is based on parsed
 * events plus three cheap signals:
 *
 * - `run.lock`: a live process is actually driving the run.
 * - `track.json`: the durable scheduler status and owner PID.
 * - pending `wait.started` events: a run parked on a durable wait.
 *
 * State mapping is intentionally conservative:
 * - terminal event wins;
 * - `workflow.cancelRequested` without a terminal event is `cancelled`;
 * - a pending wait is `waiting`, even when the track owner is gone (an
 *   operator answer is the next move, not an orphan);
 * - a live lock is `active`;
 * - a running track with a dead owner is `stale` + `stale-owner`;
 * - a missing/unreadable track without a terminal event is `unknown`, never
 *   `active`;
 * - an incomplete bounded scan is `unknown` unless a terminal event was seen.
 */

export interface TrackStateSignal {
  readonly present: boolean;
  readonly readable: boolean;
  readonly status?: string;
  readonly ownerPid?: number;
  readonly workflowId?: string;
  readonly lastTimestamp?: string;
}

export interface ClassifyRunStateOptions {
  readonly runDir: string;
  readonly events: readonly Event[];
  /** `undefined` reads `track.json`; `null` means the caller knows it is absent. */
  readonly trackSignal?: TrackStateSignal | null;
  /** `undefined` reads `run.lock`; `null` means the caller knows it is absent. */
  readonly lock?: RunLock | null;
  /** True when the bounded event scan reached the end of the trail. */
  readonly eventsComplete?: boolean;
  readonly maxTrackBytes?: number;
  readonly signal?: AbortSignal;
  /** Test seam for pid liveness. */
  readonly pidIsAlive?: (pid: number) => boolean;
}

export interface RunStateClassification {
  readonly state: EvidenceExecutionState;
  readonly diagnostics: readonly EvidenceDiagnostic[];
  readonly terminalEvent?: Event;
  readonly pendingWaits: readonly Event[];
  readonly startedEvent?: Event;
  readonly lastEvent?: Event;
  readonly workflowId?: string;
  readonly startedEventId?: string;
  readonly eventCount: number;
  readonly ownerPid?: number;
  readonly ownerAlive: boolean;
  readonly trackStatus?: string;
}

/** Watch-oriented vocabulary derived from the same classification. */
export type WatchRunState =
  | "started"
  | "in-progress"
  | "waiting"
  | "terminal"
  | "crashed"
  | "unknown";

export async function classifyRunState(
  options: ClassifyRunStateOptions,
): Promise<RunStateClassification> {
  const pidIsAlive = options.pidIsAlive ?? isPidAlive;
  const trackSignal =
    options.trackSignal === undefined
      ? await readTrackStateSignal(options.runDir, {
          maxBytes: options.maxTrackBytes ?? 256 * 1024,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        })
      : options.trackSignal;
  const lock =
    options.lock === undefined ? ((await readRunLock(options.runDir)) ?? null) : options.lock;
  const lockLive = lock !== null && isRunLockLive(lock, pidIsAlive);

  const terminal = findTerminalEvent(options.events);
  const pendingWaits = listPendingWaits(options.events);
  const cancelRequested = findLastEventOfType(options.events, "workflow.cancelRequested");
  const startedEvent = options.events.find((event) => event.type === "workflow.started");
  const lastEvent = options.events.at(-1);
  const ownerPid = trackSignal?.ownerPid ?? lock?.pid;
  const ownerAlive = ownerPid === undefined ? false : pidIsAlive(ownerPid);
  const workflowId =
    terminal?.event.workflowId ??
    startedEvent?.workflowId ??
    trackSignal?.workflowId ??
    lastEvent?.workflowId;

  const base = {
    pendingWaits,
    eventCount: options.events.length,
    ownerPid,
    ownerAlive,
    ...(startedEvent === undefined ? {} : { startedEvent, startedEventId: startedEvent.id }),
    ...(lastEvent === undefined ? {} : { lastEvent }),
    ...(terminal === undefined ? {} : { terminalEvent: terminal.event }),
    ...(workflowId === undefined ? {} : { workflowId }),
    ...(trackSignal?.status === undefined ? {} : { trackStatus: trackSignal.status }),
  } as const;

  if (terminal !== undefined) {
    return { ...base, state: terminal.state, diagnostics: [] };
  }

  if (options.eventsComplete === false) {
    return {
      ...base,
      state: "unknown",
      diagnostics: [
        {
          code: "budget-exceeded",
          message: "The event trail scan was incomplete, so the run state is unknown.",
        },
      ],
    };
  }

  if (cancelRequested !== undefined) {
    return {
      ...base,
      state: "cancelled",
      diagnostics: [
        {
          code: "partial-coverage",
          message: "Cancellation was requested but no terminal event was recorded.",
        },
      ],
    };
  }

  if (pendingWaits.length > 0) {
    // A waiting-status track with a dead owner is intentionally neither stale
    // nor flagged: the durable wait is the run's resting state.
    return { ...base, state: "waiting", diagnostics: [] };
  }

  // A missing/unreadable track can never prove `active`, even if a lock file
  // exists: legacy/partial runs are common enough that "no terminal + no
  // track" must stay unknown rather than look like a fresh failure or a live
  // run. Waiting is already handled above from a durable event.
  if (trackSignal === null || trackSignal.present === false) {
    return {
      ...base,
      state: "unknown",
      diagnostics: [
        {
          code: "missing-source",
          message:
            "Track metadata is missing and no terminal event was recorded, so the run state is unknown.",
        },
      ],
    };
  }

  if (trackSignal.readable === false) {
    return {
      ...base,
      state: "unknown",
      diagnostics: [
        {
          code: "unreadable-source",
          message:
            "Track metadata is unreadable and no terminal event was recorded, so the run state is unknown.",
        },
      ],
    };
  }

  if (lockLive) {
    return { ...base, state: "active", diagnostics: [] };
  }

  if (trackSignal.status === "waiting") {
    // Waiting is not an orphan state even when the recorded owner PID is gone.
    return { ...base, state: "waiting", diagnostics: [] };
  }

  if (trackSignal.status === "running") {
    if (trackSignal.ownerPid !== undefined && pidIsAlive(trackSignal.ownerPid) === false) {
      return {
        ...base,
        state: "stale",
        diagnostics: [
          {
            code: "stale-owner",
            message: "The track still reports running but its owner process is no longer alive.",
          },
        ],
      };
    }
    return { ...base, state: "active", diagnostics: [] };
  }

  return {
    ...base,
    state: "unknown",
    diagnostics: [
      {
        code: "partial-coverage",
        message:
          trackSignal.status === undefined
            ? "Track metadata has no status and no terminal event was recorded."
            : `Track status "${trackSignal.status.slice(0, 64)}" has no matching terminal event.`,
      },
    ],
  };
}

/** Map the canonical classification to the MCP/CLI watch vocabulary. */
export function toWatchRunState(classification: RunStateClassification): WatchRunState {
  switch (classification.state) {
    case "active":
      return classification.eventCount === 0 ? "started" : "in-progress";
    case "waiting":
      return "waiting";
    case "completed":
    case "failed":
    case "cancelled":
      return "terminal";
    case "stale":
      return "crashed";
    case "unknown":
      return "unknown";
  }
}

/**
 * Read only the small scheduler-status subset of `track.json`. Branch files,
 * terminal output, and failure payloads are never loaded here.
 */
export async function readTrackStateSignal(
  runDir: string,
  options: { readonly maxBytes: number; readonly signal?: AbortSignal },
): Promise<TrackStateSignal> {
  const read = await readBoundedTextFile(join(runDir, "track.json"), options);
  if (read.status === "missing") {
    return { present: false, readable: true };
  }
  if (read.status !== "ok" || read.aborted || read.truncated) {
    return { present: true, readable: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { present: true, readable: false };
  }
  if (isPlainObject(parsed) === false) {
    return { present: true, readable: false };
  }

  const status = typeof parsed.status === "string" ? parsed.status : undefined;
  const ownerPid =
    typeof parsed.ownerPid === "number" && Number.isInteger(parsed.ownerPid)
      ? parsed.ownerPid
      : undefined;

  return {
    present: true,
    readable: true,
    ...(status === undefined ? {} : { status }),
    ...(ownerPid === undefined ? {} : { ownerPid }),
    ...(typeof parsed.workflowId === "string" ? { workflowId: parsed.workflowId } : {}),
    ...(typeof parsed.lastTimestamp === "string" ? { lastTimestamp: parsed.lastTimestamp } : {}),
  };
}

function findTerminalEvent(
  events: readonly Event[],
): { readonly state: "completed" | "failed" | "cancelled"; readonly event: Event } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "workflow.completed") {
      return { state: "completed", event };
    }
    if (event?.type === "workflow.failed") {
      return { state: "failed", event };
    }
    if (event?.type === "workflow.cancelled") {
      return { state: "cancelled", event };
    }
  }
  return undefined;
}

function findLastEventOfType(events: readonly Event[], type: Event["type"]): Event | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === type) {
      return event;
    }
  }
  return undefined;
}
