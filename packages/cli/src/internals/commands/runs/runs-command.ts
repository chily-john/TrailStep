import type { RunSummary } from "@trailstep/core";
import { listRunSummaries, selectRecentFailedRunSummaries } from "@trailstep/core";
import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import { resolveRunsRoot } from "../../runs-root.js";

export const runsCommand: CliCommand<{ readonly json: boolean }> = {
  name: "runs",
  parseArgs(argv) {
    if (argv[0] !== "runs" || (argv.length !== 1 && !(argv.length === 2 && argv[1] === "--json"))) {
      throw new CliUsageError("Usage: trailstep runs [--json]");
    }
    return { json: argv[1] === "--json" };
  },
  async run(args, context) {
    const summaries = await listRunSummaries({
      cwd: context.cwd,
      runsRoot: resolveRunsRoot(context),
    });
    if (args.json) {
      context.io.writeLine(JSON.stringify(summaries));
      return 0;
    }

    const activeRuns = summaries.filter((summary) => summary.status === "active");
    const recentFailedRuns = selectRecentFailedRunSummaries(summaries);

    writeSection(context, "Active runs:", activeRuns);
    writeSection(context, "Recent failed runs (last 7 days):", recentFailedRuns);
    writeSection(context, "All runs:", summaries);

    for (const warning of summaries.flatMap((summary) =>
      [summary.warning, summary.trackWarning].filter((value): value is string => value !== undefined),
    )) {
      context.io.writeError(warning);
    }

    return 0;
  },
};

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
    formatTrackContext(summary),
  ].filter(Boolean);

  return fields.join(" | ");
}

function formatTrackContext(summary: RunSummary): string | undefined {
  const track = summary.track;
  if (track === undefined) {
    return undefined;
  }

  const counts = new Map<string, number>();
  for (const branch of track.branches) {
    const status = branch.status ?? "unknown";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const countText = [...counts.entries()]
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
  const interestingBranches = track.branches.filter(
    (branch) => branch.status === "failed" || branch.status === "waiting" || branch.output !== undefined,
  );
  const branchText = interestingBranches
    .map((branch) => {
      const details = [
        branch.branchId,
        branch.status,
        readFailureMessage(branch.failure),
        branch.latestMessage,
      ].filter(Boolean);
      return details.join(" ");
    })
    .join("; ");

  return [`track ${track.status}`, countText, branchText].filter(Boolean).join(" | ");
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

function readFailureMessage(failure: unknown): string | undefined {
  if (!isPlainObject(failure)) {
    return undefined;
  }

  const message = failure.message;
  return typeof message === "string" && message ? message : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
