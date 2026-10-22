import { describe, expect, it } from "vitest";

import { nonEmptyOptional, nonEmptyOrDefault } from "./strings.js";

describe("nonEmptyOptional", () => {
  it("returns the trimmed value when it is non-empty", () => {
    expect(nonEmptyOptional("  value  ")).toBe("value");
  });

  it("returns undefined for blank or missing values", () => {
    expect(nonEmptyOptional("   ")).toBeUndefined();
    expect(nonEmptyOptional("")).toBeUndefined();
    expect(nonEmptyOptional(undefined)).toBeUndefined();
  });
});

describe("nonEmptyOrDefault", () => {
  it("returns the trimmed value when it is non-empty", () => {
    expect(nonEmptyOrDefault("  value  ", "fallback")).toBe("value");
  });

  it("returns the fallback for blank or missing values", () => {
    expect(nonEmptyOrDefault("   ", "fallback")).toBe("fallback");
    expect(nonEmptyOrDefault(undefined, "fallback")).toBe("fallback");
  });
});
