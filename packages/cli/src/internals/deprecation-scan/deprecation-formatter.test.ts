import { describe, expect, it } from "vitest";

import { formatDeprecationFinding } from "./deprecation-formatter.js";
import type { DeprecationFinding } from "./deprecation-scanner.js";

function baseFinding(overrides: Partial<DeprecationFinding> = {}): DeprecationFinding {
  return {
    sourceFile: "C:\\repo\\workflows\\review.mjs",
    packageName: "@stepkit/authoring",
    symbol: "oldStep",
    severity: "warning",
    message: "oldStep is deprecated.",
    line: 3,
    column: 10,
    targetVersion: "2.0.0",
    newlyTriggeredByThisUpdate: false,
    ...overrides,
  };
}

describe("formatDeprecationFinding", () => {
  it("pins the exact output for a warning finding", () => {
    expect(formatDeprecationFinding(baseFinding())).toBe(
      "warning @stepkit/authoring/oldStep C:/repo/workflows/review.mjs:3:10 oldStep is deprecated.",
    );
  });

  it("pins the exact output for a blocking finding", () => {
    expect(
      formatDeprecationFinding(
        baseFinding({
          severity: "blocking",
          symbol: "removedStep",
          message: "removedStep was removed.",
        }),
      ),
    ).toBe(
      "blocking @stepkit/authoring/removedStep C:/repo/workflows/review.mjs:3:10 removedStep was removed.",
    );
  });

  it("appends a Replacement clause when a replacement suggestion is present", () => {
    expect(formatDeprecationFinding(baseFinding({ replacement: "step" }))).toBe(
      "warning @stepkit/authoring/oldStep C:/repo/workflows/review.mjs:3:10 oldStep is deprecated. Replacement: step.",
    );
  });

  it("omits the Replacement clause when no replacement suggestion is present", () => {
    expect(formatDeprecationFinding(baseFinding())).not.toContain("Replacement:");
  });
});
