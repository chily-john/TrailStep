import { join } from "node:path";

import type { Failure } from "../../../contracts/failures/failure.js";
import { isPlainObject } from "../../../json/guards.js";
import type { Event } from "../../../runtime/run-workflow/run-workflow.types.js";

// Single source of truth for pending-wait lookup lives in the shared wait-event
// helpers; branch scoping is part of that shared implementation.
export { findLatestPendingWait } from "../../../runs/wait-events.js";

/**
 * Build the event view `replayCompletedSteps` uses for a branch-scoped
 * resume. Other branches' step/wait terminal events are dropped so they can
 * never pair into this branch's replay walk (parallel branches may reuse the
 * same step ids), while their `step.started` events are kept with synthetic
 * step ids so the global `step.started` ordinal — and therefore each replayed
 * step's true step artifact index — is unchanged. Events without a branchId
 * (run-level or pre-split events) pass through untouched.
 */
export function branchScopedReplayEvents(
  events: readonly Event[],
  branchId: string,
): readonly Event[] {
  let foreignOrdinal = 0;
  const scoped: Event[] = [];
  for (const event of events) {
    const eventBranchId =
      typeof event.payload.branchId === "string" ? event.payload.branchId : undefined;
    if (eventBranchId === undefined || eventBranchId === branchId) {
      scoped.push(event);
      continue;
    }
    if (event.type === "step.started") {
      foreignOrdinal += 1;
      scoped.push({ ...event, stepId: `__foreign_branch_${foreignOrdinal}__` } as Event);
    }
  }
  return scoped;
}

/** Index of the `step.started` event that owns the pending wait's step. */
export function findStepStartedIndex(
  events: readonly Event[],
  pendingWait: Event,
  stepIndex: number,
): number | undefined {
  let ordinal = 0;
  for (const [index, event] of events.entries()) {
    if (event.type !== "step.started") {
      continue;
    }
    ordinal += 1;
    if (ordinal === stepIndex) {
      return index;
    }
  }

  for (let index = events.indexOf(pendingWait); index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "step.started" && event.stepId === pendingWait.stepId) {
      return index;
    }
  }

  return undefined;
}

/** Number of `step.started` events recorded before the pending wait. */
export function stepStartedOrdinalBefore(
  events: readonly Event[],
  pendingWait: Event,
): number | undefined {
  const waitIndex = events.indexOf(pendingWait);
  if (waitIndex === -1) {
    return undefined;
  }
  const count = events.slice(0, waitIndex).filter((event) => event.type === "step.started").length;
  return count > 0 ? count : undefined;
}

/** Step artifact index encoded in the wait's artifact paths. */
export function readStepIndex(event: Event): number | undefined {
  const artifactStepId = readArtifactStepId(event);
  const prefix = artifactStepId?.match(/^(\d+)-/u)?.[1];
  if (prefix === undefined) {
    return undefined;
  }

  const stepIndex = Number(prefix);
  return Number.isInteger(stepIndex) && stepIndex > 0 ? stepIndex : undefined;
}

/** Directory holding the step artifacts of the given step index. */
export function stepDirForIndex(runDir: string, event: Event, stepIndex: number): string {
  const artifactStepId =
    readArtifactStepId(event) ?? `${String(stepIndex).padStart(4, "0")}-${event.stepId ?? "step"}`;
  return join(runDir, "steps", artifactStepId);
}

export function readArtifactStepId(event: Event): string | undefined {
  const artifactPaths = readWaitArtifactPaths(event);
  const path = artifactPaths?.requestFile ?? artifactPaths?.answerFile;
  return path?.match(/^steps\/([^/]+)\/waits\//u)?.[1];
}

export function readWaitArtifactPaths(
  event: Event,
): { readonly requestFile: string; readonly answerFile: string } | undefined {
  const artifactPaths = event.payload.artifactPaths;
  if (!isPlainObject(artifactPaths)) {
    return undefined;
  }

  const requestFile = artifactPaths.requestFile;
  const answerFile = artifactPaths.answerFile;
  if (typeof requestFile !== "string" || typeof answerFile !== "string") {
    return undefined;
  }

  return { requestFile, answerFile };
}

export function readWaitId(event: Event): string | undefined {
  return typeof event.payload.waitId === "string" ? event.payload.waitId : undefined;
}

export function resumeFailure(code: string, message: string): Failure {
  return { code, message };
}
