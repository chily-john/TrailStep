import { describe, expect, it, vi } from "vitest";

import { WorkflowCancellationError } from "../../cancellation/cancellation.js";
import { runWithStepControl } from "./step-control.js";

describe("runWithStepControl", () => {
  it("reports an unexpected step failure that arrives after a cancellation", async () => {
    const reported: unknown[] = [];
    let rejectRun: ((error: unknown) => void) | undefined;
    const runPromise = new Promise<never>((_resolve, reject) => {
      rejectRun = reject;
    });

    const control = runWithStepControl({
      stepId: "step-a",
      readCancellation: cancellationReader(),
      run: () => runPromise,
      onUnexpectedError: (error) => reported.push(error),
    });

    await expect(control).rejects.toBeInstanceOf(WorkflowCancellationError);

    const failure = new Error("boom");
    rejectRun?.(failure);

    await vi.waitFor(() => expect(reported).toEqual([failure]));
  });

  it("keeps abort-related rejections quiet", async () => {
    const reported: unknown[] = [];
    let rejectRun: ((error: unknown) => void) | undefined;
    const runPromise = new Promise<never>((_resolve, reject) => {
      rejectRun = reject;
    });

    const control = runWithStepControl({
      stepId: "step-a",
      readCancellation: cancellationReader(),
      run: () => runPromise,
      onUnexpectedError: (error) => reported.push(error),
    });

    await expect(control).rejects.toBeInstanceOf(WorkflowCancellationError);

    const aborted = new Error("The operation was aborted.");
    aborted.name = "AbortError";
    rejectRun?.(aborted);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reported).toEqual([]);
  });

  it("does not report a failure that propagates to the caller", async () => {
    const reported: unknown[] = [];
    const failure = new Error("boom");

    await expect(
      runWithStepControl({
        stepId: "step-a",
        readCancellation: async () => undefined,
        run: async () => {
          throw failure;
        },
        onUnexpectedError: (error) => reported.push(error),
      }),
    ).rejects.toBe(failure);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reported).toEqual([]);
  });
});

function cancellationReader(): () => Promise<{ readonly requestedAt: string } | undefined> {
  let calls = 0;

  return async () => {
    calls += 1;
    return calls === 1 ? undefined : { requestedAt: "2026-01-01T00:00:00.000Z" };
  };
}
