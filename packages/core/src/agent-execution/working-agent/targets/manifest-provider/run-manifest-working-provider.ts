import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import type {
  TrailStepAgentTarget,
  TrailStepConfig,
} from "../../../../agent-targeting/targeting.types.js";
import type { AgentStepRequestConfig } from "../../../../authoring/step/agent-step.types.js";
import {
  extractEnvelopeOutput,
  extractEnvelopeText,
} from "../../../../cli-provider-runtime/envelopes/envelope.js";
import { resolveCliCommandForSpawn } from "../../../../cli-provider-runtime/process/resolve-cli-command.js";
import type {
  WorkflowAgentRole,
  WorkflowAgentThinking,
} from "../../../../contracts/agents/agent-role.types.js";
import { TrailStepFailureError } from "../../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../../contracts/shapes/shape.types.js";
import type {
  TrailStepProviderFollowUpManifest,
  TrailStepProviderManifest,
  TrailStepProviderOutputManifest,
  TrailStepProviderWorkingManifest,
} from "../../../../providers/provider-manifest.js";
import { createEvent } from "../../../../runtime/events/create-run-event.js";
import type {
  Event,
  WorkingAgentProcessResult,
  WorkingAgentProcessRunner,
} from "../../../../runtime/run-workflow/run-workflow.types.js";
import { renderCustomProviderArgs } from "../../../custom-provider/render-custom-provider-args.js";
import type { WorkingAgentFiles } from "../../artifacts/resolve-step-agent-files.js";
import { readWorkingAgentOutput } from "../../output/read-working-agent-output.js";
import { buildFormatPrompt, buildWorkPrompt } from "../../prompts/build-two-phase-prompts.js";
import { spawnWorkingAgentProcess } from "../custom-provider/spawn-working-agent-process.js";

