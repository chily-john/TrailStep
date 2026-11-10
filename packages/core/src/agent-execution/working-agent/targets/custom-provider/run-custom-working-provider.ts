import { stat } from "node:fs/promises";
import type {
  TrailStepAgentTarget,
  TrailStepConfig,
} from "../../../../agent-targeting/targeting.types.js";
import type { AgentStepRequestConfig } from "../../../../authoring/step/agent-step.types.js";
import { resolveCliCommandForSpawn } from "../../../../cli-provider-runtime/process/resolve-cli-command.js";
import type { WorkflowAgentRole } from "../../../../contracts/agents/agent-role.types.js";
import type { DispatchProvenanceContext } from "../../../../contracts/dispatch-provenance/dispatch-provenance.types.js";
import { TrailStepFailureError } from "../../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../../contracts/shapes/shape.types.js";
import { errorMessage } from "../../../../json/guards.js";
import {
  attachSpawnEventId,
  dispatchProvenanceFields,
} from "../../../../runtime/dispatch-provenance/dispatch-provenance.js";
import { createEvent } from "../../../../runtime/events/create-run-event.js";
import type {
  Event,
  WorkingAgentProcessResult,
  WorkingAgentProcessRunner,
} from "../../../../runtime/run-workflow/run-workflow.types.js";
import { withBoundedSettlement } from "../../../child-process/child-process-termination.js";
import type { WorkingAgentFiles } from "../../artifacts/resolve-step-agent-files.js";
import type { AgentProgressTracker } from "../../liveness/agent-progress-tracker.js";
import { readWorkingAgentOutput } from "../../output/read-working-agent-output.js";
import { buildWorkingAgentArgs } from "./build-working-agent-args.js";
import { spawnWorkingAgentProcess } from "./spawn-working-agent-process.js";

