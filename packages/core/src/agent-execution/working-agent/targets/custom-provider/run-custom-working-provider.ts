import { stat } from "node:fs/promises";
import type {
  TrailStepAgentTarget,
  TrailStepConfig,
} from "../../../../agent-targeting/targeting.types.js";
import type { AgentStepRequestConfig } from "../../../../authoring/step/agent-step.types.js";
import { resolveCliCommandForSpawn } from "../../../../cli-provider-runtime/process/resolve-cli-command.js";
import type { WorkflowAgentRole } from "../../../../contracts/agents/agent-role.types.js";
import { TrailStepFailureError } from "../../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../../contracts/shapes/shape.types.js";
import { createEvent } from "../../../../runtime/events/create-run-event.js";
import type {
  Event,
  WorkingAgentProcessResult,
  WorkingAgentProcessRunner,
} from "../../../../runtime/run-workflow/run-workflow.types.js";
import type { WorkingAgentFiles } from "../../artifacts/resolve-step-agent-files.js";
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
  readonly files: WorkingAgentFiles;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
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

  // Emit agent.spawned
  await options.emit(
    createEvent({
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
      },
    }),
  );

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
    });
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
      throw new TrailStepFailureError({
        code: "agent_provider_timeout",
        message: `Working agent step ${options.step.id} target '${options.target.provider}' timed out after ${options.timeoutMs}ms.`,
        details: {
          target: options.target.provider,
          ...(options.target.model === undefined ? {} : { model: options.target.model }),
          timeoutMs: options.timeoutMs,
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
        cause: error instanceof Error ? error.message : String(error),
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
      },
    }),
  );

  return readWorkingAgentOutput({
    stepId: options.step.id,
    outputFile: options.files.outputFile,
    step: options.step,
  });
}

/** Best-effort byte size for observability; never masks the main result. */
async function outputFileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
