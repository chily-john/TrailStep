import type { RunContext } from "../../contracts/run-context/run-context.types.js";
import { readRunState, writeRunState } from "../artifacts/run-storage.js";

export function createRunContext(options: {
  readonly runId: string;
  readonly runName: string;
  readonly runDir: string;
}): RunContext {
  return {
    id: options.runId,
    name: options.runName,
    path: options.runDir,
    state: {
      async get<T = unknown>(key: string): Promise<T | undefined> {
        const state = await readRunState(options.runDir);
        return state[key] as T | undefined;
      },
      async set(key: string, value: unknown): Promise<void> {
        const state = await readRunState(options.runDir);
        await writeRunState(options.runDir, { ...state, [key]: value });
      },
    },
  };
}
