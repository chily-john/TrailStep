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
  if (isRecordLike(artifactPaths) && typeof artifactPaths.answerFile === "string") {
    return `${branchId}:${artifactPaths.answerFile}`;
  }

  const waitId = typeof event.payload.waitId === "string" ? event.payload.waitId : undefined;
  return event.stepId && waitId ? `${branchId}:${event.stepId}:${waitId}` : undefined;
}

/** Every unresolved wait.started event with the given waitId, in event order. */
export function findPendingWaitsById(events: readonly Event[], waitId: string): Event[] {
  const pending: Event[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type !== "wait.started" || event.payload.waitId !== waitId) {
      continue;
    }

    const key = waitEventKey(event);
    const resolvedLater = key
      ? events
          .slice(index + 1)
          .some(
            (laterEvent) =>
              (laterEvent.type === "wait.satisfied" || laterEvent.type === "wait.failed") &&
              waitEventKey(laterEvent) === key,
          )
      : false;
    if (!resolvedLater) {
      pending.push(event);
    }
  }

  return pending;
}

/** The most recent unresolved wait event, if any. */
export function findLatestPendingWait(events: readonly Event[]): Event | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "wait.started" || typeof event.payload.waitId !== "string") {
      continue;
    }

    const key = waitEventKey(event);
    const resolvedLater = key
      ? events
          .slice(index + 1)
          .some(
            (laterEvent) =>
              (laterEvent.type === "wait.satisfied" || laterEvent.type === "wait.failed") &&
              waitEventKey(laterEvent) === key,
          )
      : false;
    if (!resolvedLater) {
      return event;
    }
  }

  return undefined;
}

/** The run-relative answer artifact of a wait event, when it has one. */
export function readWaitAnswerFile(event: Event): string | undefined {
  const artifactPaths = event.payload.artifactPaths;
  if (!isRecordLike(artifactPaths)) {
    return undefined;
  }

  return typeof artifactPaths.answerFile === "string" ? artifactPaths.answerFile : undefined;
}

/** Verbatim question text of a wait (the wait.started payload message). */
export function readWaitQuestion(event: Event): string | undefined {
  return typeof event.payload.message === "string" ? event.payload.message : undefined;
}

/** Permissive record check (the payload shape used by run event artifacts). */
function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
