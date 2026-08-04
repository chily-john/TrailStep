import { writeFile } from "node:fs/promises";

import type { StepKitAgentTarget } from "../../../../agent-targeting/targeting.types.js";
import type { AgentStepRequestConfig } from "../../../../authoring/step/agent-step.types.js";
import type { WorkflowAgentRole } from "../../../../contracts/agents/agent-role.types.js";
import type { PlainObject } from "../../../../contracts/shapes/shape.types.js";
import type {
  ProviderAdapter,
  ProviderWorkingRunner,
} from "../../../../known-cli-providers/registry/provider-registry.types.js";
import type { WorkingAgentFiles } from "../../artifacts/resolve-step-agent-files.js";
import { readWorkingAgentOutput } from "../../output/read-working-agent-output.js";
import { buildProviderWorkingPrompt } from "../../prompts/build-provider-working-prompt.js";
import { attemptProviderOutputRepair } from "./repair-provider-output.js";

export async function runRegistryWorkingProvider<TOutput extends PlainObject>(options: {
  readonly provider: ProviderAdapter;
  readonly role: WorkflowAgentRole;
  readonly step: AgentStepRequestConfig<PlainObject, TOutput>;
  readonly renderedPrompt: string;
  readonly cwd: string;
  readonly providerWorkingRunner?: ProviderWorkingRunner;
  readonly target: StepKitAgentTarget;
  readonly files: WorkingAgentFiles;
  readonly signal?: AbortSignal;
}): Promise<TOutput> {
  await writeFile(
    options.files.promptFile,
    buildProviderWorkingPrompt({
      prompt: options.renderedPrompt,
      outputSchema: options.step.output.jsonSchema,
      captureMode: options.step.output.captureMode,
    }),
    "utf8",
  );

  const thinking = resolveWorkingThinking(options.target, options.role);
  try {
    await options.provider.runWorking(
      {
        promptFile: options.files.promptFile,
        outputFile: options.files.outputFile,
        usageFile: options.files.usageFile,
        cwd: options.cwd,
        ...(options.target.model === undefined ? {} : { model: options.target.model }),
        ...(thinking === undefined ? {} : { thinking }),
        captureMode: options.step.output.captureMode,
        signal: options.signal,
      },
      options.providerWorkingRunner,
    );
  } catch (error) {
    const repaired = await attemptProviderOutputRepair({
      provider: options.provider,
      error,
      model: options.target.model,
      thinking,
      outputSchema: options.step.output.jsonSchema,
      captureMode: options.step.output.captureMode,
      files: options.files,
      cwd: options.cwd,
      providerWorkingRunner: options.providerWorkingRunner,
      signal: options.signal,
    });

    if (!repaired) {
      throw error;
    }
  }

  return readWorkingAgentOutput({
    stepId: options.step.id,
    outputFile: options.files.outputFile,
    step: options.step,
  });
}

function resolveWorkingThinking(
  target: StepKitAgentTarget,
  role: WorkflowAgentRole,
): WorkflowAgentRole["thinking"] {
  return target.thinking ?? role.thinking;
}
