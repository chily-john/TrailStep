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
      if (summary.status !== "failed" || !summary.latestFailure) {
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
    return {
      ...options,
      ...trackFields,
      ...summarizeEventlessTrack(track),
      ...(track === undefined ? {} : await trackTimestampFields(options.runDir)),
    };
  }

  const latestFailure = selectLatestUnresolvedFailure(options.events);
  const terminalStatus = selectTerminalStatus(options.events);
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

  if (latestFailure) {
    return {
      ...options,
      ...trackFields,
      status: "failed",
      workflowId: latestFailure.workflowId,
      lastTimestamp: latestFailure.event.timestamp,
      latestFailure,
    };
  }

  return {
    ...options,
    ...trackFields,
    status: terminalStatus ?? "active",
    workflowId,
    lastTimestamp: lastEvent?.timestamp,
    ...orphanedTrackFields(track),
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
