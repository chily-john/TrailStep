import type { StepKitAgentTarget, StepKitConfig } from "../../../../agent-targeting/targeting.types.js";
import type { AgentStepRequestConfig } from "../../../../authoring/step/agent-step.types.js";
import { StepKitFailureError } from "../../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../../contracts/shapes/shape.types.js";
import type {
  WorkingAgentProcessResult,
  WorkingAgentProcessRunner,
} from "../../../../runtime/run-workflow/run-workflow.types.js";
import type { WorkingAgentFiles } from "../../artifacts/resolve-step-agent-files.js";
import { readWorkingAgentOutput } from "../../output/read-working-agent-output.js";
import { buildWorkingAgentArgs } from "./build-working-agent-args.js";
import { spawnWorkingAgentProcess } from "./spawn-working-agent-process.js";

export async function runCustomWorkingProvider<TOutput extends PlainObject>(options: {
  readonly config: StepKitConfig;
  readonly step: AgentStepRequestConfig<PlainObject, TOutput>;
  readonly cwd: string;
  readonly runner?: WorkingAgentProcessRunner;
  readonly target: StepKitAgentTarget;
  readonly files: WorkingAgentFiles;
  readonly signal?: AbortSignal;
}): Promise<TOutput> {
  const agentConfig = options.config.customProviders[options.target.provider];
  if (!agentConfig) {
    throw new StepKitFailureError({
      code: "agent_provider_unavailable",
      message: `Working agent target '${options.target.provider}' does not reference a configured custom agent.`,
      details: { provider: options.target.provider },
    });
  }

  const args = buildWorkingAgentArgs({
    argv: options.target.args ?? agentConfig.args,
    promptFile: options.files.promptFile,
    outputFile: options.files.outputFile,
    model: options.target.model,
  });

  let result: WorkingAgentProcessResult;
  try {
    result = await (options.runner ?? spawnWorkingAgentProcess)({
      command: agentConfig.binary,
      args,
      cwd: options.cwd,
      shell: false,
      stdio: "inherit",
      promptFile: options.files.promptFile,
      outputFile: options.files.outputFile,
      ...(options.target.model === undefined ? {} : { model: options.target.model }),
      signal: options.signal,
    });
  } catch (error) {
    throw new StepKitFailureError({
      code: "agent_provider_spawn_error",
      message: `Working agent step ${options.step.id} could not start target '${options.target.provider}'.`,
      details: {
        target: options.target.provider,
        ...(options.target.model === undefined ? {} : { model: options.target.model }),
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }

  if (result.exitCode !== 0) {
    throw new StepKitFailureError({
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

  return readWorkingAgentOutput({
    stepId: options.step.id,
    outputFile: options.files.outputFile,
    step: options.step,
  });
}
