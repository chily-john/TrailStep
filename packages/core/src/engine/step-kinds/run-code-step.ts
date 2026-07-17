import type { PlainObject } from "../../shared/shape.types.js";

/**
 * The "code" step kind's execution path: invoke the user-supplied `run`
 * function with its validated input. Called from `dispatchContinuationStep`
 * in `step-dispatch.ts`.
 */
export async function runCodeStep<TInput extends PlainObject, TOutput extends PlainObject>(
  run: (input: TInput) => TOutput | Promise<TOutput>,
  input: TInput,
): Promise<TOutput> {
  return await run(input);
}