export async function runManifestWorkingProvider<TOutput extends PlainObject>(options: {
  readonly config: TrailStepConfig;
  readonly step: AgentStepRequestConfig<PlainObject, TOutput>;
  readonly role: WorkflowAgentRole;
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
}): Promise<TOutput> {
  const registration = options.config.providers?.[options.target.provider];
  const manifest = registration?.manifest;
  const working = manifest?.working;

  if (
    manifest === undefined ||
    working === undefined ||
    !working.supported ||
    working.command === undefined
  ) {
    throw new TrailStepFailureError({
      code: "agent_provider_unavailable",
      message: `Working agent target '${options.target.provider}' does not reference a supported manifest working provider.`,
      details: { provider: options.target.provider },
    });
  }

  const thinking = options.target.thinking ?? options.role.thinking;
  const model = optionalNonEmptyString(options.target.model);

  const followUp = working.followUp;
  if (followUp?.supported === true) {
    return runTwoPhaseManifestWorking({
      options,
      manifest,
      working,
      followUp,
      extractOutputHook: registration?.manifest.hooks?.extractOutput,
      thinking,
      model,
      timeoutMs: options.timeoutMs,
    });
  }

  const args = renderCustomProviderArgs({
    argv:
      working.args ??
      defaultManifestWorkingArgs({
        manifest,
        promptFile: options.files.promptFile,
        outputFile: options.files.outputFile,
        model,
        thinking,
      }),
    values: {
      promptFile: options.files.promptFile,
      outputFile: options.files.outputFile,
      ...(model === undefined ? {} : { model }),
      ...(thinking === undefined ? {} : { thinking }),
    },
    errorCode: "agent_provider_invalid",
    commandDescription: "Manifest working provider command",
  });
  const captureStdout = working.output?.style !== "provider-output-file";

  await options.emit(
    createEvent({
      runId: options.runId,
      workflowId: options.workflowId,
      stepId: options.step.id,
      type: "agent.spawned",
      payload: {
        provider: options.target.provider,
        model,
        phase: "work",
        promptFile: options.files.promptFile,
        outputFile: options.files.outputFile,
      },
    }),
  );
  await options.emit(
    createEvent({
      runId: options.runId,
      workflowId: options.workflowId,
      stepId: options.step.id,
      type: "agent.promptSent",
      payload: { phase: "work", promptFile: options.files.promptFile },
    }),
  );

  const result = await spawnManifestPhase({
    phase: "work",
    stepId: options.step.id,
    provider: options.target.provider,
    command: working.command,
    args,
    cwd: options.cwd,
    model,
    promptFile: options.files.promptFile,
    outputFile: options.files.outputFile,
    stdio: captureStdout ? "pipe" : "inherit",
    runner: options.runner,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });

  if (result.exitCode !== 0) {
    throw new TrailStepFailureError({
      code: "agent_provider_failed",
      message: `Working agent step ${options.step.id} target '${options.target.provider}' exited with code ${result.exitCode}.`,
      details: {
        exitCode: result.exitCode,
        provider: working.command,
        target: options.target.provider,
        ...(model === undefined ? {} : { model }),
      },
    });
  }

  await writeCapturedStdoutOutput({
    provider: options.target.provider,
    stepId: options.step.id,
    outputFile: options.files.outputFile,
    captureMode: options.step.output.captureMode,
    stdout: (result as WorkingAgentProcessResult & { readonly stdout?: string }).stdout,
    output: working.output,
    extractOutputHook: registration?.manifest.hooks?.extractOutput,
  });

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
      },
    }),
  );

  return readWorkingAgentOutput({
    stepId: options.step.id,
    outputFile: options.files.outputFile,
    step: options.step,
  });
}

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
async function runTwoPhaseManifestWorking<TOutput extends PlainObject>(context: {
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
  readonly timeoutMs?: number;
}): Promise<TOutput> {
  const { options, working, followUp } = context;
  const { files, step, target } = options;
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
  await writeFile(files.promptFile, buildWorkPrompt({ prompt: options.renderedPrompt }), "utf8");

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
    throw new TrailStepFailureError({
      code: "agent_provider_failed",
      message: `Working agent step ${step.id} target '${target.provider}' exited with code ${phase1Result.exitCode}.`,
      details: {
        phase: "work",
        exitCode: phase1Result.exitCode,
        provider: working.command,
        target: target.provider,
        ...(context.model === undefined ? {} : { model: context.model }),
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
    await writeFile(
      files.repairPromptFile,
      buildFormatPrompt({
        outputSchema: step.output.jsonSchema,
        ...(attempt === 1 ? {} : { validationErrors: [formatFailureMessage] }),
      }),
      "utf8",
    );
    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: step.id,
        type: "agent.spawned",
        payload: {
          provider: target.provider,
          model: context.model,
          phase: "format",
          attempt,
          sessionId,
          promptFile: files.repairPromptFile,
          outputFile: files.outputFile,
        },
      }),
    );
    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: step.id,
        type: "agent.promptSent",
        payload: { phase: "format", attempt, promptFile: files.repairPromptFile, sessionId },
      }),
    );

    const phase2Result = await spawnManifestPhase({
      phase: "format",
      stepId: step.id,
      provider: target.provider,
      command: working.command ?? "",
      args: phase2Args,
      cwd: options.cwd,
      model: context.model,
      promptFile: files.repairPromptFile,
      outputFile: files.outputFile,
      stdio: captureStdout ? "pipe" : "inherit",
      runner: options.runner,
      signal: options.signal,
      timeoutMs: attemptBudgetMs,
    });

    if (phase2Result.exitCode !== 0) {
      throw new TrailStepFailureError({
        code: "agent_provider_failed",
        message: `Working agent step ${step.id} target '${target.provider}' exited with code ${phase2Result.exitCode}.`,
        details: {
          phase: "format",
          attempt,
          sessionId,
          exitCode: phase2Result.exitCode,
          provider: working.command,
          target: target.provider,
          ...(context.model === undefined ? {} : { model: context.model }),
        },
      });
    }

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
      formatFailureMessage = error instanceof Error ? error.message : String(error);
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

const MAX_FORMAT_ATTEMPTS = 3;
const PHASE_1_TAIL_LIMIT = 2000;

