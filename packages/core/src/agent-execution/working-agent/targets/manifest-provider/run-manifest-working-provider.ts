import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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
import type {
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

  let result: WorkingAgentProcessResult;
  try {
    // npm-installed provider CLIs (e.g. pi) are .cmd shims on Windows and cannot
    // be spawned by bare name with shell:false; resolve to the Node entrypoint
    // (no-op on other platforms) so argv is never reinterpreted by a shell.
    const executable = await resolveCliCommandForSpawn({ command: working.command, args });
    result = await (options.runner ?? spawnWorkingAgentProcess)({
      command: executable.command,
      args: executable.args,
      cwd: options.cwd,
      shell: false,
      stdio: captureStdout ? "pipe" : "inherit",
      promptFile: options.files.promptFile,
      outputFile: options.files.outputFile,
      ...(model === undefined ? {} : { model }),
      signal: options.signal,
    });
  } catch (error) {
    throw new TrailStepFailureError({
      code: "agent_provider_spawn_error",
      message: `Working agent step ${options.step.id} could not start target '${options.target.provider}'.`,
      details: {
        target: options.target.provider,
        ...(model === undefined ? {} : { model }),
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }

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
  };
  readonly manifest: TrailStepProviderManifest;
  readonly working: TrailStepProviderWorkingManifest;
  readonly followUp: TrailStepProviderFollowUpManifest;
  readonly extractOutputHook?: unknown;
  readonly thinking?: WorkflowAgentThinking;
  readonly model?: string;
}): Promise<TOutput> {
  const { options, working, followUp } = context;
  const { files, step, target } = options;
  const sessionId = randomUUID();
  const captureStdout = working.output?.style !== "provider-output-file";

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

  for (let attempt = 1; attempt <= MAX_FORMAT_ATTEMPTS; attempt += 1) {
    await writeFile(
      files.repairPromptFile,
      buildFormatPrompt({
        outputSchema: step.output.jsonSchema,
        ...(attempt === 1 ? {} : { validationErrors: [formatFailureMessage] }),
      }),
      "utf8",
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
      return await readWorkingAgentOutput({ stepId: step.id, outputFile: files.outputFile, step });
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
}): Promise<WorkingAgentProcessResult> {
  // npm-installed provider CLIs (e.g. pi) are .cmd shims on Windows and cannot
  // be spawned by bare name with shell:false; resolve to the Node entrypoint
  // (no-op on other platforms) so argv is never reinterpreted by a shell.
  const executable = await resolveCliCommandForSpawn({
    command: options.command,
    args: options.args,
  });
  try {
    return await (options.runner ?? spawnWorkingAgentProcess)({
      command: executable.command,
      args: executable.args,
      cwd: options.cwd,
      shell: false,
      stdio: options.stdio,
      promptFile: options.promptFile,
      outputFile: options.outputFile,
      ...(options.model === undefined ? {} : { model: options.model }),
      signal: options.signal,
    });
  } catch (error) {
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
