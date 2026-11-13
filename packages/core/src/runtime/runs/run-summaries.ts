import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isFailureLikeError } from "../../contracts/failures/failure.js";
import { errorMessage, isNodeError, isPlainObject } from "../../json/guards.js";
import {
  defaultRunsRoot,
  isReservedRunsRootEntry,
  readRunEvents,
} from "../artifacts/run-storage.js";
import {
  findLifecycleCycleStartIndex,
  findLifecycleTerminalEvent,
} from "../events/lifecycle-cycle.js";
import {
  classifyRunState,
  type RunStateClassification,
  type TrackStateSignal,
} from "../evidence/classify-run-state.js";
import type { LatestUnresolvedFailure } from "../retry/latest-unresolved-failure.js";
import { selectLatestUnresolvedFailure } from "../retry/latest-unresolved-failure.js";
import type { Event } from "../run-workflow/run-workflow.types.js";
import type { TrackSummary } from "./track-summary.js";
import { readTrackSummary } from "./track-summary.js";

export type RunSummaryStatus =
  | "active"
  | "completed"
  | "failed"
  | "cancelled"
  | "archived"
  | "stale"
  | "unknown";

export interface RunSummary {
  readonly runId: string;
  readonly runDir: string;
  readonly status: RunSummaryStatus;
  readonly workflowId?: string;
  readonly lastTimestamp?: string;
  readonly latestFailure?: LatestUnresolvedFailure;
  readonly track?: TrackSummary;
  readonly trackWarning?: string;
  readonly warning?: string;
  /** True when the track still says "running" but its owner process is gone. */
  readonly stale?: boolean;
}

export async function listRunSummaries(options: {
  readonly cwd: string;
  readonly runsRoot?: string;
}): Promise<RunSummary[]> {
  const runsRoot = options.runsRoot ?? defaultRunsRoot(options.cwd);

  let entries: Dirent[];
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const summaries: RunSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || isReservedRunsRootEntry(entry.name)) {
      continue;
    }

    const runId = entry.name;
    const runDir = join(runsRoot, runId);

    try {
      summaries.push(
        await summarizeReadableRun({
          runId,
          runDir,
          events: await readRunEventsOrEmpty(runDir),
        }),
      );
    } catch (error) {
      summaries.push({
        runId,
        runDir,
        status: "unknown",
        warning: `Warning: Could not read run ${runId}: ${errorMessage(error)}`,
      });
    }
  }

  summaries.push(...(await listArchivedRunSummaries(runsRoot)));

  return summaries.sort(newestFirst);
}

export function selectRecentFailedRunSummaries(
  summaries: readonly RunSummary[],
  options: { readonly now?: Date } = {},
): RunSummary[] {
  const cutoffMs = (options.now ?? new Date()).getTime() - 7 * 24 * 60 * 60 * 1000;

  return summaries
    .filter((summary) => {
      // Status is a projection of the run state, not the failure record: a
      // waiting or stale run that recorded an unresolved failure must still be
      // discoverable under "Recent failed runs" while its status stays honest.
      if (!summary.latestFailure) {
        return false;
      }

      const failureTime = Date.parse(summary.latestFailure.event.timestamp);
      return Number.isFinite(failureTime) && failureTime >= cutoffMs;
    })
    .sort(newestFirst)
    .slice(0, 10);
}

export function newestFirst(left: RunSummary, right: RunSummary): number {
  return (
    compareTimestampDescending(left.lastTimestamp, right.lastTimestamp) ||
    left.runId.localeCompare(right.runId)
  );
}

