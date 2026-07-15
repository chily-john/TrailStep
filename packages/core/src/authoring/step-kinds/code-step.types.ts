import type { PlainObject, Schema } from "../../shared/shape.types.js";

export interface CodeStep<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly kind?: "code";
  readonly id: string;
  readonly input: Schema<TInput>;
  readonly output: Schema<TOutput>;
  run(input: TInput): TOutput | Promise<TOutput>;
}
