import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { readDashboardRunEvents } from "./events";

export interface DashboardRunSummary {
  readonly runId: string;
  readonly path: string;
  readonly status: "running" | "completed" | "failed" | "unknown";
  readonly latestTimestamp?: string;
}

export async function listRuns(options: { readonly cwd: string }): Promise<DashboardRunSummary[]> {
  const runsRoot = join(options.cwd, ".stepkit", "runs");
  let entries: Dirent<string>[];

  try {
    entries = await readdir(runsRoot, { encoding: "utf8", withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<DashboardRunSummary> => {
        const runDir = join(runsRoot, entry.name);
        const events = await readDashboardRunEvents(runDir);
        const latestEvent = events.at(-1);

        return {
          runId: entry.name,
          path: runDir,
          status: statusFromEventType(latestEvent?.type),
          ...(latestEvent ? { latestTimestamp: latestEvent.timestamp } : {}),
        };
      }),
  );

  return runs.sort(compareRunsByLatestTimestampDescending);
}

function statusFromEventType(type: string | undefined): DashboardRunSummary["status"] {
  switch (type) {
    case "workflow.completed":
      return "completed";
    case "workflow.failed":
    case "step.failed":
      return "failed";
    case undefined:
      return "unknown";
    default:
      return "running";
  }
}

function compareRunsByLatestTimestampDescending(
  left: DashboardRunSummary,
  right: DashboardRunSummary,
): number {
  return (right.latestTimestamp ?? "").localeCompare(left.latestTimestamp ?? "");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
