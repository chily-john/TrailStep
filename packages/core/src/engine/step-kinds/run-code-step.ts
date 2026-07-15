import type { PlainObject } from "../../shared/shape.types.js";

/**
 * The "code" step kind's execution path: invoke the user-supplied `run`
 * function with its validated input. Extracted from the step-dispatch switch
 * in `runtime.ts` so both the continuation (`step(...)`) and legacy
 * `steps: [...]` execution paths share one implementation.
 */
export async function runCodeStep<TInput extends PlainObject, TOutput extends PlainObject>(
  run: (input: TInput) => TOutput | Promise<TOutput>,
  input: TInput,
): Promise<TOutput> {
  return await run(input);
}
