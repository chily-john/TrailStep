import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultRunsRoot, readRunEvents } from "../artifacts/run-storage.js";
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
    if (!entry.isDirectory() || entry.name === ".archive") {
      continue;
    }

    const runId = entry.name;
    const runDir = join(runsRoot, runId);

    try {
      summaries.push(
        await summarizeReadableRun({ runId, runDir, events: await readRunEvents(runDir) }),
      );
    } catch (error) {
      summaries.push({
        runId,
        runDir,
        status: "unknown",
        warning: `Warning: Could not read run ${runId}: ${readErrorMessage(error)}`,
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
    trackWarning = `Warning: Could not read track summary for run ${options.runId}: ${readErrorMessage(error)}`;
  }
  const trackFields = {
    ...(track === undefined ? {} : { track }),
    ...(trackWarning === undefined ? {} : { trackWarning }),
  };
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
  };
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
        warning: `Warning: Could not read archived run manifest ${entry.name}: ${readErrorMessage(error)}`,
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

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
