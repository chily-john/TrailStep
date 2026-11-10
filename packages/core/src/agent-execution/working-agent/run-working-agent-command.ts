import { mkdir, writeFile } from "node:fs/promises";

import { resolveAgentTargets } from "../../agent-targeting/resolve-agent-targets/resolve-agent-targets.js";
import type {
  TrailStepAgentTarget,
  TrailStepConfig,
} from "../../agent-targeting/targeting.types.js";
import type { AgentStepRequestConfig } from "../../authoring/step/agent-step.types.js";
import type { ProviderWorkingRunner } from "../../cli-provider-runtime/catalog/provider-adapter.types.js";
import type { WorkflowAgentRole } from "../../contracts/agents/agent-role.types.js";
import type { DispatchProvenanceContext } from "../../contracts/dispatch-provenance/dispatch-provenance.types.js";
import { TrailStepFailureError } from "../../contracts/failures/failure.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import {
  dispatchProvenanceFields,
  readSpawnEventId,
} from "../../runtime/dispatch-provenance/dispatch-provenance.js";
import { createEvent } from "../../runtime/events/create-run-event.js";
import {
  resolveSpawnRetryPolicy,
  sleep,
  spawnRetryDelayMs,
} from "../../runtime/retry/spawn-retry-policy.js";
import type {
  Event,
  WorkingAgentProcessRunner,
} from "../../runtime/run-workflow/run-workflow.types.js";
import {
  resolveStepAgentFiles,
  type WorkingAgentFiles,
} from "./artifacts/resolve-step-agent-files.js";
import { appendAttemptLog } from "./attempts/attempt-log.js";
import {
  exitCodeFromDetails,
  isTransientWorkingAgentFailure,
  stderrTailFromDetails,
} from "./failures/transient-spawn-failures.js";
import type { AgentProgressTracker } from "./liveness/agent-progress-tracker.js";
import { buildWorkingAgentPrompt } from "./prompts/build-working-agent-prompt.js";
import { runWorkingAgentTargetAttempt } from "./targets/run-working-agent-target-attempt.js";
import {
  summarizeWorkingAgentAttemptFailure,
  type WorkingAgentAttemptFailure,
} from "./targets/target-failures.js";

export type { WorkingAgentFiles } from "./artifacts/resolve-step-agent-files.js";