export async function runCustomWorkingProvider<TOutput extends PlainObject>(options: {
  readonly config: TrailStepConfig;
  readonly step: AgentStepRequestConfig<PlainObject, TOutput>;
  readonly role: WorkflowAgentRole;
  readonly cwd: string;
  readonly runner?: WorkingAgentProcessRunner;
  readonly target: TrailStepAgentTarget;
  /** 1-based position of this target in the fallback chain (A2b). Defaults to 1 for direct/legacy calls. */
  readonly targetOrdinal?: number;
  /** 1-based process-level spawn retry for the work phase (A2b). Defaults to 1 for direct/legacy calls. */
  readonly workSpawnTry?: number;
  /** Explicit A2b dispatch context for provenance on working-agent events. */
  readonly dispatchProvenance?: DispatchProvenanceContext;
  readonly files: WorkingAgentFiles;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly progress?: AgentProgressTracker;
  readonly emit: (event: Event) => Promise<void>;
  readonly runId: string;
  readonly workflowId: string;
}): Promise<TOutput> {
  const agentConfig = options.config.customProviders[options.target.provider];
  if (!agentConfig) {
    throw new TrailStepFailureError({
      code: "agent_provider_unavailable",
      message: `Working agent target '${options.target.provider}' does not reference a configured custom agent.`,
      details: { provider: options.target.provider },
    });
  }

  const thinking = options.target.thinking ?? options.role.thinking;
  const args = buildWorkingAgentArgs({
    argv: options.target.args ?? agentConfig.args,
    promptFile: options.files.promptFile,
    outputFile: options.files.outputFile,
    model: options.target.model,
    thinking,
  });

  const targetOrdinal = options.targetOrdinal ?? 1;
  const workSpawnTry = options.workSpawnTry ?? 1;
  const dispatchProvenance = options.dispatchProvenance;

  // Emit agent.spawned and retain the constructed event: its ID is the
  // actual-attempt anchor referenced by prompt/output/failure events.
  const spawnedEvent = createEvent({
    runId: options.runId,
    workflowId: options.workflowId,
    stepId: options.step.id,
    type: "agent.spawned",
    payload: {
      provider: options.target.provider,
      model: options.target.model,
      phase: "work",
      promptFile: options.files.promptFile,
      outputFile: options.files.outputFile,
      ...dispatchProvenanceFields(dispatchProvenance, { targetOrdinal, workSpawnTry }),
    },
  });
  await options.emit(spawnedEvent);
  const spawnEventId = spawnedEvent.id;

  // Emit agent.promptSent
  await options.emit(
    createEvent({
      runId: options.runId,
      workflowId: options.workflowId,
      stepId: options.step.id,
      type: "agent.promptSent",
      payload: {
        phase: "work",
        promptFile: options.files.promptFile,
        ...dispatchProvenanceFields(dispatchProvenance, {
          targetOrdinal,
          workSpawnTry,
          spawnEventId,
        }),
      },
    }),
  );

  let result: WorkingAgentProcessResult;
  // Link caller cancellation and the step timeout into one signal so a
  // timed-out run actually terminates the child process tree (the spawn
  // primitive kills on abort) instead of leaking it. The race rejection
  // below still covers runners that ignore the signal entirely. The timer is
  // always cleared on settle so idle timeouts cannot fire into later steps.
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = (): void => controller.abort();
  if (options.signal?.aborted === true) {
    controller.abort();
  } else {
    options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let spawnPromiseSettled: Promise<void> | undefined;
  try {
    // Custom binaries may also be npm .cmd shims on Windows; resolve to the
    // Node entrypoint (no-op on other platforms) so shell:false keeps working.
    const executable = await resolveCliCommandForSpawn({
      command: agentConfig.binary,
      args,
    });
    const spawnPromise = (options.runner ?? spawnWorkingAgentProcess)({
      command: executable.command,
      args: executable.args,
      cwd: options.cwd,
      shell: false,
      stdio: "inherit",
      promptFile: options.files.promptFile,
      outputFile: options.files.outputFile,
      ...(options.target.model === undefined ? {} : { model: options.target.model }),
      signal: controller.signal,
      ...(options.progress === undefined ? {} : { progress: options.progress }),
    });
    // Observes the spawn promise without changing what the caller awaits, so the timeout
    // branch below can wait for the child to actually die before it throws.
    spawnPromiseSettled = Promise.resolve(spawnPromise).then(
      () => undefined,
      () => undefined,
    );
    if (options.timeoutMs === undefined) {
      result = await spawnPromise;
    } else {
      result = await Promise.race([
        spawnPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error("working_agent_timeout"));
          }, options.timeoutMs);
        }),
      ]);
    }
  } catch (error) {
    if (timedOut || (error instanceof Error && error.message === "working_agent_timeout")) {
      // The race rejected on our timer, not on the child's exit. Give termination a bounded
      // moment to complete so the next target starts with a dead predecessor.
      if (spawnPromiseSettled !== undefined) {
        await withBoundedSettlement(spawnPromiseSettled, options.timeoutMs);
      }
      throw new TrailStepFailureError({
        code: "agent_provider_timeout",
        message: `Working agent step ${options.step.id} target '${options.target.provider}' timed out after ${options.timeoutMs}ms.`,
        details: {
          target: options.target.provider,
          ...(options.target.model === undefined ? {} : { model: options.target.model }),
          timeoutMs: options.timeoutMs,
          spawnEventId,
        },
      });
    }
    if (controller.signal.aborted) {
      // Caller (workflow timeout/cancellation) aborted the run: preserve
      // cancellation semantics instead of masking it as a spawn error.
      throw error;
    }
    throw new TrailStepFailureError({
      code: "agent_provider_spawn_error",
      message: `Working agent step ${options.step.id} could not start target '${options.target.provider}'.`,
      details: {
        target: options.target.provider,
        ...(options.target.model === undefined ? {} : { model: options.target.model }),
        cause: errorMessage(error),
        spawnEventId,
      },
    });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    options.signal?.removeEventListener("abort", onCallerAbort);
  }

  if (result.exitCode !== 0) {
    throw new TrailStepFailureError({
      code: "agent_provider_failed",
      message: `Working agent step ${options.step.id} target '${options.target.provider}' exited with code ${result.exitCode}.`,
      details: {
        exitCode: result.exitCode,
        provider: agentConfig.binary,
        target: options.target.provider,
        ...(options.target.model === undefined ? {} : { model: options.target.model }),
        spawnEventId,
      },
    });
  }

  // Emit agent.outputReceived
  await options.emit(
    createEvent({
      runId: options.runId,
      workflowId: options.workflowId,
      stepId: options.step.id,
      type: "agent.outputReceived",
      payload: {
        phase: "work",
        outputFile: options.files.outputFile,
        outputSize: await outputFileSize(options.files.outputFile),
        valid: true,
        ...dispatchProvenanceFields(dispatchProvenance, {
          targetOrdinal,
          workSpawnTry,
          spawnEventId,
        }),
      },
    }),
  );

  try {
    return await readWorkingAgentOutput({
      stepId: options.step.id,
      outputFile: options.files.outputFile,
      step: options.step,
    });
  } catch (error) {
    throw attachSpawnEventId(error, spawnEventId);
  }
}

/** Best-effort byte size for observability; never masks the main result. */
async function outputFileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
