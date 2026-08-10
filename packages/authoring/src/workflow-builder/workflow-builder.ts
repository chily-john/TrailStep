import type { PlainObject } from "@trailstep/core";
import { assertBuilderObject } from "../shared/assert-builder-object.js";
import type { DefinedWorkflow, WorkflowBuilderOptions } from "./workflow-builder.types.js";

export function defineWorkflow<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
>(options: WorkflowBuilderOptions<TInput, TOutput>): DefinedWorkflow<TInput, TOutput> {
  assertBuilderObject(options, "defineWorkflow");
  if (typeof options.start !== "function")
    throw new TypeError("defineWorkflow requires a start function.");
  return options;
}
