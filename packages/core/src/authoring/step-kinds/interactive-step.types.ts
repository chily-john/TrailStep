import type { PlainObject, Schema } from "../../shared/shape.types.js";

interface InteractiveStepBase<TOutput extends PlainObject = PlainObject> {
  readonly kind: "interactive";
  readonly id: string;
  readonly command: string;
  readonly prompt: string;
  readonly output: Schema<TOutput>;
}

export interface OpaqueInteractiveStep<TOutput extends PlainObject = PlainObject>
  extends InteractiveStepBase<TOutput> {
  readonly outputMode: "opaque";
}

export interface FileInteractiveStep<TOutput extends PlainObject = PlainObject>
  extends InteractiveStepBase<TOutput> {
  readonly outputMode: "file";
  /** Relative path under the run directory where the process writes JSON output. */
  readonly resultFile: string;
}

export type InteractiveStep<TOutput extends PlainObject = PlainObject> =
  | OpaqueInteractiveStep<TOutput>
  | FileInteractiveStep<TOutput>;
