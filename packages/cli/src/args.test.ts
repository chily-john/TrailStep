import { describe, expect, it } from "vitest";

import { CliUsageError, parseStepkitArgs, parseWorkflowId } from "./index.js";

describe("parseWorkflowId", () => {
  it("parses a scoped package workflow id by splitting on the last colon", () => {
    expect(parseWorkflowId("@acme/stepkit-workflows:reviewFeature")).toEqual({
      packageName: "@acme/stepkit-workflows",
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

describe("parseStepkitArgs", () => {
  it("parses the list command", () => {
    expect(parseStepkitArgs(["list"])).toEqual({ kind: "list" });
  });

  it("parses a workflow run with inline JSON input", () => {
    expect(
      parseStepkitArgs([
        "@acme/stepkit-workflows:reviewFeature",
        "run-001",
        "--input",
        '{"feature":"cli"}',
      ]),
    ).toEqual({
      kind: "run",
      workflowId: "@acme/stepkit-workflows:reviewFeature",
      workflowRunName: "run-001",
      workflow: {
        packageName: "@acme/stepkit-workflows",
        exportName: "reviewFeature",
      },
      input: { kind: "inline", json: '{"feature":"cli"}' },
    });
  });

  it("parses a workflow run with file JSON input", () => {
    expect(
      parseStepkitArgs([
        "@acme/stepkit-workflows:reviewFeature",
        "run-001",
        "--input-file",
        "./input.json",
      ]),
    ).toMatchObject({
      kind: "run",
      input: { kind: "file", path: "./input.json" },
    });
  });

  it("rejects both input options before a run starts", () => {
    expect(() =>
      parseStepkitArgs([
        "@acme/stepkit-workflows:reviewFeature",
        "run-001",
        "--input",
        "{}",
        "--input-file",
        "./input.json",
      ]),
    ).toThrow(/choose either --input or --input-file/i);
  });
});
