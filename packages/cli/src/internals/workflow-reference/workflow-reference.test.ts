import { describe, expect, it } from "vitest";

import { parseWorkflowId } from "./workflow-reference.js";

describe("parseWorkflowId", () => {
  it("parses scoped bundle package refs with # instead of treating the scope slash as a path", () => {
    expect(parseWorkflowId("@acme/workflows#review")).toEqual({
      kind: "bundle",
      packageName: "@acme/workflows",
      workflowName: "review",
      exportName: "review",
    });
  });

  it("parses local package bundle refs with #", () => {
    expect(parseWorkflowId("./local-workflow-package#review")).toMatchObject({
      kind: "bundle",
      packageName: "./local-workflow-package",
      workflowName: "review",
    });
  });
});
