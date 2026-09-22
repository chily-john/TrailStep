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
  async getPersisted<T = unknown>(key: string): Promise<T | undefined> {
    return currentRunContext().state.getPersisted<T>(key);
  },
  async set(key: string, value: unknown): Promise<void> {
    const context = currentRunContext();
    await context.state.set(key, value, {
      persist: context.currentStep?.replay?.kind === "completed-step" ? false : true,
    });
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
  get executionCwd(): string | undefined {
    return currentRunContext().executionCwd ?? currentRunContext().cwd;
  },
  get isReplayingCompletedStep(): boolean {
    return currentRunContext().currentStep?.replay?.kind === "completed-step";
  },
  get projectCwd(): string | undefined {
    return currentRunContext().projectCwd;
  },
};
