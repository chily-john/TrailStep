import { AsyncLocalStorage } from "node:async_hooks";
import type { RunContext } from "../../contracts/run-context/run-context.types.js";

export const runContextStorage = new AsyncLocalStorage<RunContext>();

export function currentRunContext(): RunContext {
  const runContext = runContextStorage.getStore();
  if (!runContext) {
    throw new Error("state.* called outside an active StepKit run.");
  }

  return runContext;
}
