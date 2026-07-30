import { describe, expect, it } from "vitest";

import { stepExecutionFailure } from "./step-execution-failure.js";

describe("stepExecutionFailure", () => {
  it("converts normal errors to stable step execution failures", () => {
    expect(stepExecutionFailure(new Error("Boom"))).toEqual({
      code: "step_execution_failed",
      message: "Boom",
      details: { name: "Error" },
    });
  });
});