async function summarizeReadableRun(options: {
  readonly runId: string;
  readonly runDir: string;
  readonly events: readonly Event[];
}): Promise<RunSummary> {
  let track: TrackSummary | undefined;
  let trackWarning: string | undefined;
  try {
    track = await readTrackSummary(options);
  } catch (error) {
    trackWarning = `Warning: Could not read track summary for run ${options.runId}: ${errorMessage(error)}`;
  }
  const trackFields = {
    ...(track === undefined ? {} : { track }),
    ...(trackWarning === undefined ? {} : { trackWarning }),
  };

  if (options.events.length === 0) {
    return await summarizeEventlessRun(options, track, trackFields);
  }

  // A reopened run is judged only by its current lifecycle cycle. Both the
  // terminal status and the unresolved failure must come from that window: an
  // old cycle's failure would otherwise make a resumed running run look failed
  // even after `workflow.resumed` / `workflow.retryStarted`.
  const cycleStartIndex = findLifecycleCycleStartIndex(options.events);
  const cycleEvents = options.events.slice(cycleStartIndex);
  const unresolvedFailure = selectLatestUnresolvedFailure(options.events, {
    fromIndex: cycleStartIndex,
  });
  // An interrupted `step.started` is retry metadata, not a recorded failure. A
  // live run must not be summarized as failed merely because its current step
  // has not finished yet; only an actual failed event becomes latestFailure.
  const latestFailure =
    unresolvedFailure !== undefined &&
    (unresolvedFailure.event.type === "step.failed" ||
      unresolvedFailure.event.type === "workflow.failed")
      ? unresolvedFailure
      : undefined;
  const terminalStatus = findLifecycleTerminalEvent(cycleEvents)?.state;
  const lastEvent = options.events.at(-1);
  const workflowId =
    lastEvent?.workflowId ?? options.events.find((event) => event.workflowId)?.workflowId;

  if (terminalStatus === "completed" || terminalStatus === "cancelled") {
    return {
      ...options,
      ...trackFields,
      status: terminalStatus,
      workflowId,
      lastTimestamp: lastEvent?.timestamp,
    };
  }

  if (terminalStatus === "failed") {
    return {
      ...options,
      ...trackFields,
      status: "failed",
      workflowId: latestFailure?.workflowId ?? workflowId,
      lastTimestamp: latestFailure?.event.timestamp ?? lastEvent?.timestamp,
      ...(latestFailure === undefined ? {} : { latestFailure }),
    };
  }

  // Every other eventful run projects the one canonical classifier, so a
  // recorded `step.failed` is failure detail (latestFailure) and never decides
  // the run state: a live or wait-parked run must not look terminal.
  const classification = await classifyRunState({
    runDir: options.runDir,
    events: options.events,
    ...(track === undefined ? {} : { trackSignal: trackSignalFromSummary(track) }),
  });

  return {
    ...options,
    ...trackFields,
    status: projectSummaryStatus(classification.state),
    workflowId,
    lastTimestamp: lastEvent?.timestamp,
    ...(latestFailure === undefined ? {} : { latestFailure }),
    ...orphanedTrackFields(track),
    ...staleProjectionFields(options.runId, track, classification),
  };
}

/**
 * An event-less run: a terminal track is the only durable completion record,
 * so it keeps its status (and storage-lifecycle eligibility). Everything else
 * projects the classifier, which is the only place that decides whether a
 * creation window is active, stale or unknown.
 */
async function summarizeEventlessRun(
  options: {
    readonly runId: string;
    readonly runDir: string;
    readonly events: readonly Event[];
  },
  track: TrackSummary | undefined,
  trackFields: { readonly track?: TrackSummary; readonly trackWarning?: string },
): Promise<RunSummary> {
  if (track !== undefined && isTerminalTrackStatus(track.status)) {
    return {
      ...options,
      ...trackFields,
      ...summarizeEventlessTrack(track),
      ...(await trackTimestampFields(options.runDir)),
    };
  }

  const classification = await classifyRunState({
    runDir: options.runDir,
    events: options.events,
    ...(track === undefined ? {} : { trackSignal: trackSignalFromSummary(track) }),
  });

  return {
    ...options,
    ...trackFields,
    status: projectSummaryStatus(classification.state),
    ...(classification.workflowId === undefined ? {} : { workflowId: classification.workflowId }),
    ...(track === undefined ? {} : await trackTimestampFields(options.runDir)),
    ...orphanedTrackFields(track),
    ...staleProjectionFields(options.runId, track, classification),
  };
}

function isTerminalTrackStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** Pass the already-read track to the classifier instead of re-reading track.json. */
function trackSignalFromSummary(track: TrackSummary): TrackStateSignal {
  return {
    present: true,
    readable: true,
    status: track.status,
    ...(track.ownerPid === undefined ? {} : { ownerPid: track.ownerPid }),
    ...(track.workflowId === undefined ? {} : { workflowId: track.workflowId }),
  };
}

/** Summary vocabulary: a wait-parked run is still live to a run summary. */
function projectSummaryStatus(state: RunStateClassification["state"]): RunSummaryStatus {
  switch (state) {
    case "waiting":
    case "active":
      return "active";
    case "stale":
      return "stale";
    case "unknown":
      return "unknown";
    case "completed":
    case "failed":
    case "cancelled":
      return state;
  }
}

/**
 * The classifier can see a stale owner that the summary's own track read did
 * not (for example after a read failure); keep the stale flag and use the
 * classifier's reason as the warning in that case.
 */
function staleProjectionFields(
  runId: string,
  track: TrackSummary | undefined,
  classification: RunStateClassification,
): { readonly stale?: true; readonly warning?: string } {
  if (classification.state !== "stale" || orphanedTrackFields(track).stale === true) {
    return {};
  }

  const message = classification.diagnostics.find(
    (diagnostic) => diagnostic.code === "stale-owner",
  )?.message;

  return {
    stale: true,
    ...(message === undefined ? {} : { warning: `Warning: Run ${runId} is orphaned — ${message}` }),
  };
}

