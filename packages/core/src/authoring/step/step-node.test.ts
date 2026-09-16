import { describe, expect, expectTypeOf, it } from "vitest";

import type { Workflow } from "../workflow/workflow.types.js";
import type {
  ContinuationArray,
  ContinuationResult,
  WorkflowInvocationNode,
} from "./continuation.types.js";
import {
  absoluteDone,
  absoluteFail,
  done,
  fail,
  isAbsoluteDoneNode,
  isAbsoluteFailNode,
  isDoneNode,
  isFailNode,
  isWorkflowInvocationNode,
  step,
} from "./step-node.js";

describe("Slice 1 continuation nodes", () => {
  it("constructs and identifies absolute done nodes without matching normal done nodes", () => {
    const node = absoluteDone({ value: 1 }, { message: "finished" });

    expect(node).toEqual({
      kind: "absoluteDone",
      output: { value: 1 },
      message: "finished",
    });
    expect(isAbsoluteDoneNode(node)).toBe(true);
    expect(isDoneNode(node)).toBe(false);
  });

  it("constructs and identifies absolute fail nodes without matching normal fail nodes", () => {
    const failure = { code: "blocked", message: "Cannot continue." };
    const node = absoluteFail(failure, { message: "blocked track" });

    expect(node).toEqual({
      kind: "absoluteFail",
      failure,
      message: "blocked track",
    });
    expect(isAbsoluteFailNode(node)).toBe(true);
    expect(isFailNode(node)).toBe(false);
  });

  it("identifies workflow invocation nodes and preserves invocation metadata without calling onDone", () => {
    let onDoneCalls = 0;
    const onDone = (_output: { ok: boolean }) => {
      onDoneCalls += 1;
      return done({ complete: true });
    };
    const workflow: Workflow<{ value: number }, { ok: boolean }> = {
      id: "child-workflow",
      inputShape: { value: "number" },
      outputShape: { ok: "boolean" },
      start: () => done({ ok: true }),
    };
    const invocationNode: WorkflowInvocationNode<{ value: number }, { ok: boolean }> = {
      kind: "workflowInvocation",
      workflow,
      input: { value: 1 },
      options: {
        branch: "child-branch",
        onDone,
      },
    };

    expect(isWorkflowInvocationNode(invocationNode)).toBe(true);
    expect(invocationNode.workflow).toBe(workflow);
    expect(invocationNode.input).toEqual({ value: 1 });
    expect(invocationNode.options?.branch).toBe("child-branch");
    expect(invocationNode.options?.onDone).toBe(onDone);
    expect(onDoneCalls).toBe(0);
  });

  it("types continuation arrays as runnable nodes only", () => {
    const someStep = step({ id: "some-step" }).do((input: { value: number }) => done(input));
    const workflow: Workflow<{ value: number }, { ok: boolean }> = {
      id: "child-workflow",
      inputShape: { value: "number" },
      outputShape: { ok: "boolean" },
      start: () => done({ ok: true }),
    };
    const invocationNode: WorkflowInvocationNode<{ value: number }, { ok: boolean }> = {
      kind: "workflowInvocation",
      workflow,
      input: { value: 1 },
    };

    const result: ContinuationResult = [someStep({ value: 1 }), invocationNode];
    expectTypeOf(result).toMatchTypeOf<ContinuationResult>();

    // @ts-expect-error terminal done nodes are not runnable continuation candidates.
    const invalidContinuationArray: ContinuationArray = [done({})] as const;
    expect(invalidContinuationArray).toEqual([done({})]);
  });

  it("keeps normal done and fail predicates distinct from absolute terminal kinds", () => {
    expect(isDoneNode(done({}))).toBe(true);
    expect(isFailNode(fail({ code: "x", message: "failed" }))).toBe(true);
    expect(isAbsoluteDoneNode({ kind: "done", output: {} })).toBe(false);
    expect(isAbsoluteFailNode({ kind: "fail", failure: { code: "x", message: "failed" } })).toBe(
      false,
    );
  });
});
