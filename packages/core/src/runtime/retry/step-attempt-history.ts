import type { Failure } from "../../contracts/failures/failure.js";
import { TrailStepFailureError } from "../../contracts/failures/failure.js";
import { readRunEvents } from "../artifacts/run-storage.js";

export interface RecordedStepAttempts {
  /** Number of `step.attemptFailed` events recorded for the step so far. */
  readonly attemptFailures: number;
  /** Failure payload of the most recent recorded failed attempt, when present. */
  readonly lastFailure?: Failure;
}

/**
 * Reconstructs how many automatic retry attempts a step has already consumed
 * from the persisted event trail (`events.jsonl`) — not from in-memory
 * counters — so attempt accounting survives a crash between attempts. A run
 * directory without an event trail (a fresh or in-memory-emitted run) counts
 * as zero prior attempts.
 */
export async function readRecordedStepAttempts(options: {
  readonly runDir: string;
  readonly stepId: string;
}): Promise<RecordedStepAttempts> {
  let events: Awaited<ReturnType<typeof readRunEvents>>;
  try {
    events = await readRunEvents(options.runDir);
  } catch (error) {
    if (isMissingEventTrailError(error)) {
      return { attemptFailures: 0 };
    }
    throw error;
  }

  let attemptFailures = 0;
  let lastFailure: Failure | undefined;
  for (const event of events) {
    if (event.type !== "step.attemptFailed" || event.stepId !== options.stepId) {
      continue;
    }
    attemptFailures += 1;
    const failure = event.payload.failure;
    if (isFailure(failure)) {
      lastFailure = failure;
    }
  }

  return {
    attemptFailures,
    ...(lastFailure === undefined ? {} : { lastFailure }),
  };
}

function isMissingEventTrailError(error: unknown): boolean {
  if (!(error instanceof TrailStepFailureError)) {
    return false;
  }

  const details = error.failure.details as { readonly causeCode?: unknown } | undefined;
  return details?.causeCode === "ENOENT";
}

function isFailure(value: unknown): value is Failure {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { readonly code?: unknown; readonly message?: unknown };
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}
