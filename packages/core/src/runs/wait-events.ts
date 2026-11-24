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

/** Explicit branch identity recorded on an event payload, or undefined for the implicit root branch. */
export function readEventBranchId(event: Event): string | undefined {
  return typeof event.payload.branchId === "string" && event.payload.branchId.length > 0
    ? event.payload.branchId
    : undefined;
}

/** Branch identity of a wait event; events without a branch belong to the implicit root branch. */
export function waitEventBranchId(event: Event): string {
  return readEventBranchId(event) ?? "root";
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

/** A wait whose branch could not be matched to a legacy cancellation. */
export interface WaitCancellationAmbiguity {
  /** Wait.started event that is neither provably resolved nor safely answerable. */
  readonly wait: Event;
  /** Later step.cancelled event without branch identity that could belong to another branch. */
  readonly cancellation: Event;
}

interface WaitEventScan {
  /** Unresolved waits that are safe to expose as answerable/continuable. */
  readonly pending: Event[];
  /** Unresolved waits whose legacy cancellation cannot be attributed to their branch. */
  readonly ambiguities: WaitCancellationAmbiguity[];
}

/**
 * Resolve waits in one pass.
 *
 * A wait is resolved by a later `wait.satisfied` / `wait.failed` with the same
 * wait identity, or by a later `step.cancelled` for the same step and branch.
 * Cancellation-to-wait matching requires:
 *
 * - the same `stepId` as the wait;
 * - the same branch identity, where an absent `branchId` on both sides is the
 *   implicit root branch and an explicit cancellation `branchId` must equal
 *   the wait's branch;
 * - a strictly later event, so a cancellation never erases a new wait started
 *   after it.
 *
 * A legacy `step.cancelled` without branch identity can only be attributed to
 * the implicit root branch. It must never resolve an arbitrary parallel
 * branch's wait: that wait stays unresolved but is reported as an ambiguity
 * instead of being silently treated as answerable or as cancelled.
 */
function scanWaitEvents(events: readonly Event[]): WaitEventScan {
  // Last wait.satisfied/wait.failed index per wait key.
  const lastWaitResolutionIndex = new Map<string, number>();
  // Last branch-scoped step.cancelled index per `stepId\0branchId`.
  const lastBranchCancellationIndex = new Map<string, number>();
  // Last legacy unscoped step.cancelled per stepId.
  const lastUnscopedCancellation = new Map<
    string,
    { readonly index: number; readonly event: Event }
  >();

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) {
      continue;
    }
    if (event.type === "wait.satisfied" || event.type === "wait.failed") {
      const key = waitEventKey(event);
      if (key !== undefined) {
        lastWaitResolutionIndex.set(key, index);
      }
      continue;
    }
    if (event.type !== "step.cancelled" || event.stepId === undefined) {
      continue;
    }
    const branchId = readEventBranchId(event);
    if (branchId === undefined) {
      lastUnscopedCancellation.set(event.stepId, { index, event });
      continue;
    }
    lastBranchCancellationIndex.set(`${event.stepId}\u0000${branchId}`, index);
  }

  const pending: Event[] = [];
  const ambiguities: WaitCancellationAmbiguity[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type !== "wait.started") {
      continue;
    }

    const key = waitEventKey(event);
    const waitBranchId = waitEventBranchId(event);
    const stepId = event.stepId;
    const unscopedCancellation =
      stepId === undefined ? undefined : lastUnscopedCancellation.get(stepId);
    const branchCancellationIndex =
      stepId === undefined
        ? undefined
        : lastBranchCancellationIndex.get(`${stepId}\u0000${waitBranchId}`);
    // An unscoped cancellation is root-only, so it also resolves an explicitly
    // decorated root wait without changing the implicit-root behavior.
    const cancellationIndex =
      waitBranchId === "root" && unscopedCancellation !== undefined
        ? Math.max(branchCancellationIndex ?? -1, unscopedCancellation.index)
        : (branchCancellationIndex ?? -1);
    const waitResolutionIndex = key === undefined ? -1 : (lastWaitResolutionIndex.get(key) ?? -1);
    const resolutionIndex = Math.max(waitResolutionIndex, cancellationIndex);

    if (resolutionIndex > index) {
      continue;
    }

    if (
      waitBranchId !== "root" &&
      unscopedCancellation !== undefined &&
      unscopedCancellation.index > index
    ) {
      ambiguities.push({ wait: event, cancellation: unscopedCancellation.event });
      continue;
    }

    pending.push(event);
  }

  return { pending, ambiguities };
}

/**
 * Every unresolved wait.started event that is safe to present as pending and
 * answerable, in event order.
 *
 * A wait is resolved by a later wait.satisfied/wait.failed carrying the same
 * wait identity (`waitEventKey`), or by a later same-step, same-branch
 * step.cancelled. Same-id waits on different parallel branches stay distinct.
 * A legacy unscoped cancellation never resolves an arbitrary branch wait: that
 * wait is withheld from this list and reported by
 * `listWaitCancellationAmbiguities` instead. This is the one shared
 * pending-wait seam used by the CLI/MCP, resume and the bounded evidence query.
 */
export function listPendingWaits(events: readonly Event[]): Event[] {
  return scanWaitEvents(events).pending;
}

/**
 * Unresolved branch waits whose step was later cancelled by a legacy
 * `step.cancelled` event without branch identity.
 *
 * Those waits are deliberately not returned by `listPendingWaits`: the
 * cancellation may have terminated them, but it cannot be attributed to a
 * parallel branch without guessing. Callers that report wait answerability
 * should surface this ambiguity (and preserve the trail) instead of claiming
 * the wait is still answerable or that it was cancelled.
 */
export function listWaitCancellationAmbiguities(
  events: readonly Event[],
): WaitCancellationAmbiguity[] {
  return scanWaitEvents(events).ambiguities;
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
