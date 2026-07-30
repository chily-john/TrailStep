import { describe, expect, it } from "vitest";

import { isFailureLikeError } from "./failure-like.js";

describe("isFailureLikeError", () => {
  it("recognizes objects with a structured failure", () => {
    expect(isFailureLikeError({ failure: { code: "x", message: "y" } })).toBe(true);
  });

  it("rejects values that do not carry a complete structured failure", () => {
    expect(isFailureLikeError(null)).toBe(false);
    expect(isFailureLikeError(new Error("Boom"))).toBe(false);
    expect(isFailureLikeError({ failure: { message: "y" } })).toBe(false);
    expect(isFailureLikeError({ failure: { code: "x" } })).toBe(false);
  });
});