export async function runWorkingAgentCommand<TOutput extends PlainObject>(options: {
  readonly config: TrailStepConfig;
  readonly workflowId: string;
  readonly roleName: string;
  readonly role: WorkflowAgentRole;
  readonly step: AgentStepRequestConfig<PlainObject, TOutput>;
  readonly renderedPrompt: string;
  readonly runDir: string;
  readonly cwd: string;
  readonly runner?: WorkingAgentProcessRunner;
  readonly providerWorkingRunner?: ProviderWorkingRunner;
  /** Called with the selected target immediately before each target attempt runs. */
  readonly onTargetAttempt?: (target: TrailStepAgentTarget) => void | Promise<void>;
  readonly stepIndex: number;
  /**
   * Explicit A2b dispatch context for provenance on working-agent events.
   * Absent in legacy direct calls, which keep the legacy event shape.
   */
  readonly dispatchProvenance?: DispatchProvenanceContext;
  readonly files?: WorkingAgentFiles;
  readonly signal?: AbortSignal;
  // Story 05 replaces the signal wiring in this file.
  /** Optional live liveness probe shared with the attempt heartbeat. */
  readonly progress?: AgentProgressTracker;
  readonly emit: (event: Event) => Promise<void>;
  readonly runId: string;
}): Promise<TOutput> {
  const targets = resolveAgentTargets({
    config: options.config,
    workflowId: options.workflowId,
    roleName: options.roleName,
    roleSize: options.role.size,
  });

  const files =
    options.files ??
    resolveStepAgentFiles({
      runDir: options.runDir,
      stepId: options.step.id,
      stepIndex: options.stepIndex,
    });
  await mkdir(files.stepDir, { recursive: true });
  await writeFile(
    files.promptFile,
    buildWorkingAgentPrompt({
      prompt: options.renderedPrompt,
      outputFile: files.outputFile,
      outputSchema: options.step.output.jsonSchema,
      captureMode: options.step.output.captureMode,
    }),
    "utf8",
  );

  const failures: WorkingAgentAttemptFailure[] = [];
  const timeoutMs = options.step.timeout;
  const spawnRetry = resolveSpawnRetryPolicy({
    workflow: options.config.workflows?.[options.workflowId]?.settings?.spawnRetry,
    global: options.config.settings?.spawnRetry,
  });

  for (const [targetIndex, target] of targets.entries()) {
    const targetOrdinal = targetIndex + 1;
    await options.onTargetAttempt?.(target);
    // Emit agent.targetSelected event
    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: options.step.id,
        type: "agent.targetSelected",
        payload: {
          provider: target.provider,
          model: target.model,
          thinking: target.thinking,
          ...dispatchProvenanceFields(options.dispatchProvenance, { targetOrdinal }),
        },
      }),
    );
    // Transient spawn failures (process-level deaths such as Windows
    // STATUS_DLL_INIT_FAILED) retry the SAME target with exponential backoff
    // before the target is consumed, so a spawn-storm burst cannot burn the
    // whole fallback chain in under a second.
    for (let spawnTry = 1; ; spawnTry += 1) {
      try {
        return await runWorkingAgentTargetAttempt({
          ...options,
          target,
          targetOrdinal,
          workSpawnTry: spawnTry,
          files,
          timeoutMs,
          spawnRetry,
        });
      } catch (error) {
        const transient = isTransientWorkingAgentFailure(error);
        const canRetry =
          transient && spawnTry < spawnRetry.maxAttempts && options.signal?.aborted !== true;
        const failureSummary = summarizeWorkingAgentAttemptFailure(target, error);
        const details = error instanceof TrailStepFailureError ? error.failure.details : undefined;
        const exitCode = exitCodeFromDetails(details);
        const stderrTail = stderrTailFromDetails(details);
        const delayMs = canRetry ? spawnRetryDelayMs(spawnRetry, spawnTry) : undefined;
        const decision = canRetry ? "retry" : "nextTarget";
        const spawnEventId = readSpawnEventId(details);

        await appendAttemptLog(files.attemptsFile, {
          timestamp: new Date().toISOString(),
          provider: target.provider,
          ...(target.model === undefined ? {} : { model: target.model }),
          phase: detailString(details, "phase") ?? "work",
          ...(typeof detailNumber(details, "attempt") === "number"
            ? { attempt: detailNumber(details, "attempt") }
            : {}),
          spawnTry,
          ...(exitCode >= 0 ? { exitCode } : {}),
          failureCode: failureSummary.code,
          message: failureSummary.message,
          transient,
          decision,
          ...(delayMs === undefined ? {} : { delayMs }),
          ...(stderrTail === undefined ? {} : { stderrTail }),
        });
        await options.emit(
          createEvent({
            runId: options.runId,
            workflowId: options.workflowId,
            stepId: options.step.id,
            type: "agent.attemptFailed",
            payload: {
              provider: target.provider,
              model: target.model,
              phase: detailString(details, "phase") ?? "work",
              spawnTry,
              ...(exitCode >= 0 ? { exitCode } : {}),
              failureCode: failureSummary.code,
              transient,
              decision,
              ...(delayMs === undefined ? {} : { delayMs }),
              ...(stderrTail === undefined ? {} : { stderrTail }),
              message: failureSummary.message,
              // Link this failure to the actual spawn attempt when the
              // provider recorded one. Pre-spawn failures keep available
              // context (target ordinal + work spawn retry) with no spawn
              // reference rather than a fabricated one.
              ...dispatchProvenanceFields(options.dispatchProvenance, {
                targetOrdinal,
                workSpawnTry: spawnTry,
                ...(spawnEventId === undefined ? {} : { spawnEventId }),
              }),
            },
          }),
        );

        if (!canRetry) {
          failures.push(failureSummary);
          break;
        }
        await sleep(delayMs ?? 0);
      }
    }
  }

  throw new TrailStepFailureError({
    code: "agent_target_exhausted",
    message: `Working agent step ${options.step.id} for role ${options.roleName} exhausted ${failures.length} target(s).`,
    details: {
      stepId: options.step.id,
      roleName: options.roleName,
      attempts: failures,
    },
  });
}

function detailString(details: unknown, field: string): string | undefined {
  const value =
    typeof details === "object" && details !== null
      ? (details as Record<string, unknown>)[field]
      : undefined;
  return typeof value === "string" ? value : undefined;
}

function detailNumber(details: unknown, field: string): number | undefined {
  const value =
    typeof details === "object" && details !== null
      ? (details as Record<string, unknown>)[field]
      : undefined;
  return typeof value === "number" ? value : undefined;
}
