import { mkdir, writeFile } from "node:fs/promises";

import { resolveAgentTargets } from "../../agent-targeting/resolve-agent-targets/resolve-agent-targets.js";
import type { StepKitConfig } from "../../agent-targeting/targeting.types.js";
import type { AgentStepRequestConfig } from "../../authoring/step/agent-step.types.js";
import type { WorkflowAgentRole } from "../../contracts/agents/agent-role.types.js";
import { StepKitFailureError } from "../../contracts/failures/failure.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import type { ProviderWorkingRunner } from "../../known-cli-providers/registry/provider-registry.types.js";
import type { WorkingAgentProcessRunner } from "../../runtime/run-workflow/run-workflow.types.js";
import {
  resolveStepAgentFiles,
  type WorkingAgentFiles,
} from "./artifacts/resolve-step-agent-files.js";
import { buildWorkingAgentPrompt } from "./prompts/build-working-agent-prompt.js";
import { runWorkingAgentTargetAttempt } from "./targets/run-working-agent-target-attempt.js";
import {
  summarizeWorkingAgentAttemptFailure,
  type WorkingAgentAttemptFailure,
} from "./targets/target-failures.js";

export type { WorkingAgentFiles } from "./artifacts/resolve-step-agent-files.js";

export async function runWorkingAgentCommand<TOutput extends PlainObject>(options: {
  readonly config: StepKitConfig;
  readonly workflowId: string;
  readonly roleName: string;
  readonly role: WorkflowAgentRole;
  readonly step: AgentStepRequestConfig<PlainObject, TOutput>;
  readonly renderedPrompt: string;
  readonly runDir: string;
  readonly cwd: string;
  readonly runner?: WorkingAgentProcessRunner;
  readonly providerWorkingRunner?: ProviderWorkingRunner;
  readonly stepIndex: number;
  readonly files?: WorkingAgentFiles;
  readonly signal?: AbortSignal;
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

  for (const target of targets) {
    try {
      return await runWorkingAgentTargetAttempt({ ...options, target, files });
    } catch (error) {
      failures.push(summarizeWorkingAgentAttemptFailure(target, error));
    }
  }

  throw new StepKitFailureError({
    code: "agent_target_exhausted",
    message: `Working agent step ${options.step.id} for role ${options.roleName} exhausted ${failures.length} target(s).`,
    details: {
      stepId: options.step.id,
      roleName: options.roleName,
      attempts: failures,
    },
  });
}
