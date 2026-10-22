import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import type { TrailStepAgentTarget } from "../../../../agent-targeting/targeting.types.js";
import type { AgentStepRequestConfig } from "../../../../authoring/step/agent-step.types.js";
import type { WorkflowAgentThinking } from "../../../../contracts/agents/agent-role.types.js";
import { TrailStepFailureError } from "../../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../../contracts/shapes/shape.types.js";
import { errorMessage } from "../../../../json/guards.js";
import type {
  ProviderHygieneArgs,
  TrailStepProviderFollowUpManifest,
  TrailStepProviderManifest,
  TrailStepProviderWorkingManifest,
} from "../../../../providers/provider-manifest.js";
import { createEvent } from "../../../../runtime/events/create-run-event.js";
import type { SpawnRetryPolicy } from "../../../../runtime/retry/spawn-retry-policy.js";
import type {
  Event,
  WorkingAgentProcessRunner,
} from "../../../../runtime/run-workflow/run-workflow.types.js";
import { renderCustomProviderArgs } from "../../../custom-provider/render-custom-provider-args.js";
import type { WorkingAgentFiles } from "../../artifacts/resolve-step-agent-files.js";
import { appendStderrArtifact } from "../../attempts/attempt-log.js";
import { readWorkingAgentOutput } from "../../output/read-working-agent-output.js";
import { defaultManifestWorkingArgs } from "./manifest-working-args.js";
import { writeCapturedStdoutOutput } from "./manifest-working-output.js";
import { writeFormatPhasePrompt, writeWorkPhasePrompt } from "./manifest-working-prompts.js";
import {
  outputFileSize,
  readPhase1Tail,
  spawnFormatWithTransientRetry,
  spawnManifestPhase,
  tailString,
  writePhaseUsageFile,
} from "./manifest-working-spawn.js";

const MAX_FORMAT_ATTEMPTS = 3;

/**
 * Two-phase (Architecture B) execution for manifests with `followUp.supported`.
 *
 * Phase 1 runs the worker against a work-only prompt and captures its raw
 * report to `files.workFile`. Phase 2 is a pinned same-session follow-up that
 * reformats the report to the strict output schema and is the only phase that
 * writes `files.outputFile`. Format failures retry Phase 2 only — the worker
 * (Phase 1) is never re-run — up to `MAX_FORMAT_ATTEMPTS` attempts in the
 * same session before an `agent_target_failed` error is raised.
 */
