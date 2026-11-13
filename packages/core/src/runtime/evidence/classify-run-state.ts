import { join } from "node:path";

import type { Event } from "../../contracts/events/event.types.js";
import type {
  EvidenceDiagnostic,
  EvidenceExecutionState,
} from "../../contracts/evidence/evidence.types.js";
import { DEFAULT_EVIDENCE_QUERY_LIMITS } from "../../contracts/evidence/run-evidence-query.types.js";
import { isPlainObject } from "../../json/guards.js";
import { listPendingWaits } from "../../runs/wait-events.js";
import {
  findLifecycleTerminalEvent,
  selectCurrentLifecycleCycle,
} from "../events/lifecycle-cycle.js";
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
 * - the current lifecycle cycle's terminal event wins; a run reopened by
 *   `workflow.resumed` or `workflow.retryStarted` is judged by events after
 *   that reopen, not by an earlier cycle's terminal/cancellation;
 * - `workflow.cancelRequested` is cancellation-in-progress, never terminal: no
 *   terminal event has ended the cycle yet. A live owner stays `active`; a
 *   dead owner parked on a wait would discard the request if the wait were
 *   answered, so it is `unknown` with a cancellation-pending diagnostic.
 *   Every other non-terminal outcome appends that diagnostic;
 * - a pending wait in the current cycle is `waiting`, even when the track
 *   owner is gone (an operator answer is the next move, not an orphan) —
 *   unless a cancellation is pending, which must never be reported as an
 *   answerable wait;
 * - a live run lock is `active`, even when `track.json` is missing, unreadable
 *   or unusable, because the lock is direct evidence that a process is driving
 *   the run;
 * - a running track with a dead owner is `stale` + `stale-owner`;
 * - without a live lock, a missing/unreadable track with no terminal event is
 *   `unknown`, never `active`;
 * - an incomplete bounded scan is `unknown` unless a current-cycle terminal
 *   event was seen.
 */

/** Diagnostic appended to any non-terminal outcome while a cancellation is pending. */
const CANCELLATION_PENDING_DIAGNOSTIC: EvidenceDiagnostic = {
  code: "cancellation-pending",
  message: "A cancellation was requested but no terminal event has been recorded.",
};

