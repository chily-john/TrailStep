import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { readRunEvents, selectLatestUnresolvedFailure } from "@stepkit/core";
import type { Event, LatestUnresolvedFailure } from "@stepkit/core";

export interface RunSummary {
  readonly runId: string;
  readonly runDir: string;
}

export interface EligibleRetryRun {
  readonly runId: string;
  readonly runDir: string;
  readonly workflowId: string;
  readonly workflowRef?: string;
  readonly latestFailure: LatestUnresolvedFailure;
  readonly label: string;
}

export async function listRunSummaries(options: { readonly cwd: string }): Promise<RunSummary[]> {
  const runsRoot = join(options.cwd, ".stepkit", "runs");

  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ runId: entry.name, runDir: join(runsRoot, entry.name) }))
    .sort((left, right) => left.runId.localeCompare(right.runId));
}

export async function listEligibleRetryRuns(options: {
  readonly cwd: string;
}): Promise<EligibleRetryRun[]> {
  const summaries = await listRunSummaries(options);
  const eligibleRuns: EligibleRetryRun[] = [];

  for (const summary of summaries) {
    let events: readonly Event[];
    try {
      events = await readRunEvents(summary.runDir);
    } catch {
      continue;
    }

    const latestFailure = selectLatestUnresolvedFailure(events);
    if (!latestFailure) {
      continue;
    }

    eligibleRuns.push({
      ...summary,
      workflowId: latestFailure.workflowId,
      workflowRef: findPersistedWorkflowRef(events),
      latestFailure,
      label: formatEligibleRetryRunLabel({ ...summary, latestFailure }),
    });
  }

  return eligibleRuns.sort((left, right) => left.label.localeCompare(right.label));
}

function formatEligibleRetryRunLabel(options: {
  readonly runId: string;
  readonly latestFailure: LatestUnresolvedFailure;
}): string {
  const { event, stepId, workflowId } = options.latestFailure;
  const failureMessage = readFailureMessage(event);
  const failureContext = [stepId ? `step ${stepId}` : event.type, failureMessage]
    .filter(Boolean)
    .join(": ");

  return `${workflowId} | run ${options.runId} | latest ${event.timestamp} | ${failureContext}`;
}

function findPersistedWorkflowRef(events: readonly Event[]): string | undefined {
  const startedEvent = events.find((event) => event.type === "workflow.started");
  const workflowRef = startedEvent?.payload.workflowRef;

  if (typeof workflowRef === "string" && workflowRef.trim()) {
    return workflowRef;
  }

  if (!isPlainObject(workflowRef)) {
    return undefined;
  }

  if (workflowRef.kind === "legacy-package-export") {
    return `${readRequiredString(workflowRef.packageName)}:${readRequiredString(workflowRef.exportName)}`;
  }

  if (workflowRef.kind === "bundle") {
    return `${readRequiredString(workflowRef.packageName)}#${readRequiredString(workflowRef.workflowName)}`;
  }

  if (workflowRef.kind === "direct-file") {
    return `${readRequiredString(workflowRef.packageName)}#${readRequiredString(workflowRef.exportName)}`;
  }

  return undefined;
}

function readRequiredString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readFailureMessage(event: Event): string | undefined {
  const failure = event.payload.failure;
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