export async function runTwoPhaseManifestWorking<TOutput extends PlainObject>(context: {
  readonly options: {
    readonly step: AgentStepRequestConfig<PlainObject, TOutput>;
    readonly cwd: string;
    readonly runner?: WorkingAgentProcessRunner;
    readonly target: TrailStepAgentTarget;
    readonly files: WorkingAgentFiles;
    readonly renderedPrompt: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly emit: (event: Event) => Promise<void>;
    readonly runId: string;
    readonly workflowId: string;
  };
  readonly manifest: TrailStepProviderManifest;
  readonly working: TrailStepProviderWorkingManifest;
  readonly followUp: TrailStepProviderFollowUpManifest;
  readonly extractOutputHook?: unknown;
  readonly thinking?: WorkflowAgentThinking;
  readonly model?: string;
  readonly hygieneArgs: ProviderHygieneArgs;
  readonly spawnRetry: SpawnRetryPolicy;
  readonly timeoutMs?: number;
}): Promise<TOutput> {
  const { options, working, followUp } = context;
  const { files, step, target } = options;
  const spawnRetry = context.spawnRetry;
  const sessionId = randomUUID();
  const captureStdout = working.output?.style !== "provider-output-file";

  // One step timeout governs both phases. Track a deadline and hand each
  // spawn only its remaining share so retries can never overrun the step.
  // Phase 1 is additionally capped to leave a reserve for formatting, other-
  // wise a slow work phase could starve Phase 2 down to a zero budget.
  // When no timeout is configured, pass undefined through (no deadline/budget).
  const timeoutMs = options.timeoutMs;
  const stepDeadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  const remainingMs = (): number | undefined =>
    stepDeadline === undefined ? undefined : stepDeadline - Date.now();
  const formatReserveMs =
    timeoutMs === undefined
      ? undefined
      : Math.min(30_000, Math.max(10_000, Math.floor(timeoutMs / 5)));
  const phase1BudgetMs =
    timeoutMs === undefined ? undefined : Math.max(1_000, timeoutMs - (formatReserveMs ?? 0));

  // Fail fast on manifest misconfiguration before running the worker: a
  // supported follow-up without resume args cannot ever complete Phase 2.
  const resumeArgs = followUp.resumeArgs;
  if (resumeArgs === undefined) {
    throw new TrailStepFailureError({
      code: "agent_provider_invalid",
      message: `Working agent step ${step.id} target '${target.provider}' declares followUp.supported without followUp.resumeArgs for the format phase.`,
      details: { provider: target.provider },
    });
  }

  // Phase 1: overwrite the front-loaded prompt with the work-only prompt.
  await writeWorkPhasePrompt({
    promptFile: files.promptFile,
    renderedPrompt: options.renderedPrompt,
  });

  const phase1Template =
    working.args ??
    defaultManifestWorkingArgs({
      manifest: context.manifest,
      promptFile: files.promptFile,
      outputFile: files.workFile,
      model: context.model,
      thinking: context.thinking,
    });
  const phase1Args = renderCustomProviderArgs({
    argv: phase1Template,
    values: {
      promptFile: files.promptFile,
      outputFile: files.workFile,
      sessionId,
      ...(context.model === undefined ? {} : { model: context.model }),
      ...(context.thinking === undefined ? {} : { thinking: context.thinking }),
      ...context.hygieneArgs,
    },
    errorCode: "agent_provider_invalid",
    commandDescription: "Manifest working provider command",
  });
  if (
    followUp.sessionIdFlag !== undefined &&
    !phase1Template.some((arg) => arg.includes("{{sessionId}}"))
  ) {
    phase1Args.push(followUp.sessionIdFlag, sessionId);
  }

  await options.emit(
    createEvent({
      runId: options.runId,
      workflowId: options.workflowId,
      stepId: step.id,
      type: "agent.spawned",
      payload: {
        provider: target.provider,
        model: context.model,
        phase: "work",
        sessionId,
        promptFile: files.promptFile,
        outputFile: files.workFile,
      },
    }),
  );
  await options.emit(
    createEvent({
      runId: options.runId,
      workflowId: options.workflowId,
      stepId: step.id,
      type: "agent.promptSent",
      payload: { phase: "work", promptFile: files.promptFile, sessionId },
    }),
  );

  const phase1Result = await spawnManifestPhase({
    phase: "work",
    stepId: step.id,
    provider: target.provider,
    command: working.command ?? "",
    args: phase1Args,
    cwd: options.cwd,
    model: context.model,
    promptFile: files.promptFile,
    outputFile: files.workFile,
    stdio: captureStdout ? "pipe" : "inherit",
    runner: options.runner,
    signal: options.signal,
    timeoutMs: phase1BudgetMs,
  });

  if (phase1Result.exitCode !== 0) {
    const stderrTail = tailString(phase1Result.stderr);
    await appendStderrArtifact(
      files.stderrFile,
      { phase: "work", exitCode: phase1Result.exitCode },
      phase1Result.stderr,
    );
    throw new TrailStepFailureError({
      code: "agent_provider_failed",
      message: `Working agent step ${step.id} target '${target.provider}' exited with code ${phase1Result.exitCode}.`,
      details: {
        phase: "work",
        exitCode: phase1Result.exitCode,
        provider: working.command,
        target: target.provider,
        ...(context.model === undefined ? {} : { model: context.model }),
        ...(stderrTail === undefined ? {} : { stderrTail }),
      },
    });
  }

  if (captureStdout) {
    // Raw work report: deliberately no JSON parsing here.
    await writeFile(files.workFile, phase1Result.stdout ?? "", "utf8");
  }
  const phase1Tail = await readPhase1Tail(files.workFile);
  await writePhaseUsageFile({
    usageFile: files.usageFile,
    sessionId,
    provider: target.provider,
    model: context.model,
  });
  await options.emit(
    createEvent({
      runId: options.runId,
      workflowId: options.workflowId,
      stepId: step.id,
      type: "agent.outputReceived",
      payload: {
        phase: "work",
        sessionId,
        outputFile: files.workFile,
        outputSize: await outputFileSize(files.workFile),
        valid: true,
      },
    }),
  );

  // Phase 2: pinned same-session format follow-up.
  const phase2Args = renderCustomProviderArgs({
    argv: resumeArgs,
    values: {
      sessionId,
      promptFile: files.repairPromptFile,
      outputFile: files.outputFile,
      ...(context.model === undefined ? {} : { model: context.model }),
      ...(context.thinking === undefined ? {} : { thinking: context.thinking }),
      ...context.hygieneArgs,
    },
    errorCode: "agent_provider_invalid",
    commandDescription: "Manifest follow-up resume command",
  });

  const validationDiagnostics: string[] = [];
  let formatFailureMessage = "";

  await options.emit(
    createEvent({
      runId: options.runId,
      workflowId: options.workflowId,
      stepId: step.id,
      type: "agent.outputRequested",
      payload: { phase: "format", sessionId },
    }),
  );
  await options.emit(
    createEvent({
      runId: options.runId,
      workflowId: options.workflowId,
      stepId: step.id,
      type: "agent.sessionResumed",
      payload: { sessionId, phase: "format" },
    }),
  );

  for (let attempt = 1; attempt <= MAX_FORMAT_ATTEMPTS; attempt += 1) {
    const attemptBudgetMs = remainingMs();
    if (attemptBudgetMs !== undefined && attemptBudgetMs <= 0) {
      throw new TrailStepFailureError({
        code: "agent_provider_timeout",
        message: `Working agent step ${step.id} target '${target.provider}' timed out after ${options.timeoutMs}ms before format attempt ${attempt}.`,
        details: {
          phase: "format",
          attempt,
          sessionId,
          target: target.provider,
          ...(context.model === undefined ? {} : { model: context.model }),
          timeoutMs: options.timeoutMs,
        },
      });
    }
    await writeFormatPhasePrompt({
      repairPromptFile: files.repairPromptFile,
      outputSchema: step.output.jsonSchema,
      ...(attempt === 1 ? {} : { validationError: formatFailureMessage }),
    });
    const phase2Result = await spawnFormatWithTransientRetry({
      stepId: step.id,
      target,
      command: working.command ?? "",
      args: phase2Args,
      cwd: options.cwd,
      files,
      runner: options.runner,
      signal: options.signal,
      timeoutMs: attemptBudgetMs,
      attempt,
      sessionId,
      model: context.model,
      captureStdout,
      spawnRetry,
      emit: options.emit,
      runId: options.runId,
      workflowId: options.workflowId,
    });

    try {
      await writeCapturedStdoutOutput({
        provider: target.provider,
        stepId: step.id,
        outputFile: files.outputFile,
        captureMode: step.output.captureMode,
        stdout: phase2Result.stdout,
        output: working.output,
        extractOutputHook: context.extractOutputHook,
      });
      const formatted = await readWorkingAgentOutput({
        stepId: step.id,
        outputFile: files.outputFile,
        step,
      });
      await options.emit(
        createEvent({
          runId: options.runId,
          workflowId: options.workflowId,
          stepId: step.id,
          type: "agent.outputReceived",
          payload: {
            phase: "format",
            attempt,
            sessionId,
            outputFile: files.outputFile,
            outputSize: await outputFileSize(files.outputFile),
            valid: true,
          },
        }),
      );
      return formatted;
    } catch (error) {
      // Output validation/parse failure: retry Phase 2 in the SAME session.
      // The worker (Phase 1) is never re-run for format failures.
      formatFailureMessage = errorMessage(error);
      validationDiagnostics.push(`format attempt ${attempt}: ${formatFailureMessage}`);
    }
  }

  throw new TrailStepFailureError({
    code: "agent_target_failed",
    message: `Working agent step ${step.id} target '${target.provider}' failed output validation after ${MAX_FORMAT_ATTEMPTS} format attempts in session ${sessionId}.`,
    details: {
      provider: target.provider,
      sessionId,
      attempts: MAX_FORMAT_ATTEMPTS,
      validationDiagnostics,
      phase1Tail,
    },
  });
}
