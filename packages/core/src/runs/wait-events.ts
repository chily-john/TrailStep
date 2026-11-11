/**
 * Shared wait-event helpers.
 *
 * Every unresolved wait.started event with the given waitId, in event order.
 * Same-id waits on different parallel branches are distinct waits, so callers
 * that address a wait must disambiguate by branch instead of picking one.
 *
 * These were duplicated in the CLI (`wait-run-helpers.ts`) and the MCP
 * (`run-wait-files.ts`); the MCP package cannot import from the CLI package,
 * so the shared implementation lives in core.
 */
import { isRecord } from "../json/guards.js";
import type { Event } from "../runtime/run-workflow/run-workflow.types.js";

/** Branch identity of a wait event; events without a branch belong to the implicit root branch. */
export function waitEventBranchId(event: Event): string {
  return typeof event.payload.branchId === "string" && event.payload.branchId.length > 0
    ? event.payload.branchId
    : "root";
}

/**
 * Wait identity used to match a wait.started event with its resolution
 * (wait.satisfied / wait.failed). Undefined when the event carries no usable
 * identity (no answer file and no step+wait id).
 */
export function waitEventKey(event: Event): string | undefined {
  // Branch identity is part of the wait identity so that same-id waits on
  // different parallel branches never resolve each other. Events from
  // non-parallel runs carry no branchId and belong to the implicit root branch.
  const branchId = waitEventBranchId(event);
  const artifactPaths = event.payload.artifactPaths;
  if (isRecord(artifactPaths) && typeof artifactPaths.answerFile === "string") {
    return `${branchId}:${artifactPaths.answerFile}`;
  }

  const waitId = typeof event.payload.waitId === "string" ? event.payload.waitId : undefined;
  return event.stepId && waitId ? `${branchId}:${event.stepId}:${waitId}` : undefined;
}

/**
 * Every unresolved wait.started event, in event order.
 *
 * A wait is resolved by a later wait.satisfied/wait.failed carrying the same
 * wait identity (`waitEventKey`), which embeds the branch id, so same-id waits
 * on different parallel branches stay distinct. A wait.started that was
 * already resolved before a later same-id wait is not pending. This is the one
 * shared pending-wait seam used by the CLI/MCP and the bounded evidence query.
 */
export function listPendingWaits(events: readonly Event[]): Event[] {
  // Record the LAST resolution index for each wait key in one pass. A start is
  // pending precisely when no resolution with its key occurs after it. This
  // preserves the old "any later resolution wins" semantics without the
  // O(n^2) suffix scan that made a long event trail quadratic.
  const lastResolutionIndex = new Map<string, number>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type !== "wait.satisfied" && event?.type !== "wait.failed") {
      continue;
    }
    const key = waitEventKey(event);
    if (key !== undefined) {
      lastResolutionIndex.set(key, index);
    }
  }

  const pending: Event[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type !== "wait.started") {
      continue;
    }
    const key = waitEventKey(event);
    if (key === undefined || (lastResolutionIndex.get(key) ?? -1) <= index) {
      pending.push(event);
    }
  }

  return pending;
}

/** Every unresolved wait.started event with the given waitId, in event order. */
export function findPendingWaitsById(events: readonly Event[], waitId: string): Event[] {
  return listPendingWaits(events).filter((event) => event.payload.waitId === waitId);
}

/**
 * The most recent unresolved wait event, if any.
 *
 * When `branchId` is given (parallel-track scope), only waits that belong to
 * that branch are considered; events without a branchId belong to the
 * implicit root branch. Same-id waits on different branches stay distinct
 * because the wait key embeds the branch identity.
 */
export function findLatestPendingWait(
  events: readonly Event[],
  branchId?: string,
): Event | undefined {
  const pending = listPendingWaits(events);
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const event = pending[index];
    if (event === undefined || typeof event.payload.waitId !== "string") {
      continue;
    }
    if (branchId !== undefined && waitEventBranchId(event) !== branchId) {
      continue;
    }
    return event;
  }
  return undefined;
}

/** The run-relative answer artifact of a wait event, when it has one. */
export function readWaitAnswerFile(event: Event): string | undefined {
  const artifactPaths = event.payload.artifactPaths;
  if (!isRecord(artifactPaths)) {
    return undefined;
  }

  return typeof artifactPaths.answerFile === "string" ? artifactPaths.answerFile : undefined;
}

/** Verbatim question text of a wait (the wait.started payload message). */
export function readWaitQuestion(event: Event): string | undefined {
  return typeof event.payload.message === "string" ? event.payload.message : undefined;
}
