import { describe, expect, it } from "vitest";

import { CliUsageError } from "../../command.types.js";
import { parseRunInvocation } from "./parse-run-invocation.js";

describe("parseRunInvocation", () => {
  it("parses a workflow ref without an explicit run name and inline input", () => {
    const invocation = parseRunInvocation([
      "@acme/trailstep-workflows:reviewFeature",
      "--input",
      '{"ok":true}',
    ]);

    expect(invocation).toMatchObject({
      workflowId: "@acme/trailstep-workflows:reviewFeature",
      input: { kind: "inline", json: '{"ok":true}' },
    });
    expect(invocation).not.toHaveProperty("workflowRunName");
  });

  it("parses a direct workflow file ref without requiring package-qualified syntax", () => {
    const invocation = parseRunInvocation(["./workflows/review.mjs", "--input", "{}"]);

    expect(invocation).toMatchObject({
      workflowId: "./workflows/review.mjs",
      input: { kind: "inline", json: "{}" },
    });
    expect(invocation).not.toHaveProperty("workflow");
  });

  it("parses a workflow ref with an explicit run name and input file", () => {
    expect(
      parseRunInvocation([
        "@acme/trailstep-workflows:reviewFeature",
        "my-run",
        "--input-file",
        "input.json",
      ]),
    ).toMatchObject({
      workflowId: "@acme/trailstep-workflows:reviewFeature",
      workflowRunName: "my-run",
      input: { kind: "file", path: "input.json" },
    });
  });

  it("rejects legacy resume syntax and points users to retry", () => {
    expect(() =>
      parseRunInvocation(["@acme/trailstep-workflows:reviewFeature", "--resume"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseRunInvocation(["@acme/trailstep-workflows:reviewFeature", "--resume"]),
    ).toThrow(/trailstep retry/i);
  });

  it("keeps clear usage errors for unknown options", () => {
    expect(() =>
      parseRunInvocation(["@acme/trailstep-workflows:reviewFeature", "--bogus"]),
    ).toThrow(/Unknown option: --bogus/);
  });

  it("keeps clear usage errors for conflicting input options", () => {
    expect(() =>
      parseRunInvocation([
        "@acme/trailstep-workflows:reviewFeature",
        "my-run",
        "--input",
        "{}",
        "--input-file",
        "input.json",
      ]),
    ).toThrow(/Choose either --input or --input-file/);
  });
});
