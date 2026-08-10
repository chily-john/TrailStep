import { describe, expect, it } from "vitest";

import { TrailStepFailureError } from "../../contracts/failures/failure.js";
import { workflowFailure } from "./workflow-failure.js";

describe("workflowFailure", () => {
  it("preserves failures thrown as TrailStepFailureError", () => {
    const failure = { code: "already_structured", message: "Already structured." };

    expect(workflowFailure(new TrailStepFailureError(failure))).toBe(failure);
  });

  it("preserves failure-like objects", () => {
    const failure = { code: "failure_like", message: "Failure-like." };

    expect(workflowFailure({ failure })).toBe(failure);
  });
});
