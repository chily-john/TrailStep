import { describe, expect, it } from "vitest";

import { errorMessage, isNodeError, isPlainObject, isRecord } from "./guards.js";

describe("canonical guards", () => {
  it("isRecord accepts record-like objects and rejects arrays and primitives", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ nested: { value: 1 } })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("value")).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });

  it("isPlainObject accepts plain objects, including null-prototype objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject("value")).toBe(false);
  });

  it("isNodeError only matches errors carrying a code property", () => {
    const error = Object.assign(new Error("missing"), { code: "ENOENT" });

    expect(isNodeError(error)).toBe(true);
    expect(isNodeError(new Error("missing"))).toBe(false);
    expect(isNodeError({ code: "ENOENT" })).toBe(false);
    expect(isNodeError("ENOENT")).toBe(false);
  });

  it("errorMessage renders errors and non-error values", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("boom")).toBe("boom");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});
