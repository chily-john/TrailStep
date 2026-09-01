import { rm } from "node:fs/promises";

import type {
  TrailStepAgentTarget,
  TrailStepConfig,
} from "../../../agent-targeting/targeting.types.js";
import type { AgentStepRequestConfig } from "../../../authoring/step/agent-step.types.js";
import type { ProviderWorkingRunner } from "../../../cli-provider-runtime/catalog/provider-adapter.types.js";
import type { WorkflowAgentRole } from "../../../contracts/agents/agent-role.types.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import type { WorkingAgentProcessRunner } from "../../../runtime/run-workflow/run-workflow.types.js";
import type { WorkingAgentFiles } from "../artifacts/resolve-step-agent-files.js";
import { runCustomWorkingProvider } from "./custom-provider/run-custom-working-provider.js";
import { runManifestWorkingProvider } from "./manifest-provider/run-manifest-working-provider.js";

export async function runWorkingAgentTargetAttempt<TOutput extends PlainObject>(options: {
  readonly config: TrailStepConfig;
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
  readonly target: TrailStepAgentTarget;
  readonly files: WorkingAgentFiles;
  readonly signal?: AbortSignal;
}): Promise<TOutput> {
  await rm(options.files.outputFile, { force: true });
  await rm(options.files.usageFile, { force: true });

  if (options.config.providers?.[options.target.provider] !== undefined) {
    return runManifestWorkingProvider({
      config: options.config,
      step: options.step,
      role: options.role,
      cwd: options.cwd,
      runner: options.runner,
      target: options.target,
      files: options.files,
      signal: options.signal,
    });
  }

  return runCustomWorkingProvider({
    config: options.config,
    step: options.step,
    role: options.role,
    cwd: options.cwd,
    runner: options.runner,
    target: options.target,
    files: options.files,
    signal: options.signal,
  });
}
