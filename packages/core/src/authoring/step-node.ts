import type { PlainObject } from "../shared/shape.types.js";
import type {
  ContinuationStepConfig,
  DoneNode,
  StepContinuation,
  StepErrorContinuation,
  StepNode,
} from "./continuation.types.js";

export function step<TInput extends PlainObject, TOutput extends PlainObject>(
  config: ContinuationStepConfig<TInput, TOutput>,
  onOutput: StepContinuation<TOutput>,
  onError?: StepErrorContinuation,
): StepNode<TInput, TOutput> {
  return {
    kind: "step",
    config,
    onOutput,
    onError,
  };
}

export function done<TOutput extends PlainObject>(output: TOutput): DoneNode<TOutput> {
  return {
    kind: "done",
    output,
  };
}

export function isStepNode(value: unknown): value is StepNode {
  return isPlainObject(value) && value.kind === "step";
}

export function isDoneNode(value: unknown): value is DoneNode {
  return isPlainObject(value) && value.kind === "done";
}

function isPlainObject(value: unknown): value is PlainObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
