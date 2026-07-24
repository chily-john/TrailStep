import { runContextStorage } from "./run-context-storage.js";

/**
 * Runs `fn` with a step-scoped ambient `RunContext.currentStep` shadowing
 * whatever run-level context is already active (set once, for the whole
 * run, by `run-workflow.ts`). This is a genuine nested `AsyncLocalStorage`
 * scope — it does not mutate or replace the outer context, only shadows it
 * for the duration of `fn`, so code outside any step (or in a sibling step)
 * is unaffected.
 *
 * `nextDocumentIndex()` hands out 1, 2, 3, ... on each call within this one
 * invocation of `withStepContext` — a fresh counter every time, including
 * across resume replay of already-completed steps and retries of a failed
 * step, since each of those call sites invokes `withStepContext` anew.
 *
 * If there is no ambient run context at all (a step-executing function
 * called directly, outside of `runWorkflow`'s `runContextStorage.run(...)`
 * scope — e.g. unit tests that exercise the resume/continuation internals
 * in isolation), this falls back to running `fn` with no ambient context,
 * matching prior behavior exactly rather than throwing.
 */
export async function withStepContext<T>(
  stepId: string,
  stepDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const parentContext = runContextStorage.getStore();
  if (!parentContext) {
    return await fn();
  }

  let nextIndex = 0;

  const stepContext = {
    ...parentContext,
    currentStep: {
      id: stepId,
      dir: stepDir,
      nextDocumentIndex(): number {
        nextIndex += 1;
        return nextIndex;
      },
    },
  };

  return await runContextStorage.run(stepContext, fn);
}
