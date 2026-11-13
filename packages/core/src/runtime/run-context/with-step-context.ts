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
 *
 * `options.branchId`/`stepIndex`/`stepArtifactId`/`stepAttempt` carry the
 * enclosing step's A2b dispatch context into the scope so subprompts can
 * inherit it explicitly. Replay call sites omit them on purpose: replayed
 * completed steps (and cached subprompt returns) allocate no dispatch
 * identity.
 */
export async function withStepContext<T>(
  stepId: string,
  stepDir: string,
  fn: () => Promise<T>,
  options: {
    readonly maxSubPrompts?: unknown;
    readonly cwd?: string;
    readonly executionCwd?: string;
    readonly replay?: { readonly kind: "completed-step" };
    /** Dispatch context inherited by subprompts (A2b); absent during replay. */
    readonly branchId?: string;
    readonly stepIndex?: number;
    readonly stepArtifactId?: string;
    readonly stepAttempt?: number;
  } = {},
): Promise<T> {
  const parentContext = runContextStorage.getStore();
  if (!parentContext) {
    return await fn();
  }

  let nextDocumentIndex = 0;
  let nextSubPromptIndex = 0;

  const executionCwd = options.executionCwd ?? options.cwd ?? parentContext.executionCwd;
  const stepContext = {
    ...parentContext,
    cwd: executionCwd ?? parentContext.cwd,
    executionCwd: executionCwd ?? parentContext.executionCwd,
    currentStep: {
      id: stepId,
      dir: stepDir,
      maxSubPrompts: options.maxSubPrompts,
      cwd: executionCwd ?? parentContext.cwd,
      executionCwd: executionCwd ?? parentContext.executionCwd,
      replay: options.replay,
      ...(options.branchId === undefined ? {} : { branchId: options.branchId }),
      ...(options.stepIndex === undefined ? {} : { stepIndex: options.stepIndex }),
      ...(options.stepArtifactId === undefined ? {} : { stepArtifactId: options.stepArtifactId }),
      ...(options.stepAttempt === undefined ? {} : { stepAttempt: options.stepAttempt }),
      nextDocumentIndex(): number {
        nextDocumentIndex += 1;
        return nextDocumentIndex;
      },
      nextSubPromptIndex(): number {
        nextSubPromptIndex += 1;
        return nextSubPromptIndex;
      },
    },
  };

  return await runContextStorage.run(stepContext, fn);
}
