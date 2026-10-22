import { describe, expect, it } from "vitest";

import { isFailureLikeError, readFailureCode } from "./failure-like.js";

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

describe("readFailureCode", () => {
  it("reads the failure code of a structured failure", () => {
    expect(readFailureCode({ failure: { code: "x", message: "y" } })).toBe("x");
  });

  it("reads the failure code when the message is missing", () => {
    expect(readFailureCode({ failure: { code: "resume_target_not_found" } })).toBe(
      "resume_target_not_found",
    );
  });

  it("returns undefined when there is no string failure code", () => {
    expect(readFailureCode(undefined)).toBeUndefined();
    expect(readFailureCode(null)).toBeUndefined();
    expect(readFailureCode(new Error("Boom"))).toBeUndefined();
    expect(readFailureCode({ failure: null })).toBeUndefined();
    expect(readFailureCode({ failure: { code: 42 } })).toBeUndefined();
  });
});
