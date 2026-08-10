import { AsyncLocalStorage } from "node:async_hooks";
import type { RunContext } from "../../contracts/run-context/run-context.types.js";

/**
 * A module-scoped `new AsyncLocalStorage()` is not safe here: the CLI's
 * direct-file workflow resolver loads workflow source through `tsx`'s
 * `tsImport`, which re-transpiles and re-evaluates everything reachable from
 * that entry point -- including this module -- as a second, independent
 * instantiation, even though it's the exact same file on disk. Two distinct
 * `AsyncLocalStorage` objects never see each other's stores no matter how
 * carefully `.run(...)` is nested, so `run-workflow.ts`/`with-step-context.ts`
 * (loaded the normal way) and a workflow's own step code (loaded via
 * `tsImport`) would silently end up talking to two different storages.
 * Keying the single instance off a well-known symbol on `globalThis` -- shared
 * by every module instantiation within the same process/realm -- keeps them
 * talking to the same storage regardless of which loader touched this file.
 */
const RUN_CONTEXT_STORAGE_KEY = Symbol.for("trailstep.core.runContextStorage");

interface GlobalWithRunContextStorage {
  [RUN_CONTEXT_STORAGE_KEY]?: AsyncLocalStorage<RunContext>;
}

const globalScope = globalThis as GlobalWithRunContextStorage;

function getOrCreateRunContextStorage(): AsyncLocalStorage<RunContext> {
  const existing = globalScope[RUN_CONTEXT_STORAGE_KEY];
  if (existing) {
    return existing;
  }

  const created = new AsyncLocalStorage<RunContext>();
  globalScope[RUN_CONTEXT_STORAGE_KEY] = created;
  return created;
}

export const runContextStorage: AsyncLocalStorage<RunContext> = getOrCreateRunContextStorage();

export function currentRunContext(): RunContext {
  const runContext = runContextStorage.getStore();
  if (!runContext) {
    throw new Error("state.* called outside an active TrailStep run.");
  }

  return runContext;
}
