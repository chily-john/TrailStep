import type { PlainObject, Workflow } from "@stepkit/core";

export interface WorkflowBuilderOptions<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> extends Workflow<TInput, TOutput> {
  readonly description?: string;
  readonly start: (input: TInput) => ReturnType<NonNullable<Workflow<TInput, TOutput>["start"]>>;
}

export type DefinedWorkflow<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> = Workflow<TInput, TOutput> & { readonly description?: string };
