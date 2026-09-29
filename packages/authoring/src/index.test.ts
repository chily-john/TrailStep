import { describe, expect, it } from "vitest";

import * as Authoring from "./index.js";
import {
  type AbsoluteDoneNode,
  type AbsoluteFailNode,
  absoluteDone,
  absoluteFail,
  type ContinuationArray,
  type ContinuationResult,
  type DefinedWorkflow,
  defineWorkflow,
  done,
  isAbsoluteDoneNode,
  isAbsoluteFailNode,
  isWorkflowInvocationNode,
  jsonSchema,
  notify,
  type RunnableContinuationNode,
  step,
  subPrompt,
  type WorkflowInvocationNode,
  type WorkflowInvocationOptions,
  workflow,
} from "./index.js";

describe("@trailstep/authoring exports", () => {
  it("exports workflow authoring primitives", () => {
    expect(defineWorkflow).toBeTypeOf("function");
    expect(step).toBeTypeOf("function");
    expect(subPrompt).toBeTypeOf("function");
    expect(done).toBeTypeOf("function");
    expect(absoluteDone).toBeTypeOf("function");
    expect(absoluteFail).toBeTypeOf("function");
    expect(isWorkflowInvocationNode).toBeTypeOf("function");
    expect(isAbsoluteDoneNode).toBeTypeOf("function");
    expect(isAbsoluteFailNode).toBeTypeOf("function");
    expect(notify.progress).toBeTypeOf("function");
    expect(workflow.input).toBeTypeOf("function");
  });

  it("re-exports globalState from the public authoring entrypoint", () => {
    const globalState = (
      Authoring as unknown as {
        readonly globalState?: {
          get<T>(key: string): Promise<T | undefined>;
          set(key: string, value: unknown): Promise<void>;
          update<T>(key: string, updater: (current: T | undefined) => T | Promise<T>): Promise<T>;
        };
      }
    ).globalState;

    expect(globalState?.get).toBeTypeOf("function");
    expect(globalState?.set).toBeTypeOf("function");
    expect(globalState?.update).toBeTypeOf("function");
  });

  it("constructs and recognizes absolute terminal nodes from the entrypoint", () => {
    const doneNode = absoluteDone({ ok: true }, { message: "finished everywhere" });
    const failNode = absoluteFail(
      { code: "authoring_test_failed", message: "Failed everywhere" },
      { message: "stopped everywhere" },
    );

    expect(isAbsoluteDoneNode(doneNode)).toBe(true);
    expect(doneNode).toMatchObject({
      kind: "absoluteDone",
      output: { ok: true },
      message: "finished everywhere",
    });
    expect(isAbsoluteFailNode(failNode)).toBe(true);
    expect(failNode).toMatchObject({
      kind: "absoluteFail",
      failure: { code: "authoring_test_failed", message: "Failed everywhere" },
      message: "stopped everywhere",
    });
  });

  it("exports callable workflow and continuation public types", () => {
    const workflowDefinition = defineWorkflow<
      { readonly value: number } & Record<string, unknown>,
      { readonly value: number } & Record<string, unknown>
    >({
      id: "public-type-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return done({ value: input.value });
      },
    }) satisfies DefinedWorkflow<
      { readonly value: number } & Record<string, unknown>,
      { readonly value: number } & Record<string, unknown>
    >;

    const options = {
      branchId: "existing-plus-followup",
    } satisfies WorkflowInvocationOptions;
    const invocation = workflowDefinition({ value: 1 }, options).post((output) =>
      done({ value: Number(output.value) + 1 }),
    ) satisfies WorkflowInvocationNode<{ readonly value: number } & Record<string, unknown>>;
    const runnable = invocation satisfies RunnableContinuationNode;
    const array = [runnable] satisfies ContinuationArray;
    const continuation = invocation satisfies ContinuationResult;
    const doneNode = absoluteDone({ value: 1 }) satisfies AbsoluteDoneNode<
      {
        readonly value: number;
      } & Record<string, unknown>
    >;
    const failNode = absoluteFail({ code: "failed", message: "Failed" }) satisfies AbsoluteFailNode;

    expect(isWorkflowInvocationNode(invocation)).toBe(true);
    expect(isWorkflowInvocationNode(continuation)).toBe(true);
    expect(array).toHaveLength(1);
    expect(isAbsoluteDoneNode(doneNode)).toBe(true);
    expect(isAbsoluteFailNode(failNode)).toBe(true);
  });

  it("exports subPrompt and related public types", () => {
    expect(subPrompt).toBeTypeOf("function");

    const assertPublicSubPromptTypes = () => {
      const output = jsonSchema<{ answer: string }>({
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      });
      const requiredInputSubPrompt = subPrompt<{ path: string }, { answer: string }>(
        ({ input }) => `Read ${input.path}`,
        { output },
      );
      requiredInputSubPrompt({ path: "story.md" });
      // @ts-expect-error required input keys must be provided.
      requiredInputSubPrompt();

      // biome-ignore lint/complexity/noBannedTypes: public subPrompt authoring supports `{}` as the no-required-input type.
      const optionalInputSubPrompt = subPrompt<{}, { answer: string }>("Answer briefly.", {
        output,
      });
      optionalInputSubPrompt();
      optionalInputSubPrompt({});

      const factory = requiredInputSubPrompt satisfies import("./index.js").SubPromptFactory<
        { path: string },
        { answer: string }
      >;
      const options = {
        output,
        agent: "researcher",
        adapter: async () => undefined,
        maxSubPrompts: 3,
      } satisfies import("./index.js").SubPromptOptions<{ answer: string }>;
      const optionsWithMode = {
        // @ts-expect-error subPrompt options intentionally do not support prompt mode selection.
        mode: "working",
      } satisfies import("./index.js").SubPromptOptions<{ answer: string }>;

      return { factory, options, optionsWithMode };
    };

    expect(assertPublicSubPromptTypes).toBeTypeOf("function");
  });
});
