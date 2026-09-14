import type { RunSummary } from "@trailstep/core";
import { listRunSummaries, selectRecentFailedRunSummaries } from "@trailstep/core";
import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import { resolveRunsRoot } from "../../runs-root.js";

export const runsCommand: CliCommand<void> = {
  name: "runs",
  parseArgs(argv) {
    if (argv.length !== 1 || argv[0] !== "runs") {
      throw new CliUsageError("Usage: trailstep runs");
    }
  },
  async run(_args, context) {
    const summaries = await listRunSummaries({
      cwd: context.cwd,
      runsRoot: resolveRunsRoot(context),
    });
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
