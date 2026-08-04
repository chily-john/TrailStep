import { currentRunContext } from "../../runtime/run-context/run-context-storage.js";

/**
 * Ambient handle onto the active run's identity and durable key-value store.
 * Backed by AsyncLocalStorage, set once per run by `runWorkflow`; step
 * continuations import this directly rather than receiving it as an argument.
 */
export const state = {
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return currentRunContext().state.get<T>(key);
  },
  async set(key: string, value: unknown): Promise<void> {
    await currentRunContext().state.set(key, value);
  },
  get id(): string {
    return currentRunContext().id;
  },
  get name(): string {
    return currentRunContext().name;
  },
  get path(): string {
    return currentRunContext().path;
  },
  get cwd(): string | undefined {
    return currentRunContext().cwd;
  },
};
