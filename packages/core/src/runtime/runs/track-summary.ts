import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import type { Event } from "../run-workflow/run-workflow.types.js";

export interface TrackSummary {
  readonly runId: string;
  readonly status: string;
  readonly workers?: number;
  readonly failurePolicy?: string;
  readonly rootBranchId?: string;
  readonly splitOccurred?: boolean;
  readonly branches: readonly BranchSummary[];
}

export interface BranchSummary {
  readonly branchId: string;
  readonly requestedBranchId?: string;
  readonly parentBranchId?: string;
  readonly status?: string;
  readonly workflowId?: string;
  readonly latestStepIndex?: number;
  readonly latestStepId?: string;
  readonly latestMessage?: string;
  readonly wait?: unknown;
  readonly failure?: unknown;
  readonly output?: unknown;
}

export async function readTrackSummary(options: {
  readonly runId: string;
  readonly runDir: string;
  readonly events: readonly Event[];
}): Promise<TrackSummary | undefined> {
  const track = await readJsonObject(join(options.runDir, "track.json"));
  if (track === undefined) {
    return undefined;
  }

  const branchIds = Array.isArray(track.branches)
    ? track.branches.filter((branchId): branchId is string => typeof branchId === "string")
    : [];

  const branches = await Promise.all(
    branchIds.map(async (branchId) => summarizeBranch(options.runDir, branchId, options.events)),
  );

  return {
    runId: stringValue(track.runId) ?? options.runId,
    status: stringValue(track.status) ?? "unknown",
    ...(numberValue(track.workers) === undefined ? {} : { workers: numberValue(track.workers) }),
    ...(stringValue(track.failurePolicy) === undefined
      ? {}
      : { failurePolicy: stringValue(track.failurePolicy) }),
    ...(stringValue(track.rootBranchId) === undefined
      ? {}
      : { rootBranchId: stringValue(track.rootBranchId) }),
    ...(typeof track.splitOccurred === "boolean" ? { splitOccurred: track.splitOccurred } : {}),
    branches,
  };
}

async function summarizeBranch(
  runDir: string,
  branchId: string,
  events: readonly Event[],
): Promise<BranchSummary> {
  const branch = (await readJsonObject(join(runDir, "branches", `${branchId}.json`))) ?? {};
  const branchEvents = events.filter((event) => event.payload.branchId === branchId);
  const latestFailureMessage = selectLatestEventFailureMessage(branchEvents);
  const latestMessage = latestFailureMessage ?? stringValue(branch.message) ?? selectLatestEventMessage(branchEvents);
  const failure = branch.failure ?? selectLatestEventFailure(branchEvents);

  return {
    branchId: stringValue(branch.branchId) ?? branchId,
    ...(stringValue(branch.requestedBranchId) === undefined
      ? {}
      : { requestedBranchId: stringValue(branch.requestedBranchId) }),
    ...(stringValue(branch.parentBranchId) === undefined
      ? {}
      : { parentBranchId: stringValue(branch.parentBranchId) }),
    ...(stringValue(branch.status) === undefined ? {} : { status: stringValue(branch.status) }),
    ...(stringValue(branch.workflowId) === undefined
      ? {}
      : { workflowId: stringValue(branch.workflowId) }),
    ...(numberValue(branch.latestStepIndex) === undefined
      ? {}
      : { latestStepIndex: numberValue(branch.latestStepIndex) }),
    ...(stringValue(branch.latestStepId) === undefined
      ? {}
      : { latestStepId: stringValue(branch.latestStepId) }),
    ...(latestMessage === undefined ? {} : { latestMessage }),
    ...(branch.wait === undefined ? {} : { wait: branch.wait }),
    ...(failure === undefined ? {} : { failure }),
    ...(branch.output === undefined ? {} : { output: branch.output }),
  };
}

async function readJsonObject(path: string): Promise<PlainObject | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isPlainObject(value) ? value : {};
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function selectLatestEventMessage(events: readonly Event[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const message = stringValue(event?.payload.message);
    if (message !== undefined) {
      return message;
    }
    const failureMessage = isPlainObject(event?.payload.failure)
      ? stringValue(event.payload.failure.message)
      : undefined;
    if (failureMessage !== undefined) {
      return failureMessage;
    }
  }
  return undefined;
}

function selectLatestEventFailureMessage(events: readonly Event[]): string | undefined {
  const failure = selectLatestEventFailure(events);
  return isPlainObject(failure) ? stringValue(failure.message) : undefined;
}

function selectLatestEventFailure(events: readonly Event[]): unknown {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const failure = events[index]?.payload.failure;
    if (failure !== undefined) {
      return failure;
    }
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isPlainObject(value: unknown): value is PlainObject {
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
