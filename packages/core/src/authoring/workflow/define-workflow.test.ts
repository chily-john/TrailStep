import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import type { PlainObject, Schema } from "../../contracts/shapes/shape.types.js";
import { runWorkflow } from "../../runtime/run-workflow/run-workflow.js";
import type { ContinuationResult } from "../step/continuation.types.js";
import { done, isDoneNode, isWorkflowInvocationNode, step } from "../step/step-node.js";
import type { DefinedWorkflow } from "./define-workflow.js";
import { defineWorkflow } from "./define-workflow.js";
import type { Workflow } from "./workflow.types.js";

type Input = { value: number };
type Output = { ok: boolean };

const inputSchema = schema<Input>();
const outputSchema = schema<Output>();

function schema<T extends PlainObject>(): Schema<T> {
  return {
    validate: (value): value is T => typeof value === "object" && value !== null,
    diagnostics: () => [],
    assert: (value) => value as T,
    jsonSchema: { type: "object" },
  };
}

describe("defineWorkflow", () => {
  it("returns a callable workflow while preserving object metadata and sequential start", () => {
    const workflow = defineWorkflow<Input, Output>({
      id: "callable-workflow",
      description: "A callable workflow definition.",
      skill: { description: "Use this workflow.", instructions: "Return ok." },
      input: inputSchema,
      output: outputSchema,
      inputShape: { value: "number" },
      outputShape: { ok: "boolean" },
      agents: { implementer: { size: "small" } },
      retry: { maxAttempts: 2 },
      timeout: 30_000,
      start(input: Input) {
        return done({ ok: input.value > 0 });
      },
    });

    const assignableWorkflow: Workflow<Input, Output> = workflow;
    expectTypeOf(workflow).toMatchTypeOf<DefinedWorkflow<Input, Output>>();
    expect(assignableWorkflow).toBe(workflow);
    expect(typeof workflow).toBe("function");
    expect(workflow.id).toBe("callable-workflow");
    expect(workflow.description).toBe("A callable workflow definition.");
    expect(workflow.skill).toEqual({
      description: "Use this workflow.",
      instructions: "Return ok.",
    });
    expect(workflow.input).toBe(inputSchema);
    expect(workflow.output).toBe(outputSchema);
    expect(workflow.inputShape).toEqual({ value: "number" });
    expect(workflow.outputShape).toEqual({ ok: "boolean" });
    expect(workflow.agents).toEqual({ implementer: { size: "small" } });
    expect(workflow.retry).toEqual({ maxAttempts: 2 });
    expect(workflow.timeout).toBe(30_000);

    const sequential = workflow.start({ value: 1 });
    expect(isDoneNode(sequential)).toBe(true);
    expect(sequential).toEqual({ kind: "done", output: { ok: true } });
  });

  it("creates recognizable workflow invocation nodes that point back to the same workflow", () => {
    const workflow = defineWorkflow<Input, Output>({
      id: "invoked-workflow",
      inputShape: { value: "number" },
      outputShape: { ok: "boolean" },
      start: () => done({ ok: true }),
    });

    const node = workflow({ value: 1 });

    expect(isWorkflowInvocationNode(node)).toBe(true);
    expect(node.workflow).toBe(workflow);
    expect(node.input).toEqual({ value: 1 });
  });

  it("preserves invocation options without executing post", () => {
    let postCalls = 0;
    const post = (output: Output) => {
      postCalls += 1;
      return done({ complete: output.ok });
    };
    const workflow = defineWorkflow<Input, Output>({
      id: "invoked-with-options",
      inputShape: { value: "number" },
      outputShape: { ok: "boolean" },
      start: () => done({ ok: true }),
    });

    const node = workflow({ value: 1 }, { branchId: "existing-plus-followup" }).post(post);

    expect(isWorkflowInvocationNode(node)).toBe(true);
    expect(node.options?.branchId).toBe("existing-plus-followup");
    expect(node.postContinuation).toBe(post);
    expect(postCalls).toBe(0);
  });

  it("runs sequentially through runWorkflow without changing existing behavior", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-define-workflow-"));
    const workflow = defineWorkflow<Input, Output>({
      id: "defined-sequential-workflow",
      inputShape: { value: "number" },
      outputShape: { ok: "boolean" },
      start: (input: Input) => done({ ok: input.value === 1 }),
    });

    const result = await runWorkflow({
      workflow,
      input: { value: 1 },
      runName: "defined-sequential-workflow-run",
      cwd,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ ok: true });
  });

  it("types continuation callbacks that return a step node and workflow invocation array", () => {
    const SomeStep = step({ id: "some-step" }).do((input: Input) => done({ ok: input.value > 0 }));
    const SomeWorkflow = defineWorkflow<Input, Output>({
      id: "some-workflow",
      inputShape: { value: "number" },
      outputShape: { ok: "boolean" },
      start: () => done({ ok: true }),
    });

    const continuation = (_input: Input): ContinuationResult => [
      SomeStep(_input),
      SomeWorkflow({ value: 1 }),
    ];

    expectTypeOf(continuation).returns.toMatchTypeOf<ContinuationResult>();
  });
});
