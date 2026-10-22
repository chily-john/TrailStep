import { availableParallelism } from "node:os";
import type { ParallelOptions } from "../../authoring/step/continuation.types.js";
import type { RunContinuationResult } from "../continuation/run-continuation/run-continuation.js";
import type { NormalizedParallelOptions, QueuedBranch } from "./scheduler-types.js";

export function resolveSchedulerWorkerCount(
  workers: number | undefined,
):
  | { readonly ok: true; readonly workers: number }
  | { readonly ok: false; readonly failure: RunContinuationResult } {
  if (workers === undefined) {
    return {
      ok: true,
      workers: Math.max(1, Math.floor(availableParallelism() / 2)),
    };
  }

  if (!Number.isFinite(workers) || !Number.isInteger(workers) || workers < 1) {
    return {
      ok: false,
      failure: {
        status: "failure",
        failure: {
          code: "invalid_scheduler_workers",
          message: "scheduler.workers must be an integer greater than or equal to 1.",
        },
      },
    };
  }

  return { ok: true, workers };
}

export function normalizeParallelOptions(
  options: ParallelOptions | undefined,
): NormalizedParallelOptions {
  const concurrency = options?.concurrency;
  return {
    ...(concurrency === undefined ? {} : { concurrency }),
    failurePolicy: options?.failurePolicy ?? "fail-fast",
  };
}

export function shiftRunnableQueuedBranch(
  queue: QueuedBranch[],
  activeByParallelGroup: ReadonlyMap<string, number>,
): QueuedBranch | undefined {
  const index = queue.findIndex((candidate) => {
    if (candidate.parallelGroupId === undefined || candidate.parallelConcurrency === undefined) {
      return true;
    }
    return (
      (activeByParallelGroup.get(candidate.parallelGroupId) ?? 0) < candidate.parallelConcurrency
    );
  });
  if (index < 0) {
    return undefined;
  }
  const [queued] = queue.splice(index, 1);
  return queued;
}

export function incrementActiveParallelGroup(
  parallelGroupId: string | undefined,
  activeByParallelGroup: Map<string, number>,
): void {
  if (parallelGroupId === undefined) {
    return;
  }
  activeByParallelGroup.set(parallelGroupId, (activeByParallelGroup.get(parallelGroupId) ?? 0) + 1);
}

export function decrementActiveParallelGroup(
  parallelGroupId: string | undefined,
  activeByParallelGroup: Map<string, number>,
): void {
  if (parallelGroupId === undefined) {
    return;
  }
  const next = (activeByParallelGroup.get(parallelGroupId) ?? 1) - 1;
  if (next <= 0) {
    activeByParallelGroup.delete(parallelGroupId);
  } else {
    activeByParallelGroup.set(parallelGroupId, next);
  }
}
