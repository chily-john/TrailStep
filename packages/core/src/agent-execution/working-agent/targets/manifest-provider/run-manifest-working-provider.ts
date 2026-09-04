import { writeFile } from "node:fs/promises";

import type {
  TrailStepAgentTarget,
  TrailStepConfig,
} from "../../../../agent-targeting/targeting.types.js";
import type { AgentStepRequestConfig } from "../../../../authoring/step/agent-step.types.js";
import {
  extractEnvelopeOutput,
  extractEnvelopeText,
} from "../../../../cli-provider-runtime/envelopes/envelope.js";
import type {
  WorkflowAgentRole,
  WorkflowAgentThinking,
} from "../../../../contracts/agents/agent-role.types.js";
import { TrailStepFailureError } from "../../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../../contracts/shapes/shape.types.js";
import type {
  TrailStepProviderManifest,
  TrailStepProviderOutputManifest,
} from "../../../../providers/provider-manifest.js";
import type {
  WorkingAgentProcessResult,
  WorkingAgentProcessRunner,
} from "../../../../runtime/run-workflow/run-workflow.types.js";
import { renderCustomProviderArgs } from "../../../custom-provider/render-custom-provider-args.js";
import type { WorkingAgentFiles } from "../../artifacts/resolve-step-agent-files.js";
import { readWorkingAgentOutput } from "../../output/read-working-agent-output.js";
import { spawnWorkingAgentProcess } from "../custom-provider/spawn-working-agent-process.js";

export async function runManifestWorkingProvider<TOutput extends PlainObject>(options: {
  readonly config: TrailStepConfig;
  readonly step: AgentStepRequestConfig<PlainObject, TOutput>;
  readonly role: WorkflowAgentRole;
  readonly cwd: string;
  readonly runner?: WorkingAgentProcessRunner;
  readonly target: TrailStepAgentTarget;
  readonly files: WorkingAgentFiles;
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
    result = await (options.runner ?? spawnWorkingAgentProcess)({
      command: working.command,
      args,
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
