import type {
  TrailStepAgentTarget,
  TrailStepConfig,
} from "../../../../agent-targeting/targeting.types.js";
import type { AgentStepRequestConfig } from "../../../../authoring/step/agent-step.types.js";
import type { WorkflowAgentRole } from "../../../../contracts/agents/agent-role.types.js";
import { TrailStepFailureError } from "../../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../../contracts/shapes/shape.types.js";
import {
  buildProviderHygieneArgs,
  type ProviderHygieneArgs,
} from "../../../../providers/provider-manifest.js";
import { createEvent } from "../../../../runtime/events/create-run-event.js";
import { resolveExecutionPolicy } from "../../../../runtime/execution/execution-policy.js";
import {
  resolveSpawnRetryPolicy,
  type SpawnRetryPolicy,
} from "../../../../runtime/retry/spawn-retry-policy.js";
import type {
  Event,
  WorkingAgentProcessResult,
  WorkingAgentProcessRunner,
} from "../../../../runtime/run-workflow/run-workflow.types.js";
import { renderCustomProviderArgs } from "../../../custom-provider/render-custom-provider-args.js";
import type { WorkingAgentFiles } from "../../artifacts/resolve-step-agent-files.js";
import { appendStderrArtifact } from "../../attempts/attempt-log.js";
import { readWorkingAgentOutput } from "../../output/read-working-agent-output.js";
import { defaultManifestWorkingArgs, optionalNonEmptyString } from "./manifest-working-args.js";
import { writeCapturedStdoutOutput } from "./manifest-working-output.js";
import { outputFileSize, spawnManifestPhase, tailString } from "./manifest-working-spawn.js";
import { runTwoPhaseManifestWorking } from "./manifest-working-two-phase.js";

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
  readonly spawnRetry?: SpawnRetryPolicy;
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
  const spawnRetry =
    options.spawnRetry ??
    resolveSpawnRetryPolicy({
      workflow: options.config.workflows?.[options.workflowId]?.settings?.spawnRetry,
      global: options.config.settings?.spawnRetry,
    });

  // Execution (hygiene) context: step > workflow config > global config >
  // role, merged field by field. Omitted execution (or a hygiene-less
  // manifest) renders no hygiene args at all, preserving current provider
  // behavior byte-for-byte. Invalid blocks (including invalid config blocks)
  // fail fast before any provider process is spawned.
  const execution = resolveExecutionPolicy({
    role: options.role.execution,
    step: options.step.execution,
    global: {
      path: "settings.execution",
      block: options.config.settings?.execution,
    },
    workflow: {
      path: `workflows.${options.workflowId}.settings.execution`,
      block: options.config.workflows?.[options.workflowId]?.settings?.execution,
    },
  });
  const hygieneArgs: ProviderHygieneArgs =
    execution === undefined
      ? {}
      : buildProviderHygieneArgs({
          execution,
          hygiene: manifest.hygiene,
        });

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
      hygieneArgs,
      spawnRetry,
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
      ...hygieneArgs,
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
    const stderrTail = tailString(result.stderr);
    await appendStderrArtifact(
      options.files.stderrFile,
      { phase: "work", exitCode: result.exitCode },
      result.stderr,
    );
    throw new TrailStepFailureError({
      code: "agent_provider_failed",
      message: `Working agent step ${options.step.id} target '${options.target.provider}' exited with code ${result.exitCode}.`,
      details: {
        phase: "work",
        exitCode: result.exitCode,
        provider: working.command,
        target: options.target.provider,
        ...(model === undefined ? {} : { model }),
        ...(stderrTail === undefined ? {} : { stderrTail }),
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
