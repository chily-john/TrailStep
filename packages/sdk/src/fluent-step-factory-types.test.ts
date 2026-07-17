import { describe, expect, it } from "vitest";

import { done, step, type RunContext } from "./index.js";

describe("fluent step factory continuation types", () => {
  it("allows orchestration next callbacks with input and RunContext while preserving one-argument callbacks", () => {
    const withContext = step({
      id: "with-context",
      outputShape: { value: "number" },
    }).next((input, ctx: RunContext) => {
      void ctx.state.get("count");
      const { value } = input;
      return done({ value });
    })({ value: 1 });

    const oneArgument = step({
      id: "one-argument",
      outputShape: { value: "number" },
    }).next((input) => {
      const { value } = input;
      return done({ value });
    })({ value: 1 });

    expect(withContext.kind).toBe("step");
    expect(oneArgument.kind).toBe("step");
  });
});
