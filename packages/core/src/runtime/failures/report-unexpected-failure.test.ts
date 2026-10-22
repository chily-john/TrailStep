import { describe, expect, it, vi } from "vitest";

import { WorkflowCancellationError } from "../cancellation/cancellation.js";
import { isAbortLikeError, reportUnexpectedFailure } from "./report-unexpected-failure.js";

describe("isAbortLikeError", () => {
  it("recognizes workflow cancellations", () => {
    expect(isAbortLikeError(new WorkflowCancellationError())).toBe(true);
  });

  it("recognizes abort errors", () => {
    const aborted = new Error("The operation was aborted.");
    aborted.name = "AbortError";
    expect(isAbortLikeError(aborted)).toBe(true);

    const coded = new Error("aborted") as Error & { code: string };
    coded.code = "ABORT_ERR";
    expect(isAbortLikeError(coded)).toBe(true);
  });

  it("rejects unrelated failures", () => {
    expect(isAbortLikeError(new Error("Boom"))).toBe(false);
    expect(isAbortLikeError("Boom")).toBe(false);
    expect(isAbortLikeError(undefined)).toBe(false);
  });
});

describe("reportUnexpectedFailure", () => {
  it("reports unexpected failures to the injected reporter", () => {
    const report = vi.fn();
    const failure = new Error("Boom");

    reportUnexpectedFailure({ error: failure, context: "step a", report });

    expect(report).toHaveBeenCalledWith(failure);
  });

  it("stays quiet for abort and cancellation failures", () => {
    const report = vi.fn();

    reportUnexpectedFailure({ error: new WorkflowCancellationError(), context: "step a", report });

    expect(report).not.toHaveBeenCalled();
  });
});
