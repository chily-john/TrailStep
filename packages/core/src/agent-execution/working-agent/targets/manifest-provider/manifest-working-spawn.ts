import { readFile, stat, writeFile } from "node:fs/promises";
import type { TrailStepAgentTarget } from "../../../../agent-targeting/targeting.types.js";
import { resolveCliCommandForSpawn } from "../../../../cli-provider-runtime/process/resolve-cli-command.js";
import type { DispatchProvenanceContext } from "../../../../contracts/dispatch-provenance/dispatch-provenance.types.js";
import { TrailStepFailureError } from "../../../../contracts/failures/failure.js";
import { errorMessage } from "../../../../json/guards.js";
import { dispatchProvenanceFields } from "../../../../runtime/dispatch-provenance/dispatch-provenance.js";
import {
  createSpawnFailureScope,
  type SpawnFailureScope,
} from "../../../../runtime/dispatch-provenance/spawn-failure-correlation.js";
import { createEvent } from "../../../../runtime/events/create-run-event.js";
import {
  type SpawnRetryPolicy,
  sleep,
  spawnRetryDelayMs,
} from "../../../../runtime/retry/spawn-retry-policy.js";
import type {
  Event,
  WorkingAgentProcessResult,
  WorkingAgentProcessRunner,
} from "../../../../runtime/run-workflow/run-workflow.types.js";
import { withBoundedSettlement } from "../../../child-process/child-process-termination.js";
import type { WorkingAgentFiles } from "../../artifacts/resolve-step-agent-files.js";
import { appendAttemptLog, appendStderrArtifact } from "../../attempts/attempt-log.js";
import { isTransientSpawnExitCode } from "../../failures/transient-spawn-failures.js";
import type { AgentProgressTracker } from "../../liveness/agent-progress-tracker.js";
import { spawnWorkingAgentProcess } from "../custom-provider/spawn-working-agent-process.js";

const STDERR_TAIL_LIMIT = 2000;

/**
 * Spawns the format (Phase 2) resume, retrying transient process-level spawn
 * failures in the SAME session with exponential backoff before giving up.
 * Phase 1 work is never re-run here; the retry absorbs transient OS-level
 * deaths (e.g. Windows `STATUS_DLL_INIT_FAILED`) instead of throwing away a
 * completed work phase. Non-transient exit codes fail immediately.
 */
