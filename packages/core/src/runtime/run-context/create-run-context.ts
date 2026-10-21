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

/**
 * Report a persistence failure alongside the rejection handed back to the
 * caller that triggered it. Written to stderr so MCP/CLI protocol channels
 * (stdout) stay clean. Never throws: this runs inside the queue's catch link,
 * so a failing stderr write must not poison the queue for later operations.
 */
function reportPersistFailure(scope: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    process.stderr.write(`trailstep: ${scope} persistence failed: ${message}\n`);
  } catch {
    // Observability must never break the write queue itself.
  }
}

export function createQueuedRunState(options: {
  readonly read: () => Promise<RunState>;
  readonly write: (state: RunState) => Promise<void>;
  readonly initialState?: RunState;
}): RunContextState {
  let cache: RunState | undefined;
  let loadPromise: Promise<RunState> | undefined;
  let writeQueue: Promise<unknown> = Promise.resolve();
  let lastPersistError: unknown;

  function ensureLoaded(): Promise<RunState> {
    if (cache) return Promise.resolve(cache);
    if (options.initialState !== undefined) {
      cache = { ...options.initialState };
      return Promise.resolve(cache);
    }
    loadPromise ??= options.read().then(
      (state) => (cache = state),
      (error: unknown) => {
        // Never cache a rejected load: the next access retries the read instead
        // of rejecting forever with this same error (queue poisoning).
        loadPromise = undefined;
        throw error;
      },
    );
    return loadPromise;
  }

  function enqueueWrite(): Promise<void> {
    const next = writeQueue.then(async () => {
      const state = await ensureLoaded();
      await options.write(state);
    });
    // The queue link must stay resolvable after a failed write so later
    // operations still run. The catch reaction attached here runs before the
    // one returned below, so it stores (and reports) the failure first; the
    // awaiter for THIS write then drains that stored copy exactly once. A later
    // successful write must never inherit the earlier failure.
    writeQueue = next.catch((error: unknown) => {
      lastPersistError = error;
      reportPersistFailure("run state", error);
    });
    return next.catch((error: unknown) => drainPersistError(error));
  }

  /**
   * Consume the stored persistence failure for the write that produced it and
   * clear the slot, so the failure surfaces once — to the caller that triggered
   * it — and never onto an unrelated later success. Always throws: the stored
   * copy when present, otherwise the write's own error as a defensive fallback
   * so a failed write can never settle as a success.
   */
  function drainPersistError(fallback: unknown): never {
    const error = lastPersistError === undefined ? fallback : lastPersistError;
    lastPersistError = undefined;
    throw error;
  }

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const state = await ensureLoaded();
      return state[key] as T | undefined;
    },
    async getPersisted<T = unknown>(key: string): Promise<T | undefined> {
      const state = await options.read();
      return state[key] as T | undefined;
    },
    async hydratePersisted(): Promise<void> {
      const persisted = await options.read();
      const state = await ensureLoaded();
      cache = { ...state, ...persisted };
    },
    async set(
      key: string,
      value: unknown,
      options: { readonly persist?: boolean } = {},
    ): Promise<void> {
      const state = await ensureLoaded();
      state[key] = value;
      if (options.persist !== false) {
        await enqueueWrite();
      }
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
  let lastPersistError: unknown;

  function ensureLoaded(): Promise<RunState> {
    if (cache) return Promise.resolve(cache);
    loadPromise ??= options.read().then(
      (state) => (cache = state),
      (error: unknown) => {
        // Never cache a rejected load: the next access retries the read instead
        // of rejecting forever with this same error (queue poisoning).
        loadPromise = undefined;
        throw error;
      },
    );
    return loadPromise;
  }

  function enqueueMutation<T>(mutation: (state: RunState) => Promise<T>): Promise<T> {
    const next = mutationQueue.then(async () => {
      const state = await ensureLoaded();
      return await mutation(state);
    });
    // Same contract as the run-state queue: keep the link alive, store and
    // report the failure for THIS mutation's awaiter (the catch reaction
    // attached here runs first), and never let a later successful mutation
    // inherit it.
    mutationQueue = next.catch((error: unknown) => {
      lastPersistError = error;
      reportPersistFailure("global state", error);
    });
    return next.catch((error: unknown) => drainPersistError(error));
  }

  /**
   * Consume the stored persistence failure for the mutation that produced it
   * and clear the slot, so the failure surfaces once — to the caller that
   * triggered it — and never onto an unrelated later success. Always throws:
   * the stored copy when present, otherwise the mutation's own error as a
   * defensive fallback so a failed mutation can never settle as a success.
   */
  function drainPersistError(fallback: unknown): never {
    const error = lastPersistError === undefined ? fallback : lastPersistError;
    lastPersistError = undefined;
    throw error;
  }

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const state = await mutationQueue.then(() => ensureLoaded());
      return state[key] as T | undefined;
    },
    async getPersisted<T = unknown>(key: string): Promise<T | undefined> {
      const state = await mutationQueue.then(() => options.read());
      return state[key] as T | undefined;
    },
    async hydratePersisted(): Promise<void> {
      await enqueueMutation(async (state) => {
        const persisted = await options.read();
        for (const [key, value] of Object.entries(persisted)) {
          state[key] = value;
        }
      });
    },
    async set(
      key: string,
      value: unknown,
      setOptions: { readonly persist?: boolean } = {},
    ): Promise<void> {
      await enqueueMutation(async (state) => {
        state[key] = value;
        if (setOptions.persist !== false) {
          await options.write(state);
        }
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
