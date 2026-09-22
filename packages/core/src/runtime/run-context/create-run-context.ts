import type { TrailStepConfig } from "../../agent-targeting/targeting.types.js";
import type { WorkflowAgentRole } from "../../contracts/agents/agent-role.types.js";
import type {
  RunContext,
  RunContextEvent,
  RunContextGlobalState,
  RunContextProviderWorkingRunner,
  RunContextState,
  RunContextWorkingAgentProcessRunner,
} from "../../contracts/run-context/run-context.types.js";
import {
  type RunState,
  readGlobalState,
  readRunState,
  writeGlobalState,
  writeRunState,
} from "../artifacts/run-storage.js";

export function createRunContext(options: {
  readonly runId: string;
  readonly runName: string;
  readonly runDir: string;
  readonly initialState?: RunState;
  readonly workflowId?: string;
  readonly workflowAgents?: Readonly<Record<string, WorkflowAgentRole>>;
  readonly projectCwd?: string;
  readonly cwd?: string;
  readonly executionCwd?: string;
  readonly trailstepConfig?: TrailStepConfig;
  readonly workingAgentProcessRunner?: RunContextWorkingAgentProcessRunner;
  readonly providerWorkingRunner?: RunContextProviderWorkingRunner;
  readonly emit?: (event: RunContextEvent) => Promise<void>;
  readonly events?: () => readonly RunContextEvent[];
}): RunContext {
  const state = createQueuedRunState({
    read: () => readRunState(options.runDir),
    write: (nextState) => writeRunState(options.runDir, nextState),
    ...(options.initialState === undefined ? {} : { initialState: options.initialState }),
  });
  const globalState = createQueuedGlobalState({
    read: () => readGlobalState(options.runDir),
    write: (nextState) => writeGlobalState(options.runDir, nextState),
  });

  return {
    id: options.runId,
    name: options.runName,
    path: options.runDir,
    workflowId: options.workflowId,
    workflowAgents: options.workflowAgents,
    projectCwd: options.projectCwd,
    cwd: options.cwd,
    executionCwd: options.executionCwd ?? options.cwd,
    trailstepConfig: options.trailstepConfig,
    workingAgentProcessRunner: options.workingAgentProcessRunner,
    providerWorkingRunner: options.providerWorkingRunner,
    emit: options.emit,
    events: options.events,
    state,
    globalState,
  };
}

export function createQueuedRunState(options: {
  readonly read: () => Promise<RunState>;
  readonly write: (state: RunState) => Promise<void>;
  readonly initialState?: RunState;
}): RunContextState {
  let cache: RunState | undefined;
  let loadPromise: Promise<RunState> | undefined;
  let writeQueue: Promise<unknown> = Promise.resolve();

  function ensureLoaded(): Promise<RunState> {
    if (cache) return Promise.resolve(cache);
    if (options.initialState !== undefined) {
      cache = { ...options.initialState };
      return Promise.resolve(cache);
    }
    loadPromise ??= options.read().then((state) => (cache = state));
    return loadPromise;
  }

  function enqueueWrite(): Promise<void> {
    const next = writeQueue.then(async () => {
      const state = await ensureLoaded();
      await options.write(state);
    });
    writeQueue = next.catch(() => {});
    return next;
  }

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const state = await ensureLoaded();
      return state[key] as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      const state = await ensureLoaded();
      state[key] = value;
      await enqueueWrite();
    },
  };
}

export function createQueuedGlobalState(options: {
  readonly read: () => Promise<RunState>;
  readonly write: (state: RunState) => Promise<void>;
}): RunContextGlobalState {
  let cache: RunState | undefined;
  let loadPromise: Promise<RunState> | undefined;
  let mutationQueue: Promise<unknown> = Promise.resolve();

  function ensureLoaded(): Promise<RunState> {
    if (cache) return Promise.resolve(cache);
    loadPromise ??= options.read().then((state) => (cache = state));
    return loadPromise;
  }

  function enqueueMutation<T>(mutation: (state: RunState) => Promise<T>): Promise<T> {
    const next = mutationQueue.then(async () => {
      const state = await ensureLoaded();
      return await mutation(state);
    });
    mutationQueue = next.catch(() => {});
    return next;
  }

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const state = await mutationQueue.then(() => ensureLoaded());
      return state[key] as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      await enqueueMutation(async (state) => {
        state[key] = value;
        await options.write(state);
      });
    },
    async update<T = unknown>(
      key: string,
      updater: (current: T | undefined) => T | Promise<T>,
    ): Promise<T> {
      return await enqueueMutation(async (state) => {
        const updated = await updater(state[key] as T | undefined);
        state[key] = updated;
        await options.write(state);
        return updated;
      });
    },
  };
}