/** Trap message: a dead run parked on a wait must not be presented as answerable. */
const CANCELLATION_PENDING_TRAP_MESSAGE =
  "Cancellation was requested, but no live owner or terminal event remains, and answering a wait or continuing would discard the request. Finish the cancellation (cancel) or deliberately discard it (continue).";

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
          maxBytes: options.maxTrackBytes ?? DEFAULT_EVIDENCE_QUERY_LIMITS.maxTrackBytes,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        })
      : options.trackSignal;
  const lock =
    options.lock === undefined ? ((await readRunLock(options.runDir)) ?? null) : options.lock;
  const lockLive = lock !== null && isRunLockLive(lock, pidIsAlive);

  // A run that was reopened starts a new lifecycle cycle. Earlier terminal,
  // cancellation and wait events belong to the old cycle and must not decide
  // the current state; the shared helper is the one rule every consumer uses.
  const cycleEvents = selectCurrentLifecycleCycle(options.events);
  const terminal = findLifecycleTerminalEvent(cycleEvents);
  const pendingWaits = listPendingWaits(cycleEvents);
  const cancelRequested = findLastEventOfType(cycleEvents, "workflow.cancelRequested");
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
      diagnostics: appendCancellationPending(
        [
          {
            code: "budget-exceeded",
            message: "The event trail scan was incomplete, so the run state is unknown.",
          },
        ],
        cancelRequested,
      ),
    };
  }

  // A request is not terminal: only the runtime's terminal events end a cycle.
  // A live owner is still driving the run and will act on the request.
  if (cancelRequested !== undefined && lockLive) {
    return {
      ...base,
      state: "active",
      diagnostics: [CANCELLATION_PENDING_DIAGNOSTIC],
    };
  }

  // Without a live owner, a parked wait is a trap: answering it (or continuing)
  // clears the cancellation marker and resumes the run, silently discarding the
  // request. Report an unanswerable crash instead of `waiting`.
  if (
    cancelRequested !== undefined &&
    !lockLive &&
    (pendingWaits.length > 0 || trackSignal?.status === "waiting")
  ) {
    return {
      ...base,
      state: "unknown",
      diagnostics: [
        {
          code: "cancellation-pending",
          message: CANCELLATION_PENDING_TRAP_MESSAGE,
        },
      ],
    };
  }

  if (pendingWaits.length > 0) {
    // A waiting-status track with a dead owner is intentionally neither stale
    // nor flagged: the durable wait is the run's resting state.
    return { ...base, state: "waiting", diagnostics: [] };
  }

  // A live run lock outranks absent or unusable track evidence: the lock is
  // direct evidence that a process is driving the run, while a missing or
  // malformed track may simply be a legacy/partial artifact. Waiting is
  // already handled above from a durable event.
  if (lockLive) {
    return { ...base, state: "active", diagnostics: [] };
  }

  // Only a run without a live lock reaches these guards. Without usable track
  // evidence the state cannot be established, so it stays unknown rather than
  // looking like a fresh failure or a live run.
  if (trackSignal === null || trackSignal.present === false) {
    return {
      ...base,
      state: "unknown",
      diagnostics: appendCancellationPending(
        [
          {
            code: "missing-source",
            message:
              "Track metadata is missing and no terminal event was recorded, so the run state is unknown.",
          },
        ],
        cancelRequested,
      ),
    };
  }

  if (trackSignal.readable === false) {
    return {
      ...base,
      state: "unknown",
      diagnostics: appendCancellationPending(
        [
          {
            code: "unreadable-source",
            message:
              "Track metadata is unreadable and no terminal event was recorded, so the run state is unknown.",
          },
        ],
        cancelRequested,
      ),
    };
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
        diagnostics: appendCancellationPending(
          [
            {
              code: "stale-owner",
              message: "The track still reports running but its owner process is no longer alive.",
            },
          ],
          cancelRequested,
        ),
      };
    }
    return {
      ...base,
      state: "active",
      diagnostics: appendCancellationPending([], cancelRequested),
    };
  }

  return {
    ...base,
    state: "unknown",
    diagnostics: appendCancellationPending(
      [
        {
          code: "partial-coverage",
          message:
            trackSignal.status === undefined
              ? "Track metadata has no status and no terminal event was recorded."
              : `Track status "${trackSignal.status.slice(0, 64)}" has no matching terminal event.`,
        },
      ],
      cancelRequested,
    ),
  };
}

/** Map the canonical classification to the core watch vocabulary. */
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

/** The five public watch states; canonical `unknown` is surfaced as `crashed`. */
export type PublicWatchRunState = Exclude<WatchRunState, "unknown">;

/**
 * Map the canonical classification to the public five-state watch vocabulary.
 *
 * `unknown` becomes `crashed` because the watch will not observe further
 * progress in either case; the MCP crash payload keeps the forensic difference
 * between canonical `unknown` and `stale` in `crash.code`.
 */
export function toPublicWatchRunState(classification: RunStateClassification): PublicWatchRunState {
  const projected = toWatchRunState(classification);
  return projected === "unknown" ? "crashed" : projected;
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

/**
 * Last event of a type within the supplied window. Callers pass the current
 * cycle when the event must not be selected from a superseded cycle.
 */
function findLastEventOfType(events: readonly Event[], type: Event["type"]): Event | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === type) {
      return event;
    }
  }
  return undefined;
}

/**
 * Keep the state-specific diagnostic first and append the pending-cancellation
 * reason, so presentation surfaces can join every message without losing the
 * state reason.
 */
function appendCancellationPending(
  diagnostics: readonly EvidenceDiagnostic[],
  cancelRequested: Event | undefined,
): readonly EvidenceDiagnostic[] {
  return cancelRequested === undefined
    ? diagnostics
    : [...diagnostics, CANCELLATION_PENDING_DIAGNOSTIC];
}
