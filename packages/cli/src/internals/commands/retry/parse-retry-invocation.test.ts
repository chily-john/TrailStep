import { describe, expect, it } from "vitest";

import { CliUsageError } from "../../command.types.js";
import { parseRetryInvocation } from "./parse-retry-invocation.js";

describe("parseRetryInvocation", () => {
  it("parses an explicit retry target", () => {
    expect(parseRetryInvocation(["retry", "project/review", "failed-run"])).toEqual({
      mode: "explicit",
      workflowId: "project/review",
      workflowRunName: "failed-run",
    });
  });

  it("rejects --step because retry V1 targets latest unresolved failures only", () => {
    expect(() =>
      parseRetryInvocation(["retry", "project/review", "failed-run", "--step", "draft"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseRetryInvocation(["retry", "project/review", "failed-run", "--step", "draft"]),
    ).toThrow(/--step.*not supported|latest unresolved/i);
  });

  it("rejects --step even when no workflow run target is present", () => {
    expect(() => parseRetryInvocation(["retry", "--step", "draft"])).toThrow(
      /--step.*not supported|latest unresolved/i,
    );
  });

  it("parses no-argument retry as interactive target selection", () => {
    expect(parseRetryInvocation(["retry"])).toEqual({ mode: "interactive" });
  });

  it("rejects a workflow ref without a run name", () => {
    expect(() => parseRetryInvocation(["retry", "project/review"])).toThrow(
      /Expected stepkit retry <workflow-ref> <runName>/,
    );
  });

  it("rejects unknown flags", () => {
    expect(() => parseRetryInvocation(["retry", "project/review", "failed-run", "--bogus"])).toThrow(
      /Unknown option: --bogus/,
    );
  });
});