export async function spawnFormatWithTransientRetry(options: {
  readonly stepId: string;
  readonly target: TrailStepAgentTarget;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly files: WorkingAgentFiles;
  readonly runner?: WorkingAgentProcessRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly attempt: number;
  readonly sessionId: string;
  /** 1-based position of this target in the fallback chain (A2b). */
  readonly targetOrdinal: number;
  /** Explicit A2b dispatch context for provenance on format events. */
  readonly dispatchProvenance?: DispatchProvenanceContext;
  /** Borrowed ephemeral failure-correlation parent (owned by the command). */
  readonly spawnFailureScope?: SpawnFailureScope;
  readonly model?: string;
  readonly captureStdout: boolean;
  readonly spawnRetry: SpawnRetryPolicy;
  readonly progress?: AgentProgressTracker;
  readonly emit: (event: Event) => Promise<void>;
  readonly runId: string;
  readonly workflowId: string;
}): Promise<{ readonly result: WorkingAgentProcessResult; readonly spawnEventId: string }> {
  const { spawnRetry } = options;
  const dispatchProvenance = options.dispatchProvenance;
  const parentScope = options.spawnFailureScope;
  for (let spawnTry = 1; ; spawnTry += 1) {
    // Fresh per-transient-spawn child. Handled transient exits and successes
    // discard it (close without forward); only terminal spawn failures
    // record into it and forward to the command-owned parent before close.
    const spawnScope = createSpawnFailureScope();
    try {
      const spawnedEvent = createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: options.stepId,
        type: "agent.spawned",
        payload: {
          provider: options.target.provider,
          model: options.model,
          phase: "format",
          attempt: options.attempt,
          spawnTry,
          sessionId: options.sessionId,
          promptFile: options.files.repairPromptFile,
          outputFile: options.files.outputFile,
          ...dispatchProvenanceFields(dispatchProvenance, {
            targetOrdinal: options.targetOrdinal,
            formatValidationAttempt: options.attempt,
            formatSpawnTry: spawnTry,
          }),
        },
      });
      await options.emit(spawnedEvent);
      const spawnEventId = spawnedEvent.id;
      await options.emit(
        createEvent({
          runId: options.runId,
          workflowId: options.workflowId,
          stepId: options.stepId,
          type: "agent.promptSent",
          payload: {
            phase: "format",
            attempt: options.attempt,
            spawnTry,
            promptFile: options.files.repairPromptFile,
            sessionId: options.sessionId,
            ...dispatchProvenanceFields(dispatchProvenance, {
              targetOrdinal: options.targetOrdinal,
              formatValidationAttempt: options.attempt,
              formatSpawnTry: spawnTry,
              spawnEventId,
            }),
          },
        }),
      );

      let result: WorkingAgentProcessResult;
      try {
        result = await spawnManifestPhase({
          phase: "format",
          stepId: options.stepId,
          provider: options.target.provider,
          command: options.command,
          args: options.args,
          cwd: options.cwd,
          model: options.model,
          promptFile: options.files.repairPromptFile,
          outputFile: options.files.outputFile,
          stdio: options.captureStdout ? "pipe" : "inherit",
          runner: options.runner,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          ...(options.progress === undefined ? {} : { progress: options.progress }),
        });
      } catch (error) {
        spawnScope.record(error, spawnEventId);
        parentScope?.forward(error, spawnScope);
        throw error;
      }
      if (result.exitCode === 0) {
        return { result, spawnEventId };
      }

      const transient = isTransientSpawnExitCode(result.exitCode);
      const stderrTail = tailString(result.stderr);
      await appendStderrArtifact(
        options.files.stderrFile,
        { phase: "format", spawnTry, exitCode: result.exitCode },
        result.stderr,
      );
      const canRetry =
        transient && spawnTry < spawnRetry.maxAttempts && options.signal?.aborted !== true;
      const delayMs = canRetry ? spawnRetryDelayMs(spawnRetry, spawnTry) : undefined;
      const message = `Working agent step ${options.stepId} target '${options.target.provider}' exited with code ${result.exitCode}.`;

      await appendAttemptLog(options.files.attemptsFile, {
        timestamp: new Date().toISOString(),
        provider: options.target.provider,
        ...(options.model === undefined ? {} : { model: options.model }),
        phase: "format",
        attempt: options.attempt,
        spawnTry,
        exitCode: result.exitCode,
        failureCode: "agent_provider_failed",
        message,
        transient,
        decision: canRetry ? "retryFormat" : "fail",
        ...(delayMs === undefined ? {} : { delayMs }),
        ...(stderrTail === undefined ? {} : { stderrTail }),
      });
      await options.emit(
        createEvent({
          runId: options.runId,
          workflowId: options.workflowId,
          stepId: options.stepId,
          type: "agent.attemptFailed",
          payload: {
            phase: "format",
            attempt: options.attempt,
            spawnTry,
            provider: options.target.provider,
            model: options.model,
            sessionId: options.sessionId,
            exitCode: result.exitCode,
            transient,
            decision: canRetry ? "retryFormat" : "fail",
            ...(delayMs === undefined ? {} : { delayMs }),
            ...(stderrTail === undefined ? {} : { stderrTail }),
            message,
            ...dispatchProvenanceFields(dispatchProvenance, {
              targetOrdinal: options.targetOrdinal,
              formatValidationAttempt: options.attempt,
              formatSpawnTry: spawnTry,
              spawnEventId,
            }),
          },
        }),
      );

      if (!canRetry) {
        const formatFailure = new TrailStepFailureError({
          code: "agent_provider_failed",
          message,
          details: {
            phase: "format",
            attempt: options.attempt,
            sessionId: options.sessionId,
            exitCode: result.exitCode,
            provider: options.command,
            target: options.target.provider,
            ...(options.model === undefined ? {} : { model: options.model }),
            transient,
            spawnTry,
            ...(stderrTail === undefined ? {} : { stderrTail }),
          },
        });
        spawnScope.record(formatFailure, spawnEventId);
        parentScope?.forward(formatFailure, spawnScope);
        throw formatFailure;
      }
      await sleep(delayMs ?? 0);
    } finally {
      spawnScope.close();
    }
  }
}

