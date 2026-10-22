import { TrailStepFailureError } from "../../../contracts/failures/failure.js";
import {
  type CancellationMarker,
  WorkflowCancellationError,
} from "../../cancellation/cancellation.js";
import { reportUnexpectedFailure } from "../../failures/report-unexpected-failure.js";

export async function runWithStepControl<T>(options: {
  readonly stepId: string;
  readonly timeoutMs?: number;
  readonly readCancellation: () => Promise<CancellationMarker | undefined>;
  readonly run: (signal: AbortSignal) => Promise<T>;
  /** Receives failures that would otherwise be discarded by the abort path. */
  readonly onUnexpectedError?: (error: unknown) => void;
}): Promise<T> {
  const initialCancellation = await options.readCancellation();
  if (initialCancellation !== undefined) {
    throw new WorkflowCancellationError(initialCancellation);
  }

  const abortController = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let stopCancellationWatch: (() => void) | undefined;

  const runPromise = options.run(abortController.signal);
  // The step promise is raced against cancellation/timeout. When the race is
  // already settled (cancelled or timed out), a later rejection of the step
  // promise would be discarded, so it is reported instead of dropped. While
  // the race is still pending the rejection propagates to the caller and must
  // not be reported twice.
  let raceSettled = false;
  void runPromise.catch((error: unknown) => {
    if (!raceSettled) {
      return;
    }

    reportUnexpectedFailure({
      error,
      context: `step ${options.stepId}`,
      ...(options.onUnexpectedError === undefined ? {} : { report: options.onUnexpectedError }),
    });
  });

  const cancellationPromise = new Promise<never>((_, reject) => {
    stopCancellationWatch = watchCancellation(options.readCancellation, (result) => {
      abortController.abort();
      if ("error" in result) {
        reject(result.error);
        return;
      }
      reject(new WorkflowCancellationError(result.cancellation));
    });
  });

  const raced: Array<Promise<T> | Promise<never>> = [runPromise, cancellationPromise];

  if (options.timeoutMs !== undefined) {
    const timeoutMs = options.timeoutMs;
    raced.push(
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          abortController.abort();
          reject(stepTimeoutFailure(options.stepId, timeoutMs));
        }, timeoutMs);
      }),
    );
  }

  try {
    return await Promise.race(raced);
  } finally {
    raceSettled = true;
    stopCancellationWatch?.();
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function watchCancellation(
  readCancellation: () => Promise<CancellationMarker | undefined>,
  onCancel: (
    result: { readonly cancellation: CancellationMarker } | { readonly error: unknown },
  ) => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const poll = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    try {
      const cancellation = await readCancellation();
      if (cancellation !== undefined) {
        stopped = true;
        onCancel({ cancellation });
        return;
      }
    } catch (error) {
      stopped = true;
      onCancel({ error });
      return;
    }

    timer = setTimeout(() => void poll(), 100);
  };

  timer = setTimeout(() => void poll(), 0);

  return () => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  };
}

export function throwIfStepTimedOut(
  signal: AbortSignal | undefined,
  stepId: string,
  timeoutMs: number | undefined,
): void {
  if (signal?.aborted && timeoutMs !== undefined) {
    throw stepTimeoutFailure(stepId, timeoutMs);
  }
}

function stepTimeoutFailure(stepId: string, timeoutMs: number): TrailStepFailureError {
  return new TrailStepFailureError({
    code: "step_timeout",
    message: `Step ${stepId} timed out after ${timeoutMs}ms.`,
    details: { stepId, timeoutMs },
  });
}
