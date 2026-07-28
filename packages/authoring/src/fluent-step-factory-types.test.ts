import { describe, expect, it } from "vitest";

import { done, state, step } from "./index.js";

describe("fluent step factory continuation types", () => {
  it("allows next callbacks that read ambient state while preserving one-argument callbacks", () => {
    const withState = step({
      id: "with-state",
    }).do(async (input) => {
      void (await state.get("count"));
      const { value } = input;
      return done({ value });
    })({ value: 1 });

    const oneArgument = step({
      id: "one-argument",
    }).do((input) => {
      const { value } = input;
      return done({ value });
    })({ value: 1 });

    expect(withState.kind).toBe("step");
    expect(oneArgument.kind).toBe("step");
  });
});