export function tailString(
  value: string | undefined,
  limit = STDERR_TAIL_LIMIT,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.length > limit ? value.slice(-limit) : value;
}

export async function spawnManifestPhase(options: {
  readonly phase: "work" | "format";
  readonly stepId: string;
  readonly provider: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly model?: string;
  readonly promptFile: string;
  readonly outputFile: string;
  readonly stdio: "pipe" | "inherit";
  readonly runner?: WorkingAgentProcessRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly progress?: AgentProgressTracker;
}): Promise<WorkingAgentProcessResult> {
  // npm-installed provider CLIs (e.g. pi) are .cmd shims on Windows and cannot
  // be spawned by bare name with shell:false; resolve to the Node entrypoint
  // (no-op on other platforms) so argv is never reinterpreted by a shell.
  const executable = await resolveCliCommandForSpawn({
    command: options.command,
    args: options.args,
  });
  // Link caller cancellation and the per-phase timeout into one signal so a
  // timed-out phase actually terminates the child process tree (the spawn
  // primitive kills on abort) instead of leaking it. The race rejection below
  // still covers runners that ignore the signal entirely. The timer is always
  // cleared on settle so idle timeouts cannot fire into later phases.
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
    const spawnPromise = (options.runner ?? spawnWorkingAgentProcess)({
      command: executable.command,
      args: executable.args,
      cwd: options.cwd,
      shell: false,
      stdio: options.stdio,
      promptFile: options.promptFile,
      outputFile: options.outputFile,
      ...(options.model === undefined ? {} : { model: options.model }),
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
      return await spawnPromise;
    }
    return await Promise.race([
      spawnPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error("working_agent_timeout"));
        }, options.timeoutMs);
      }),
    ]);
  } catch (error) {
    if (timedOut || (error instanceof Error && error.message === "working_agent_timeout")) {
      // The race rejected on our timer, not on the child's exit. Give termination a bounded
      // moment to complete so the retry starts with a dead predecessor.
      if (spawnPromiseSettled !== undefined) {
        await withBoundedSettlement(spawnPromiseSettled, options.timeoutMs);
      }
      throw new TrailStepFailureError({
        code: "agent_provider_timeout",
        message: `Working agent step ${options.stepId} target '${options.provider}' timed out after ${options.timeoutMs}ms in ${options.phase} phase.`,
        details: {
          phase: options.phase,
          target: options.provider,
          ...(options.model === undefined ? {} : { model: options.model }),
          timeoutMs: options.timeoutMs,
        },
      });
    }
    if (controller.signal.aborted) {
      // Caller (workflow timeout/cancellation) aborted the phase: preserve
      // cancellation semantics instead of masking it as a spawn error.
      throw error;
    }
    throw new TrailStepFailureError({
      code: "agent_provider_spawn_error",
      message: `Working agent step ${options.stepId} could not start target '${options.provider}'.`,
      details: {
        phase: options.phase,
        target: options.provider,
        ...(options.model === undefined ? {} : { model: options.model }),
        cause: errorMessage(error),
      },
    });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** Best-effort byte size for observability; never masks the main result. */
export async function outputFileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

const PHASE_1_TAIL_LIMIT = 2000;

export async function readPhase1Tail(workFile: string): Promise<string> {
  try {
    const workText = await readFile(workFile, "utf8");
    return workText.length > PHASE_1_TAIL_LIMIT ? workText.slice(-PHASE_1_TAIL_LIMIT) : workText;
  } catch {
    return "";
  }
}

export async function writePhaseUsageFile(options: {
  readonly usageFile: string;
  readonly sessionId: string;
  readonly provider: string;
  readonly model?: string;
}): Promise<void> {
  try {
    await writeFile(
      options.usageFile,
      `${JSON.stringify(
        {
          sessionId: options.sessionId,
          provider: options.provider,
          ...(options.model === undefined ? {} : { model: options.model }),
          phases: 2,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch {
    // Best-effort only; never mask the main result.
  }
}
