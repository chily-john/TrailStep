import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { done, step } from "../../authoring/authoring.js";
import type { Workflow } from "../../authoring/workflow/workflow.types.js";
import { runWorkflow } from "./run-workflow.js";

type Input = { maxTurns: number; summarize: boolean };

function coercionWorkflow(): Workflow<Input, { maxTurns: number; summarize: boolean }> {
  return {
    id: "coercion-workflow",
    inputShape: { maxTurns: "number", summarize: "boolean" },
    outputShape: { maxTurns: "number", summarize: "boolean" },
    start(input) {
      return step({ id: "echo-input" }).do(async () =>
        done({ maxTurns: input.maxTurns, summarize: input.summarize }),
      )(input);
    },
  };
}

describe("runWorkflow workflow-input coercion", () => {
  it("coerces stringified workflow input scalars before validation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-input-coercion-"));

    const result = await runWorkflow({
      workflow: coercionWorkflow(),
      input: { maxTurns: "25", summarize: "true" } as unknown as Input,
      runName: "coercion-run",
      cwd,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ maxTurns: 25, summarize: true });
  });

  it("still fails a genuinely invalid input with validation_failed diagnostics", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-input-coercion-invalid-"));

    const result = await runWorkflow({
      workflow: coercionWorkflow(),
      input: { maxTurns: "abc", summarize: "yes" } as unknown as Input,
      runName: "coercion-invalid-run",
      cwd,
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("expected a failure");
    }
    expect(result.failure.code).toBe("validation_failed");
    expect(result.failure.message).toContain("workflow input failed schema validation");
    expect(result.failure.details).toEqual({
      diagnostics: [
        { path: "/maxTurns", message: "must be number" },
        { path: "/summarize", message: "must be boolean" },
      ],
    });
  });
});
