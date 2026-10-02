import { currentRunContext } from "../../runtime/run-context/run-context-storage.js";

/** Ambient handle onto the active run's track-scoped durable key-value store. */
export const globalState = {
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return currentRunContext().globalState.get<T>(key);
  },
  async set(key: string, value: unknown): Promise<void> {
    await currentRunContext().globalState.set(key, value);
  },
  async update<T = unknown>(
    key: string,
    updater: (current: T | undefined) => T | Promise<T>,
  ): Promise<T> {
    return await currentRunContext().globalState.update<T>(key, updater);
  },
};
