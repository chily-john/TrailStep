import type { StepKitConfig } from "../../agent-targeting/targeting.types.js";
import type { WorkflowAgentRole } from "../../contracts/agents/agent-role.types.js";
import type {
  RunContext,
  RunContextEvent,
  RunContextProviderWorkingRunner,
  RunContextWorkingAgentProcessRunner,
} from "../../contracts/run-context/run-context.types.js";
import { type RunState, readRunState, writeRunState } from "../artifacts/run-storage.js";

export function createRunContext(options: {
  readonly runId: string;
  readonly runName: string;
  readonly runDir: string;
  readonly workflowId?: string;
  readonly workflowAgents?: Readonly<Record<string, WorkflowAgentRole>>;
  readonly cwd?: string;
  readonly stepkitConfig?: StepKitConfig;
  readonly workingAgentProcessRunner?: RunContextWorkingAgentProcessRunner;
  readonly providerWorkingRunner?: RunContextProviderWorkingRunner;
  readonly emit?: (event: RunContextEvent) => Promise<void>;
  readonly events?: () => readonly RunContextEvent[];
}): RunContext {
  // Cache + load memoization scope this instance's state to a single process:
  // a resumed run creates a fresh RunContext and reloads from disk, so staleness
  // across process boundaries isn't a concern.
  let cache: RunState | undefined;
  let loadPromise: Promise<RunState> | undefined;
  let writeQueue: Promise<unknown> = Promise.resolve();

  function ensureLoaded(): Promise<RunState> {
    if (cache) return Promise.resolve(cache);
    loadPromise ??= readRunState(options.runDir).then((state) => (cache = state));
    return loadPromise;
  }

  // Writes are serialized behind this instance's cache so that concurrent
  // `set` calls (parallel steps) can't interleave their disk writes out of
  // mutation order; each queued write flushes whatever the cache holds when
  // it actually runs, so the file always converges on the latest state.
  function enqueueWrite(): Promise<void> {
    const next = writeQueue.then(async () => {
      // `enqueueWrite` is only invoked after `ensureLoaded` has resolved (see
      // `set` below), so this call resolves synchronously against the
      // already-populated cache rather than re-reading from disk.
      const state = await ensureLoaded();
      await writeRunState(options.runDir, state);
    });
    writeQueue = next.catch(() => {});
    return next;
  }

  return {
    id: options.runId,
    name: options.runName,
    path: options.runDir,
    workflowId: options.workflowId,
    workflowAgents: options.workflowAgents,
    cwd: options.cwd,
    stepkitConfig: options.stepkitConfig,
    workingAgentProcessRunner: options.workingAgentProcessRunner,
    providerWorkingRunner: options.providerWorkingRunner,
    emit: options.emit,
    events: options.events,
    state: {
      async get<T = unknown>(key: string): Promise<T | undefined> {
        const state = await ensureLoaded();
        return state[key] as T | undefined;
      },
      async set(key: string, value: unknown): Promise<void> {
        const state = await ensureLoaded();
        state[key] = value;
        await enqueueWrite();
      },
    },
  };
}
