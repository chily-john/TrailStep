import { join } from "node:path";

import { listRunSummaries, type RunSummaryStatus } from "@trailstep/core";

export interface DashboardRunSummary {
  readonly runId: string;
  readonly path: string;
  readonly status: RunSummaryStatus;
  readonly latestTimestamp?: string;
}

/**
 * The dashboard is a projection of core run summaries, not a second status
 * classifier: an event-less run gets exactly the active/stale/unknown status
 * the CLI and core report for the same track.
 */
export async function listRuns(options: { readonly cwd: string }): Promise<DashboardRunSummary[]> {
  const runsRoot = join(options.cwd, ".trailstep", "runs");
  const summaries = await listRunSummaries({ cwd: options.cwd, runsRoot });

  return summaries
    .filter((summary) => summary.status !== "archived")
    .map(
      (summary): DashboardRunSummary => ({
        runId: summary.runId,
        path: summary.runDir,
        status: summary.status,
        ...(summary.lastTimestamp === undefined ? {} : { latestTimestamp: summary.lastTimestamp }),
      }),
    )
    .sort(compareRunsByLatestTimestampDescending);
}

function compareRunsByLatestTimestampDescending(
  left: DashboardRunSummary,
  right: DashboardRunSummary,
): number {
  return (
    (right.latestTimestamp ?? "").localeCompare(left.latestTimestamp ?? "") ||
    left.runId.localeCompare(right.runId)
  );
}
