import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Event, LatestUnresolvedFailure } from "@stepkit/core";
import { readRunEvents, selectLatestUnresolvedFailure } from "@stepkit/core";
import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";

type RunSummaryStatus = "active" | "completed" | "failed" | "unknown";

interface RunSummary {
  readonly runId: string;
  readonly runDir: string;
  readonly status: RunSummaryStatus;
  readonly workflowId?: string;
  readonly lastTimestamp?: string;
  readonly latestFailure?: LatestUnresolvedFailure;
  readonly warning?: string;
}

export const runsCommand: CliCommand<void> = {
  name: "runs",
  parseArgs(argv) {
    if (argv.length !== 1 || argv[0] !== "runs") {
      throw new CliUsageError("Usage: stepkit runs");
    }
  },
  async run(_args, context) {
    const summaries = await listCommandRunSummaries({ cwd: context.cwd });
    const activeRuns = summaries.filter((summary) => summary.status === "active");
    const recentFailedRuns = selectRecentFailedRunSummaries(summaries);

    writeSection(context, "Active runs:", activeRuns);
    writeSection(context, "Recent failed runs (last 7 days):", recentFailedRuns);
    writeSection(context, "All runs:", summaries);

    for (const warning of summaries.flatMap((summary) =>
      summary.warning ? [summary.warning] : [],
    )) {
      context.io.writeError(warning);
    }

    return 0;
  },
};

async function listCommandRunSummaries(options: { readonly cwd: string }): Promise<RunSummary[]> {
  const runsRoot = join(options.cwd, ".stepkit", "runs");

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

function selectRecentFailedRunSummaries(summaries: readonly RunSummary[]): RunSummary[] {
  const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;

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
      runId: options.runId,
      runDir: options.runDir,
      status: "completed",
      workflowId,
      lastTimestamp: lastEvent?.timestamp,
    };
  }

  if (latestFailure) {
    return {
      runId: options.runId,
      runDir: options.runDir,
      status: "failed",
      workflowId: latestFailure.workflowId,
      lastTimestamp: latestFailure.event.timestamp,
      latestFailure,
    };
  }

  return {
    runId: options.runId,
    runDir: options.runDir,
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

function writeSection(
  context: CliCommandContext,
  heading: string,
  summaries: readonly RunSummary[],
): void {
  context.io.writeLine(heading);

  if (summaries.length === 0) {
    context.io.writeLine("  (none)");
    return;
  }

  for (const summary of summaries) {
    context.io.writeLine(`  - ${formatRunSummary(summary)}`);
  }
}

function formatRunSummary(summary: RunSummary): string {
  const fields = [
    `${summary.runId} [${summary.status}]`,
    summary.workflowId,
    summary.lastTimestamp,
    formatFailureContext(summary),
  ].filter(Boolean);

  return fields.join(" | ");
}

function formatFailureContext(summary: RunSummary): string | undefined {
  const failure = summary.latestFailure;
  if (!failure) {
    return undefined;
  }

  const failureMessage = readFailureMessage(failure.event.payload.failure);
  return [failure.stepId ? `step ${failure.stepId}` : failure.event.type, failureMessage]
    .filter(Boolean)
    .join(": ");
}

function newestFirst(left: RunSummary, right: RunSummary): number {
  const leftTime = left.lastTimestamp ? Date.parse(left.lastTimestamp) : Number.NEGATIVE_INFINITY;
  const rightTime = right.lastTimestamp
    ? Date.parse(right.lastTimestamp)
    : Number.NEGATIVE_INFINITY;
  return rightTime - leftTime || left.runId.localeCompare(right.runId);
}

function readFailureMessage(failure: unknown): string | undefined {
  if (!isPlainObject(failure)) {
    return undefined;
  }

  const message = failure.message;
  return typeof message === "string" && message ? message : undefined;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