async function spawnManifestPhase(options: {
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
    });
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
        cause: error instanceof Error ? error.message : String(error),
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
async function outputFileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function readPhase1Tail(workFile: string): Promise<string> {
  try {
    const workText = await readFile(workFile, "utf8");
    return workText.length > PHASE_1_TAIL_LIMIT ? workText.slice(-PHASE_1_TAIL_LIMIT) : workText;
  } catch {
    return "";
  }
}

async function writePhaseUsageFile(options: {
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

async function writeCapturedStdoutOutput(options: {
  readonly provider: string;
  readonly stepId: string;
  readonly outputFile: string;
  readonly captureMode?: "json" | "raw-text";
  readonly stdout?: string;
  readonly output?: TrailStepProviderOutputManifest;
  readonly extractOutputHook?: unknown;
}): Promise<void> {
  if (options.stdout === undefined) {
    return;
  }

  if (
    options.output?.style === "stdout-json-envelope" ||
    options.output?.style === "stdout-jsonl-transcript"
  ) {
    await writeEnvelopeOutput({ ...options, stdout: options.stdout });
    return;
  }

  if (isRecord(options.extractOutputHook)) {
    const extracted = extractJsonObject(options.stdout);
    if (extracted === undefined) {
      throw new TrailStepFailureError({
        code: "agent_provider_output_invalid",
        message: `Working agent step ${options.stepId} provider '${options.provider}' could not extract JSON output from stdout using declared hook metadata.`,
        details: { provider: options.provider },
      });
    }

    await writeFile(options.outputFile, `${JSON.stringify(extracted)}\n`, "utf8");
  }
}

async function writeEnvelopeOutput(options: {
  readonly provider: string;
  readonly stepId: string;
  readonly outputFile: string;
  readonly captureMode?: "json" | "raw-text";
  readonly stdout: string;
  readonly output?: TrailStepProviderOutputManifest;
}): Promise<void> {
  try {
    const resultField = options.output?.parsing?.resultField ?? "result";
    if (options.captureMode === "raw-text") {
      const text = extractEnvelopeText(options.stdout, { resultField });
      await writeFile(options.outputFile, text, "utf8");
      return;
    }

    const extracted = extractEnvelopeOutput(options.stdout, { resultField });
    await writeFile(options.outputFile, `${JSON.stringify(extracted)}\n`, "utf8");
  } catch (error) {
    throw new TrailStepFailureError({
      code: "agent_provider_output_invalid",
      message: `Working agent step ${options.stepId} provider '${options.provider}' could not parse stdout envelope output.`,
      details: {
        provider: options.provider,
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function defaultManifestWorkingArgs(options: {
  readonly manifest: TrailStepProviderManifest;
  readonly promptFile: string;
  readonly outputFile: string;
  readonly model?: string;
  readonly thinking?: WorkflowAgentThinking;
}): readonly string[] {
  const args: string[] = [];

  if (options.model !== undefined && options.manifest.model.supported) {
    args.push(...renderFlaggedValue(options.manifest.model.flag, options.model));
  }

  if (options.thinking !== undefined && options.manifest.thinking.supported) {
    args.push(...renderFlaggedValue(options.manifest.thinking.flag, options.thinking));
  }

  if (options.manifest.working.prompt?.reference === "at-prefixed-argument") {
    args.push(`@${options.promptFile}`);
  } else {
    args.push("--prompt-file", options.promptFile);
  }

  if (options.manifest.working.output?.style === "provider-output-file") {
    args.push("--output-file", options.outputFile);
  }

  return args;
}

function renderFlaggedValue(flag: string | undefined, value: string): readonly string[] {
  if (flag === undefined) {
    return [];
  }

  const parts = flag.split(/\s+/u).filter(Boolean);
  if (parts.length === 0) {
    return [];
  }

  if (parts.length === 2) {
    return [parts[0] as string, `${parts[1] as string}=${value}`];
  }

  return [...parts, value];
}

function optionalNonEmptyString(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function extractJsonObject(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
