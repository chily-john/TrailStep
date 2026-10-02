import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import type { WorkflowInvocationOptions } from "../step/continuation.types.js";
import type { DefinedWorkflow, WorkflowBuilderOptions } from "./workflow.types.js";

export type { DefinedWorkflow, WorkflowBuilderOptions } from "./workflow.types.js";

export function defineWorkflow<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
>(options: WorkflowBuilderOptions<TInput, TOutput>): DefinedWorkflow<TInput, TOutput> {
  assertBuilderObject(options, "defineWorkflow");
  if (typeof options.start !== "function") {
    throw new TypeError("defineWorkflow requires a start function.");
  }

  const workflow = ((input: TInput, invocationOptions?: WorkflowInvocationOptions) => {
    const makeInvocation = (postContinuation?: (output: TOutput) => unknown) => ({
      kind: "workflowInvocation" as const,
      workflow,
      input,
      ...(invocationOptions === undefined ? {} : { options: invocationOptions }),
      ...(postContinuation === undefined ? {} : { postContinuation }),
      post(continuation: (output: TOutput) => unknown) {
        return makeInvocation(continuation);
      },
    });

    return makeInvocation();
  }) as unknown as DefinedWorkflow<TInput, TOutput>;

  return Object.assign(workflow, options);
}

function assertBuilderObject(
  value: unknown,
  builderName: string,
): asserts value is { readonly id: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${builderName} requires a single object argument.`);
  }
  if (typeof (value as { readonly id?: unknown }).id !== "string") {
    throw new TypeError(`${builderName} requires an id string.`);
  }
}
