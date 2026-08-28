import type {
  TrailStepAgentTarget,
  TrailStepConfig,
} from "../../../../agent-targeting/targeting.types.js";
import type { AgentStepRequestConfig } from "../../../../authoring/step/agent-step.types.js";
import type { WorkflowAgentRole } from "../../../../contracts/agents/agent-role.types.js";
import { TrailStepFailureError } from "../../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../../contracts/shapes/shape.types.js";
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
  const working = registration?.manifest.working;

  if (working === undefined || !working.supported || working.command === undefined) {
    throw new TrailStepFailureError({
      code: "agent_provider_unavailable",
      message: `Working agent target '${options.target.provider}' does not reference a supported manifest working provider.`,
      details: { provider: options.target.provider },
    });
  }

  const thinking = options.target.thinking ?? options.role.thinking;
  const args = renderCustomProviderArgs({
    argv: working.args ?? ["--prompt-file", "{{promptFile}}", "--output-file", "{{outputFile}}"],
    values: {
      promptFile: options.files.promptFile,
      outputFile: options.files.outputFile,
      ...(options.target.model === undefined ? {} : { model: options.target.model }),
      ...(thinking === undefined ? {} : { thinking }),
    },
    errorCode: "agent_provider_invalid",
    commandDescription: "Manifest working provider command",
  });

  let result: WorkingAgentProcessResult;
  try {
    result = await (options.runner ?? spawnWorkingAgentProcess)({
      command: working.command,
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
    throw new TrailStepFailureError({
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
    throw new TrailStepFailureError({
      code: "agent_provider_failed",
      message: `Working agent step ${options.step.id} target '${options.target.provider}' exited with code ${result.exitCode}.`,
      details: {
        exitCode: result.exitCode,
        provider: working.command,
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
