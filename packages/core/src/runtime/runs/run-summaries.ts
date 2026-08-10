import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { defaultRunsRoot, readRunEvents } from "../artifacts/run-storage.js";
import type { LatestUnresolvedFailure } from "../retry/latest-unresolved-failure.js";
import { selectLatestUnresolvedFailure } from "../retry/latest-unresolved-failure.js";
import type { Event } from "../run-workflow/run-workflow.types.js";

export type RunSummaryStatus = "active" | "completed" | "failed" | "unknown";

export interface RunSummary {
  readonly runId: string;
  readonly runDir: string;
  readonly status: RunSummaryStatus;
  readonly workflowId?: string;
  readonly lastTimestamp?: string;
  readonly latestFailure?: LatestUnresolvedFailure;
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
    if (!entry.isDirectory()) {
      continue;
    }

    const runId = entry.name;
    const runDir = join(runsRoot, runId);

    try {
      summaries.push(summarizeReadableRun({ runId, runDir, events: await readRunEvents(runDir) }));
    } catch (error) {
      summaries.push({
        runId,
        runDir,
        status: "unknown",
        warning: `Warning: Could not read run ${runId}: ${readErrorMessage(error)}`,
      });
    }
  }

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

function summarizeReadableRun(options: {
  readonly runId: string;
  readonly runDir: string;
  readonly events: readonly Event[];
}): RunSummary {
  const latestFailure = selectLatestUnresolvedFailure(options.events);
  const terminalStatus = selectTerminalStatus(options.events);
  const lastEvent = options.events.at(-1);
  const workflowId =
    lastEvent?.workflowId ?? options.events.find((event) => event.workflowId)?.workflowId;

  if (terminalStatus === "completed") {
    return {
      ...options,
      status: "completed",
      workflowId,
      lastTimestamp: lastEvent?.timestamp,
    };
  }

  if (latestFailure) {
    return {
      ...options,
      status: "failed",
      workflowId: latestFailure.workflowId,
      lastTimestamp: latestFailure.event.timestamp,
      latestFailure,
    };
  }

  return {
    ...options,
    status: terminalStatus ?? "active",
    workflowId,
    lastTimestamp: lastEvent?.timestamp,
  };
}

function selectTerminalStatus(events: readonly Event[]): "completed" | "failed" | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "workflow.completed") {
      return "completed";
    }

    if (event?.type === "workflow.failed") {
      return "failed";
    }
  }

  return undefined;
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
