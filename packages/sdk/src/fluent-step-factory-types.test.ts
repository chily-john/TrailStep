import { describe, expect, it } from "vitest";

import { done, step, type RunContext } from "./index.js";

describe("fluent step factory continuation types", () => {
  it("allows orchestration next callbacks with input and RunContext while preserving one-argument callbacks", () => {
    const withContext = step(
      {
        id: "with-context",
        input: { value: 1 },
        outputShape: { value: "number" },
        run: ({ value }) => ({ value }),
      },
      (input, ctx: RunContext) => {
        void ctx.state.get("count");
        return done({ value: input.value });
      },
    );

    const oneArgument = step(
      {
        id: "one-argument",
        input: { value: 1 },
        outputShape: { value: "number" },
        run: ({ value }) => ({ value }),
      },
      (input) => done({ value: input.value }),
    );

    expect(withContext.kind).toBe("step");
    expect(oneArgument.kind).toBe("step");
  });
});