/**
 * A run that has not written its first event yet. The creation track is the
 * only durable truth in that window: a live running track is active, a running
 * track whose owner is gone is stale, and a missing/unreadable track stays
 * unknown instead of being guessed from the directory name alone.
 */
function summarizeEventlessTrack(track: TrackSummary | undefined): {
  readonly status: RunSummaryStatus;
  readonly workflowId?: string;
  readonly stale?: true;
  readonly warning?: string;
} {
  if (track === undefined) {
    return { status: "unknown" };
  }

  if (track.status === "completed" || track.status === "failed" || track.status === "cancelled") {
    return {
      status: track.status,
      ...(track.workflowId === undefined ? {} : { workflowId: track.workflowId }),
    };
  }

  const trackWorkflowId = track.workflowId === undefined ? {} : { workflowId: track.workflowId };
  if (track.status === "running") {
    const orphaned = orphanedTrackFields(track);
    return {
      status: orphaned.stale === true ? "stale" : "active",
      ...trackWorkflowId,
      ...orphaned,
    };
  }

  // Waiting is still a live run from the summary's perspective; the detailed
  // track carries the exact status. Any other/unreadable status stays unknown.
  if (track.status === "waiting") {
    return { status: "active", ...trackWorkflowId };
  }

  return { status: "unknown", ...trackWorkflowId };
}

/**
 * An event-less run has no event timestamp, so the track's own modification
 * time is the only honest age signal. Terminal tracks need it for storage
 * lifecycle eligibility; active/stale tracks use it for listing order.
 */
async function trackTimestampFields(runDir: string): Promise<{ readonly lastTimestamp?: string }> {
  try {
    const info = await stat(join(runDir, "track.json"));
    return { lastTimestamp: info.mtime.toISOString() };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function readRunEventsOrEmpty(runDir: string): Promise<Event[]> {
  try {
    return await readRunEvents(runDir);
  } catch (error) {
    if (isMissingEventsFileError(error)) {
      return [];
    }
    throw error;
  }
}

function isMissingEventsFileError(error: unknown): boolean {
  return (
    isFailureLikeError(error) &&
    error.failure.code === "resume_target_not_found" &&
    isPlainObject(error.failure.details) &&
    error.failure.details.causeCode === "ENOENT"
  );
}

/**
 * Detects zombie runs: the persisted track still reports "running" but the
 * OS process that owned the run is no longer alive, so nothing will ever
 * finish it. Surfaces as `stale` + a warning instead of a silent active run.
 */
function orphanedTrackFields(track: TrackSummary | undefined): {
  readonly stale?: true;
  readonly warning?: string;
} {
  if (
    track === undefined ||
    track.status !== "running" ||
    track.ownerPid === undefined ||
    isProcessAlive(track.ownerPid)
  ) {
    return {};
  }
  return {
    stale: true,
    warning: `Warning: Run ${track.runId} is orphaned — track still reports running but owner process ${track.ownerPid} is no longer alive.`,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not signalable by this user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function listArchivedRunSummaries(runsRoot: string): Promise<RunSummary[]> {
  const archiveDir = join(runsRoot, ".archive");
  let entries: Dirent[];
  try {
    entries = await readdir(archiveDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const summaries: RunSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".manifest.json")) {
      continue;
    }
    try {
      const manifest = JSON.parse(await readFile(join(archiveDir, entry.name), "utf8")) as {
        readonly runId?: unknown;
        readonly workflowId?: unknown;
        readonly lastTimestamp?: unknown;
      };
      if (typeof manifest.runId === "string") {
        summaries.push({
          runId: manifest.runId,
          runDir: join(archiveDir, `${manifest.runId}.json.gz`),
          status: "archived",
          ...(typeof manifest.workflowId === "string" ? { workflowId: manifest.workflowId } : {}),
          ...(typeof manifest.lastTimestamp === "string"
            ? { lastTimestamp: manifest.lastTimestamp }
            : {}),
        });
      }
    } catch (error) {
      summaries.push({
        runId: entry.name.replace(/\.manifest\.json$/u, ""),
        runDir: join(archiveDir, entry.name),
        status: "unknown",
        warning: `Warning: Could not read archived run manifest ${entry.name}: ${errorMessage(error)}`,
      });
    }
  }
  return summaries;
}

function compareTimestampDescending(left: string | undefined, right: string | undefined): number {
  const leftTime = left ? Date.parse(left) : Number.NEGATIVE_INFINITY;
  const rightTime = right ? Date.parse(right) : Number.NEGATIVE_INFINITY;
  return rightTime - leftTime;
}
