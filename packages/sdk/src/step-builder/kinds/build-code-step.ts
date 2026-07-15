import type { CodeStep, PlainObject } from "@stepkit/core";

export type CodeStepBuilderOptions<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> = CodeStep<TInput, TOutput> & { readonly kind: "code" };

export function buildCodeStep<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
>(options: CodeStepBuilderOptions<TInput, TOutput>): CodeStep<TInput, TOutput> {
  return options;
}
