import { describe, expect, it } from "vitest";

import { CliUsageError, parseWorkflowId } from "./index.js";

describe("parseWorkflowId", () => {
  it("parses a scoped package workflow id by splitting on the last colon", () => {
    expect(parseWorkflowId("@acme/trailstep-workflows:reviewFeature")).toEqual({
      kind: "legacy-package-export",
      packageName: "@acme/trailstep-workflows",
      exportName: "reviewFeature",
    });
  });

  it("rejects workflow ids without a package/export separator", () => {
    expect(() => parseWorkflowId("reviewFeature")).toThrow(CliUsageError);
    expect(() => parseWorkflowId("reviewFeature")).toThrow(/usage/i);
  });

  it("rejects workflow ids with an empty package or export segment", () => {
    expect(() => parseWorkflowId(":reviewFeature")).toThrow(/usage/i);
    expect(() => parseWorkflowId("@acme/workflows:")).toThrow(/usage/i);
  });
});
